/** Owner-private completed review writer. The host imports the separate reader only. @module */
import type { ReviewRun } from "@knpkv/review"
import { Crypto, Effect, FileSystem, Schema, Semaphore } from "effect"
import {
  makeReviewRunReader,
  maximumReviewRunBytes,
  type ReviewRunReader,
  ReviewRunRecord,
  ReviewRunStoreError
} from "./ReviewRunReader.js"

export { ReviewRunStoreError } from "./ReviewRunReader.js"

export type ReviewRunSaved = { readonly _tag: "Saved" | "NewerRetained"; readonly run: ReviewRun }
export interface ReviewRunStore extends ReviewRunReader {
  readonly save: (run: ReviewRun) => Effect.Effect<ReviewRunSaved, ReviewRunStoreError>
}

/** One owner serializes atomic replacements. A late completed run cannot erase newer output. */
export const makeReviewRunStore = Effect.fn("ReviewRunStore.owner")(function*(directory: string) {
  const reader = yield* makeReviewRunReader(directory)
  const fs = yield* FileSystem.FileSystem
  const cryptoService = yield* Crypto.Crypto
  const lock = yield* Semaphore.make(1)
  const save = Effect.fn("ReviewRunStore.save")(
    function*(run: ReviewRun) {
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(ReviewRunRecord))({ version: 1, run })
        .pipe(Effect.mapError(() => new ReviewRunStoreError({ operation: "save", reason: "invalid" })))
      if (new TextEncoder().encode(text).byteLength > maximumReviewRunBytes) {
        return yield* new ReviewRunStoreError({ operation: "save", reason: "oversized" })
      }
      const previous = yield* reader.read(run.identity).pipe(
        Effect.catchTag(
          "ReviewRunStoreError",
          (failure) =>
            failure.reason === "invalid" || failure.reason === "oversized" ? Effect.succeed(null) : Effect.fail(failure)
        )
      )
      if (previous !== null && previous.completedAt > run.completedAt) {
        return { _tag: "NewerRetained", run: previous } satisfies ReviewRunSaved
      }
      const destination = yield* reader.filename(run.identity)
      const nonce = yield* cryptoService.randomUUIDv4
      const temporary = `${destination}.${nonce}.tmp`
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
      yield* reader.verifyDirectory()
      yield* Effect.acquireUseRelease(
        fs.writeFileString(temporary, text, { flag: "wx", mode: 0o600 }),
        () => fs.rename(temporary, destination),
        () =>
          fs.remove(temporary, { force: true }).pipe(
            Effect.catchTag("PlatformError", (failure) =>
              Effect.logWarning("Completed review temporary-file cleanup failed", failure))
          )
      )
      return { _tag: "Saved", run } satisfies ReviewRunSaved
    },
    lock.withPermits(1),
    Effect.mapError((failure) =>
      failure._tag === "ReviewRunStoreError"
        ? failure :
        new ReviewRunStoreError({ operation: "save", reason: "io" })
    )
  )
  return { read: reader.read, save } satisfies ReviewRunStore
})
