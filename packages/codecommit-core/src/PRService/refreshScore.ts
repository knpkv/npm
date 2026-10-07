/**
 * @internal
 * Phase 5: Calculate and store health scores.
 */

import { Cause, Clock, DateTime, Effect, Option, SubscriptionRef } from "effect"
import { type CachedPullRequest, PullRequestRepo, versionsOf } from "../CacheService/repos/PullRequestRepo/index.js"
import { calculateHealthScore } from "../HealthScore.js"
import { decodeCachedPR, type PRState } from "./internal.js"

export const calculateHealthScores = (
  state: PRState
): Effect.Effect<void, never, PullRequestRepo> => (Effect.gen(function*() {
  const prRepo = yield* PullRequestRepo

  yield* SubscriptionRef.update(state, (s) => ({
    ...s,
    statusDetail: "calculating health scores"
  }))

  const scoredPRs = yield* prRepo.findAll().pipe(Effect.catch(() => Effect.succeed<Array<CachedPullRequest>>([])))
  const scoreNowMs = yield* Clock.currentTimeMillis
  const scoreNow = DateTime.toDate(DateTime.makeUnsafe(scoreNowMs))
  yield* Effect.forEach(
    scoredPRs,
    (row) => {
      const pr = decodeCachedPR(row)
      // Unknown is stored as null, not 0: a red 0 would claim a bad score for a PR that can't be scored.
      const score = Option.getOrNull(Option.map(calculateHealthScore(pr, scoreNow), (scored) => scored.total))
      // Computed from both groups, so written only to the row as it was read: any write since (the
      // approval included) makes the score stale.
      return prRepo.writeDerived(row.awsAccountId, row.id, versionsOf(row), { healthScore: score }, {
        repositoryName: row.repositoryName,
        accountRegion: row.accountRegion
      }).pipe(
        Effect.catch(() => Effect.void)
      )
    },
    { discard: true }
  )
}).pipe(
  Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("calculateHealthScores failed", cause))
))
