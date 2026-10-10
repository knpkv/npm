import type { Effect } from "effect"
import { Context, Schema } from "effect"
import type { ResourceSummary, StateReadError } from "./schema.js"

/** Server-private bucket name and routing region; memory only, never HTTP, browser storage, logs or telemetry. */
export interface S3Bucket {
  readonly name: string
  readonly region: string
}

/** Server-private S3 pagination coordinates with the same boundary as bucket/key/version locators. */
export interface VersionCursor {
  readonly key: string
  readonly versionId: string | null
}

/** Server-private persisted S3 key/version coordinates. Only normalized resource metadata may leave the server. */
export interface S3Version {
  readonly key: string
  readonly versionId: string
  readonly latest: boolean
  readonly deleted: boolean
}

/** Server-private bucket listing and opaque continuation token. */
export interface S3BucketPage {
  readonly buckets: ReadonlyArray<S3Bucket>
  readonly next: string | null
}

/** Server-private version listing and continuation coordinates. */
export interface S3VersionPage {
  readonly versions: ReadonlyArray<S3Version>
  readonly next: VersionCursor | null
}

/** No raw provider error, credentials or locator is retained. */
export class S3ReadError extends Schema.TaggedError<S3ReadError>()("S3ReadError", {
  reason: Schema.Literals(["authentication", "denied", "not-found", "provider", "invalid-response", "limit"])
}) {}

/** Bound to one explicit SSO profile. No writes, Alchemy runtime, credential chain or implicit login. */
export class S3Reader extends Context.Service<S3Reader, {
  readonly buckets: (cursor: string | null) => Effect.Effect<S3BucketPage, S3ReadError>
  readonly versions: (
    bucket: S3Bucket,
    prefix: string,
    cursor: VersionCursor | null
  ) => Effect.Effect<S3VersionPage, S3ReadError>
  readonly resource: (bucket: S3Bucket, key: string, versionId: string) => Effect.Effect<
    ResourceSummary | null,
    S3ReadError | StateReadError
  >
}>()("@knpkv/alchemy-console/S3Reader") {}
