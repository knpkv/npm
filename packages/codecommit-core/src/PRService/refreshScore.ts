/**
 * @internal
 * Phase 5: Calculate and store health scores.
 */

import { Effect, SubscriptionRef } from "effect"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo.js"
import { scoreTotalOr } from "../HealthScore.js"
import { decodeCachedPR, type PRState } from "./internal.js"

export const calculateHealthScores = (
  state: PRState
): Effect.Effect<void, never, PullRequestRepo> =>
  Effect.gen(function*() {
    const prRepo = yield* PullRequestRepo

    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      statusDetail: "calculating health scores"
    }))

    const scoredPRs = yield* prRepo.findAll().pipe(Effect.catchAll(() => Effect.succeed([])))
    const scoreNow = new Date()
    yield* Effect.forEach(
      scoredPRs,
      (row) => {
        const pr = decodeCachedPR(row)
        const score = scoreTotalOr(pr, scoreNow, 0)
        return prRepo.updateHealthScore(row.awsAccountId, row.id, score).pipe(
          Effect.catchAll(() => Effect.void)
        )
      },
      { discard: true }
    )
  })
