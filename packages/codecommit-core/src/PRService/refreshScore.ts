/**
 * @internal
 * Phase 5: Calculate and store health scores.
 */

import { Clock, DateTime, Effect, SubscriptionRef } from "effect"
import { type CachedPullRequest, PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import { scoreTotalOr } from "../HealthScore.js"
import { decodeCachedPR, type PRState } from "./internal.js"

export const calculateHealthScores = (
  state: PRState
): Effect.Effect<void, unknown, unknown> => (Effect.gen(function*() {
  const prRepo = yield* PullRequestRepo

  yield* SubscriptionRef.update(state, (s) => ({
    ...s,
    statusDetail: "calculating health scores"
  }))

  const scoredPRs = yield* prRepo.findAll().pipe(Effect.catchCause(() => Effect.succeed<Array<CachedPullRequest>>([])))
  const scoreNowMs = yield* Clock.currentTimeMillis
  const scoreNow = DateTime.toDate(DateTime.makeUnsafe(scoreNowMs))
  yield* Effect.forEach(
    scoredPRs,
    (row) => {
      const pr = decodeCachedPR(row)
      const score = scoreTotalOr(pr, scoreNow, 0)
      return prRepo.updateHealthScore(row.awsAccountId, row.id, score).pipe(
        Effect.catchCause(() => Effect.void)
      )
    },
    { discard: true }
  )
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("calculateHealthScores failed", cause))
))
