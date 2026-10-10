import { Effect } from "effect"
import {
  type S3Bucket,
  type S3BucketPage,
  S3Reader,
  S3ReadError,
  type S3Version,
  type S3VersionPage,
  type VersionCursor
} from "./s3-reader.js"
import { type StackState, StateReadError } from "./schema.js"

/** Server-private persisted bucket/prefix coordinates. Keep in server memory, never HTTP, browser storage, logs or telemetry. */
export interface S3StackLocator {
  readonly bucket: S3Bucket
  readonly prefix: string
  readonly app: string
  readonly stage: string
}

/** Discover owned candidate buckets; caller may supply a different naming predicate or explicit bucket locators. */
export const discoverS3Buckets = Effect.fn("AlchemyConsole.discoverS3Buckets")(function*(
  matches: (name: string) => boolean = (name) => name.includes("alchemy-state")
) {
  const reader = yield* S3Reader
  const buckets = new Map<string, S3Bucket>()
  const seen = new Set<string>()
  let cursor: string | null = null
  let count = 0
  let pages = 0
  do {
    if (++pages > 100) return yield* new S3ReadError({ reason: "limit" })
    const page: S3BucketPage = yield* reader.buckets(cursor)
    count += page.buckets.length
    if (count > 50_000) return yield* new S3ReadError({ reason: "limit" })
    for (const bucket of page.buckets) if (matches(bucket.name)) buckets.set(bucket.name, bucket)
    cursor = page.next
    if (cursor !== null) {
      if (seen.has(cursor)) return yield* new S3ReadError({ reason: "invalid-response" })
      seen.add(cursor)
    }
  } while (cursor !== null)
  return [...buckets.values()].sort((a, b) => a.name.localeCompare(b.name))
})

/** List version IDs and deletion markers without reading any payload. Both continuation markers are retained. */
export const listS3Versions = Effect.fn("AlchemyConsole.listS3Versions")(function*(bucket: S3Bucket, prefix = "") {
  const reader = yield* S3Reader
  const versions: Array<S3Version> = []
  const seen = new Set<string>()
  let cursor: VersionCursor | null = null
  let pages = 0
  do {
    if (++pages > 100) return yield* new S3ReadError({ reason: "limit" })
    const page: S3VersionPage = yield* reader.versions(bucket, prefix, cursor)
    if (versions.length + page.versions.length > 50_000) return yield* new S3ReadError({ reason: "limit" })
    for (const version of page.versions) versions.push(version)
    if (page.versions.some((version) => !version.key.startsWith(prefix))) {
      return yield* new S3ReadError({ reason: "invalid-response" })
    }
    cursor = page.next
    if (cursor !== null) {
      const identity = JSON.stringify([cursor.key, cursor.versionId])
      if (seen.has(identity)) return yield* new S3ReadError({ reason: "invalid-response" })
      seen.add(identity)
    }
  } while (cursor !== null)
  return versions
})

const latestVersions = Effect.fn("AlchemyConsole.latestS3Versions")(function*(versions: ReadonlyArray<S3Version>) {
  const latest = new Map<string, S3Version>()
  for (const version of versions) {
    if (!version.latest) continue
    if (latest.has(version.key)) return yield* new S3ReadError({ reason: "invalid-response" })
    latest.set(version.key, version)
  }
  return [...latest.values()].filter((version) => !version.deleted)
})

/** Infer optional state prefixes from the last three key components. Latest delete markers never resurrect old stacks. */
export const discoverS3Stacks = Effect.fn("AlchemyConsole.discoverS3Stacks")(function*(bucket: S3Bucket) {
  const versions = yield* latestVersions(yield* listS3Versions(bucket))
  const stacks = new Map<string, S3StackLocator>()
  for (const { key } of versions) {
    const parts = key.split("/")
    const name = parts.at(-1)
    const stage = parts.at(-2)
    const app = parts.at(-3)
    if (
      name?.endsWith(".json") !== true || app === undefined || app.length === 0 || stage === undefined ||
      stage.length === 0 || parts.some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      continue
    }
    const prefix = parts.length === 3 ? "" : `${parts.slice(0, -3).join("/")}/`
    stacks.set(JSON.stringify([prefix, app, stage]), { bucket, prefix, app, stage })
  }
  return [...stacks.values()].sort((a, b) =>
    a.prefix.localeCompare(b.prefix) || a.app.localeCompare(b.app) || a.stage.localeCompare(b.stage)
  )
})

const stagePrefix = (stack: S3StackLocator) => `${stack.prefix}${stack.app}/${stack.stage}/`

/** Read one exact persisted version. Keys must be direct JSON children of the server-selected stack. */
export const readS3Resource = Effect.fn("AlchemyConsole.readS3Resource")(function*(
  stack: S3StackLocator,
  key: string,
  versionId: string
) {
  const prefix = stagePrefix(stack)
  const name = key.slice(prefix.length)
  if (
    !key.startsWith(prefix) || name.includes("/") || !name.endsWith(".json") || name === "__stack_output__.json" ||
    versionId.length === 0
  ) {
    return yield* new StateReadError({ reason: "invalid-state" })
  }
  const reader = yield* S3Reader
  const resource = yield* reader.resource(stack.bucket, key, versionId)
  if (resource !== null && name !== `${resource.fqn.replaceAll("/", "__")}.json`) {
    return yield* new StateReadError({ reason: "invalid-state" })
  }
  return resource
})

/** Pin each latest object to its listed version ID. S3 is not a transactional snapshot across resources. */
export const readS3State = Effect.fn("AlchemyConsole.readS3State")(function*(
  stack: S3StackLocator,
  alchemyVersion: string | null = null
) {
  if (alchemyVersion !== null && alchemyVersion !== "2.0.0-beta.74" && alchemyVersion !== "2.0.0-beta.77") {
    return yield* new StateReadError({ reason: "unsupported-version" })
  }
  const prefix = stagePrefix(stack)
  const versions = yield* latestVersions(yield* listS3Versions(stack.bucket, prefix))
  const resources = []
  for (const version of versions) {
    if (!version.key.endsWith(".json") || version.key === `${prefix}__stack_output__.json`) continue
    const resource = yield* readS3Resource(stack, version.key, version.versionId)
    if (resource !== null) resources.push(resource)
  }
  const state: StackState = {
    app: stack.app,
    stage: stack.stage,
    backend: "s3",
    alchemyVersion,
    lastDeploy: null,
    resources: resources.sort((a, b) => a.fqn.localeCompare(b.fqn))
  }
  return state
})
