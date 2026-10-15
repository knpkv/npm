/** Persist only results from the already authorized owner review endpoints. @module */
import type { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Clock, Config, Crypto, Effect, Path, Stream } from "effect"
import type { PullRequestRelayReviewResponse, RelayReviewStreamEvent } from "../Api.js"
import { reviewRunOfResponse, reviewRunSubject } from "./review-run-projection.js"
import { makeReviewRunStore, type ReviewRunSaved, ReviewRunStoreError } from "./ReviewRunStore.js"

type SaveReview = (
  pullRequest: PullRequest,
  response: PullRequestRelayReviewResponse
) => Effect.Effect<ReviewRunSaved, ReviewRunStoreError>

/** History is secondary. A failed save keeps the completed result with a safe, typed warning. */
export const recordCompletedReview = (save: SaveReview) =>
  Effect.fn("ReviewRunRecorder.retainCompleted")(
    function*(pullRequest: PullRequest, response: PullRequestRelayReviewResponse) {
      return yield* save(pullRequest, response).pipe(
        Effect.as(response),
        Effect.tapError((failure) => Effect.logWarning("Completed review history was not saved", failure)),
        Effect.catchTag("ReviewRunStoreError", (failure) =>
          Effect.succeed(
            {
              ...response,
              historyWarning: { reason: failure.reason }
            } satisfies PullRequestRelayReviewResponse
          ))
      )
    }
  )

/** Put the warning on the complete frame itself; a terminal result must never become an error frame. */
export const recordCompletedReviewStream = <E, R>(
  stream: Stream.Stream<RelayReviewStreamEvent, E, R>,
  record: (response: PullRequestRelayReviewResponse) => Effect.Effect<PullRequestRelayReviewResponse>
) =>
  stream.pipe(Stream.mapEffect((event) =>
    event.type === "complete"
      ? record(event.review).pipe(Effect.map((review): RelayReviewStreamEvent => ({ ...event, review })))
      : Effect.succeed(event)
  ))

export const makeReviewRunRecorder = Effect.fn("ReviewRunRecorder.make")(function*() {
  const home = yield* Config.String("HOME").pipe(Config.orElse(() => Config.String("USERPROFILE")))
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const store = yield* makeReviewRunStore(path.join(home, ".codecommit", "reviews"))
  return Effect.fn("ReviewRunRecorder.complete")(
    function*(pullRequest: PullRequest, response: PullRequestRelayReviewResponse) {
      const id = yield* cryptoService.randomUUIDv4.pipe(
        Effect.mapError(() => new ReviewRunStoreError({ operation: "save", reason: "io" }))
      )
      const completedAt = yield* Clock.currentTimeMillis
      const subject = yield* reviewRunSubject(pullRequest)
        .pipe(Effect.mapError(() => new ReviewRunStoreError({ operation: "save", reason: "invalid" })))
      const run = yield* reviewRunOfResponse(subject, response, id, completedAt)
        .pipe(Effect.mapError(() => new ReviewRunStoreError({ operation: "save", reason: "invalid" })))
      return yield* store.save(run)
    }
  )
})
