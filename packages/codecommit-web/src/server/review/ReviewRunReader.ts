/** Owner-private completed review records. The hub receives only the read method. @module */
import { ReviewHistoryFailureReason, ReviewRun, type ReviewThreadIdentity } from "@knpkv/review"
import { Crypto, Effect, FileSystem, Option, Path, Schema } from "effect"
import { Hex } from "effect/encoding"

export class ReviewRunStoreError extends Schema.TaggedError<ReviewRunStoreError>()("ReviewRunStoreError", {
  operation: Schema.Literals(["read", "save"]),
  reason: ReviewHistoryFailureReason
}) {}

export const ReviewRunRecord = Schema.Struct({ version: Schema.Literal(1), run: ReviewRun })
export const maximumReviewRunBytes = 1_048_576
export interface ReviewRunReader {
  readonly read: (identity: ReviewThreadIdentity) => Effect.Effect<ReviewRun | null, ReviewRunStoreError>
}
/** Key only the PR, so its last completed review survives head movement. Hash private locators. */
const storeKey = (identity: ReviewThreadIdentity) => JSON.stringify([identity.namespace, identity.subjectId])

/** No mkdir, file creation, migration or fallback to an empty record on a failed read. */
export const makeReviewRunReader = Effect.fn("ReviewRunStore.reader")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  /** Refuse symlinked ancestors and permissive directories; never repair permissions on a read. */
  const verifyDirectory = Effect.fn("ReviewRunStore.verifyDirectory")(
    function*() {
      const real = yield* fs.realPath(directory).pipe(
        Effect.catchTag(
          "PlatformError",
          (failure) => failure.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(failure)
        )
      )
      if (real === null) {
        return false
      }
      const info = yield* fs.stat(directory)
      if (real !== path.resolve(directory) || info.type !== "Directory" || (info.mode & 0o777) !== 0o700) {
        return yield* new ReviewRunStoreError({ operation: "read", reason: "private_path" })
      }
      return true
    },
    Effect.mapError((failure) =>
      failure._tag === "ReviewRunStoreError"
        ? failure :
        new ReviewRunStoreError({ operation: "read", reason: "io" })
    )
  )
  const filename = (identity: ReviewThreadIdentity) =>
    cryptoService.digest(
      "SHA-256",
      new TextEncoder().encode(storeKey(identity))
    ).pipe(Effect.map((digest) => path.join(directory, `${Hex.encode(digest)}.json`)))
  const read = Effect.fn("ReviewRunStore.read")(
    function*(identity: ReviewThreadIdentity) {
      if (!(yield* verifyDirectory())) return null
      const file = yield* filename(identity)
      const text = yield* Effect.gen(function*() {
        const real = yield* fs.realPath(file)
        const info = yield* fs.stat(file)
        const parent = yield* fs.stat(directory)
        if (
          real !== path.resolve(file) || info.type !== "File" || (info.mode & 0o777) !== 0o600 ||
          Option.isNone(info.uid) || Option.isNone(parent.uid) || info.uid.value !== parent.uid.value
        ) {
          return yield* new ReviewRunStoreError({ operation: "read", reason: "private_path" })
        }
        if (info.size > BigInt(maximumReviewRunBytes)) {
          return yield* new ReviewRunStoreError({ operation: "read", reason: "oversized" })
        }
        return yield* fs.readFileString(file)
      }).pipe(Effect.catchTag("PlatformError", (failure) =>
        failure.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(new ReviewRunStoreError({ operation: "read", reason: "io" }))))
      if (text === null) return null
      if (new TextEncoder().encode(text).byteLength > maximumReviewRunBytes) {
        return yield* new ReviewRunStoreError({ operation: "read", reason: "oversized" })
      }
      const record = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewRunRecord), {
        onExcessProperty: "error"
      })(text)
        .pipe(Effect.mapError(() => new ReviewRunStoreError({ operation: "read", reason: "invalid" })))
      if (storeKey(record.run.identity) !== storeKey(identity)) {
        return yield* new ReviewRunStoreError({ operation: "read", reason: "invalid" })
      }
      return record.run
    },
    Effect.mapError((failure) =>
      failure._tag === "ReviewRunStoreError"
        ? failure :
        new ReviewRunStoreError({ operation: "read", reason: "io" })
    )
  )
  return { read, filename, verifyDirectory } satisfies ReviewRunReader & {
    readonly filename: typeof filename
    readonly verifyDirectory: typeof verifyDirectory
  }
})
