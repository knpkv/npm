/**
 * @internal
 * Phase 5: Calculate and store health scores.
 */

import { Cause, Clock, DateTime, Effect, SubscriptionRef } from "effect"
import { type CachedPullRequest, PullRequestRepo, versionsOf } from "../CacheService/repos/PullRequestRepo/index.js"
import { scoreTotalOr } from "../HealthScore.js"
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
      const score = scoreTotalOr(pr, scoreNow, 0)
      // Computed from both groups, so written only to the row as it was read: any write since (the
      // approval included) makes the score stale.
      return prRepo.writeDerived(row.awsAccountId, row.id, versionsOf(row), { healthScore: score }, {
        repositoryName: row.repositoryName,
        accountRegion: row.accountRegion
      }).pipe(
        // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
        Effect.catch(() => Effect.void)
      )
    },
    { discard: true }
  )
}).pipe(
  Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("calculateHealthScores failed", cause))
))
