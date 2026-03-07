/**
 * @module refreshDiffs
 *
 * Mental model: Enrichment phase in the sync pipeline. Scans cached PRs for
 * missing diff stats and backfills them via `getDifferences`. Uses bounded
 * concurrency (2) to avoid AWS throttling. Progress reported via
 * SubscriptionRef state updates.
 *
 * @internal
 */

import { Effect, Ref, SubscriptionRef } from "effect"
import { AwsClient } from "../AwsClient/index.js"
import type { CachedPullRequest } from "../CacheService/repos/PullRequestRepo/index.js"
import { PullRequestRepo } from "../CacheService/repos/PullRequestRepo/index.js"
import type { AwsProfileName, AwsRegion } from "../Domain.js"
import type { PRState } from "./internal.js"

const enrichSingleDiff = Effect.fn("enrichSingleDiff")(
  function*(row: CachedPullRequest) {
    const awsClient = yield* AwsClient

    // Use branch names as commit specifiers — works for open PRs and
    // closed PRs whose branches still exist. Failures are caught below.
    const stats = yield* awsClient.getDifferences({
      account: {
        profile: row.accountProfile as AwsProfileName,
        region: row.accountRegion as AwsRegion
      },
      repositoryName: row.repositoryName,
      beforeCommitSpecifier: row.destinationBranch,
      afterCommitSpecifier: row.sourceBranch
    })

    return { awsAccountId: row.awsAccountId, id: row.id, ...stats }
  },
  Effect.catchAll((e) => Effect.logDebug("enrichSingleDiff failed", e).pipe(Effect.as(undefined)))
)

export const enrichDiffs = Effect.fn("enrichDiffs")(
  function*(state: PRState) {
    const prRepo = yield* PullRequestRepo

    const needsEnrichment = yield* prRepo.findMissingDiffStats().pipe(Effect.catchAll(() => Effect.succeed([])))

    if (needsEnrichment.length === 0) return

    const enrichedRef = yield* Ref.make(0)

    yield* SubscriptionRef.update(state, (s) => ({
      ...s,
      statusDetail: `fetching diffs (0/${needsEnrichment.length})`
    }))

    const results = yield* Effect.forEach(
      needsEnrichment,
      (row) =>
        Effect.gen(function*() {
          const result = yield* enrichSingleDiff(row)
          const n = yield* Ref.updateAndGet(enrichedRef, (v) => v + 1)
          yield* SubscriptionRef.update(state, (s) => ({
            ...s,
            statusDetail: `fetching diffs (${n}/${needsEnrichment.length})`
          }))
          return result
        }),
      { concurrency: 2 }
    )

    yield* Effect.forEach(
      results,
      (r) => {
        if (!r) return Effect.void
        return prRepo.updateDiffStats(r.awsAccountId, r.id, r.filesAdded, r.filesModified, r.filesDeleted).pipe(
          Effect.catchAll(() => Effect.void)
        )
      },
      { discard: true }
    )
  }
)
