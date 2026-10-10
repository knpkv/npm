import { expect, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { S3Reader, S3ReadError, type VersionCursor } from "../src/s3-reader.js"
import { discoverS3Buckets, discoverS3Stacks, listS3Versions, readS3Resource, readS3State } from "../src/s3-state.js"
import type { ResourceSummary } from "../src/schema.js"

const bucket = { name: "fixture-alchemy-state", region: "eu-west-1" }
const stack = { bucket, prefix: "fixture-prefix/", app: "fixture-app", stage: "prod" }
const key = "fixture-prefix/fixture-app/prod/Storage__Assets.json"
const resource: ResourceSummary = {
  fqn: "Storage/Assets",
  logicalId: "Assets",
  resourceType: "AWS.S3.Bucket",
  status: "created",
  parent: "Storage",
  providerId: null,
  account: null,
  region: null,
  consoleUrl: null
}
const reads: Array<{ key: string; versionId: string }> = []
const cursors: Array<VersionCursor | null> = []
const fixture = Layer.succeed(S3Reader, {
  buckets: (cursor) =>
    Effect.succeed(
      cursor === null ?
        {
          buckets: [{ name: "fixture-unrelated", region: "us-east-1" }],
          next: "fixture-next"
        } :
        { buckets: [bucket], next: null }
    ),
  versions: (_bucket, prefix, cursor) =>
    Effect.sync(() => {
      cursors.push(cursor)
      const versions = cursor === null ?
        [
          { key, versionId: "fixture-new", latest: true, deleted: false },
          { key, versionId: "fixture-old", latest: false, deleted: false },
          { key: key.replace("Storage__Assets", "Deleted"), versionId: "fixture-delete", latest: true, deleted: true },
          {
            key: key.replace("Storage__Assets", "Deleted"),
            versionId: "fixture-previous",
            latest: false,
            deleted: false
          }
        ] :
        [
          {
            key: key.replace("Storage__Assets", "__stack_output__"),
            versionId: "fixture-output",
            latest: true,
            deleted: false
          },
          { key: "fixture-app/removed/Gone.json", versionId: "fixture-gone", latest: true, deleted: true },
          { key: "fixture-app/removed/Gone.json", versionId: "fixture-before", latest: false, deleted: false }
        ]
      return {
        versions: versions.filter((v) => v.key.startsWith(prefix)),
        next: cursor === null ? { key, versionId: "fixture-old" } : null
      }
    }),
  resource: (_bucket, key, versionId) =>
    Effect.sync(() => {
      reads.push({ key, versionId })
      return resource
    })
})

layer(fixture)("S3 state catalog", (it) => {
  it.effect("paginates owned bucket discovery and filters candidate names", () =>
    Effect.gen(function*() {
      expect(yield* discoverS3Buckets()).toEqual([bucket])
      expect(yield* discoverS3Buckets((name) => name.endsWith("unrelated"))).toHaveLength(1)
    }))

  it.effect("discovers custom prefixes, preserves both version markers and excludes deleted stacks", () =>
    Effect.gen(function*() {
      cursors.length = 0
      expect(yield* discoverS3Stacks(bucket)).toEqual([stack])
      expect(cursors).toEqual([null, { key, versionId: "fixture-old" }])
    }))

  it.effect("pins current reads, skips delete markers and stack outputs, and returns no bucket/key/version locators", () =>
    Effect.gen(function*() {
      reads.length = 0
      const state = yield* readS3State(stack)
      expect(state).toMatchObject({ backend: "s3", alchemyVersion: null, lastDeploy: null, resources: [resource] })
      expect(reads).toEqual([{ key, versionId: "fixture-new" }])
      for (const privateValue of [bucket.name, key, "fixture-new", stack.prefix]) {
        expect(JSON.stringify(state)).not.toContain(privateValue)
      }
    }))

  it.effect("historical reads use the exact requested version and reject keys outside the stack before fetching", () =>
    Effect.gen(function*() {
      reads.length = 0
      expect(yield* readS3Resource(stack, key, "fixture-old")).toEqual(resource)
      expect(reads).toEqual([{ key, versionId: "fixture-old" }])
      for (
        const invalid of [
          "foreign/prod/Assets.json",
          key.replace("prod/", "prod/nested/"),
          key.replace("Storage__Assets", "Wrong")
        ]
      ) {
        expect(yield* Effect.flip(readS3Resource(stack, invalid, "fixture-old"))).toMatchObject({
          reason: "invalid-state"
        })
      }
      expect(reads).toHaveLength(2)
      expect(yield* Effect.flip(readS3State(stack, "2.0.0-beta.999"))).toMatchObject({ reason: "unsupported-version" })
    }))
})

layer(Layer.succeed(S3Reader, {
  buckets: () => Effect.succeed({ buckets: [], next: "fixture-loop" }),
  versions: () => Effect.succeed({ versions: [], next: { key, versionId: "fixture-loop" } }),
  resource: () => Effect.fail(new S3ReadError({ reason: "denied" }))
}))("pagination failures", (it) => {
  it.effect("rejects repeated tokens instead of looping or returning partial results", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(discoverS3Buckets())).toMatchObject({ reason: "invalid-response" })
      expect(yield* Effect.flip(listS3Versions(bucket))).toMatchObject({ reason: "invalid-response" })
    }))
})

layer(Layer.succeed(S3Reader, {
  buckets: () => Effect.fail(new S3ReadError({ reason: "denied" })),
  versions: () => Effect.fail(new S3ReadError({ reason: "denied" })),
  resource: () => Effect.fail(new S3ReadError({ reason: "denied" }))
}))("authorization failures", (it) => {
  it.effect("reports denied catalogs explicitly rather than claiming an empty account", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(discoverS3Buckets())).toMatchObject({ reason: "denied" })
      expect(yield* Effect.flip(discoverS3Stacks(bucket))).toMatchObject({ reason: "denied" })
    }))
})

let boundedCalls = 0
layer(Layer.succeed(S3Reader, {
  buckets: () => Effect.succeed({ buckets: [], next: null }),
  versions: (requestedBucket, prefix) =>
    Effect.sync(() => {
      boundedCalls++
      const version = { key, versionId: "fixture-version", latest: true, deleted: false }
      if (requestedBucket.name === "fixture-large") {
        return { versions: Array.from({ length: 50_001 }, () => version), next: null }
      }
      if (requestedBucket.name === "fixture-pages") {
        return { versions: [], next: { key, versionId: `fixture-page-${boundedCalls}` } }
      }
      return {
        versions: prefix.length > 0 ? [version] : [version, { ...version, versionId: "fixture-conflict" }],
        next: null
      }
    }),
  resource: () => Effect.succeed(resource)
}))("catalog integrity and bounds", (it) => {
  it.effect("rejects conflicting latest versions and out-of-prefix provider rows", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(discoverS3Stacks(bucket))).toMatchObject({ reason: "invalid-response" })
      expect(yield* Effect.flip(listS3Versions(bucket, "foreign-prefix/"))).toMatchObject({
        reason: "invalid-response"
      })
    }))

  it.effect("caps entries and stops before issuing page 101", () =>
    Effect.gen(function*() {
      expect(yield* Effect.flip(listS3Versions({ ...bucket, name: "fixture-large" }))).toMatchObject({
        reason: "limit"
      })
      boundedCalls = 0
      expect(yield* Effect.flip(listS3Versions({ ...bucket, name: "fixture-pages" }))).toMatchObject({
        reason: "limit"
      })
      expect(boundedCalls).toBe(100)
    }))
})
