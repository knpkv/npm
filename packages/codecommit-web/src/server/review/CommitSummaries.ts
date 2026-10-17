/**
 * Commit titles and times for the owner UI, which names commits instead of showing their ids.
 *
 *   const read = yield* makeCommitSummaryReader(readClient.getCommit)
 *   const summary = yield* read({ account, repositoryName, commit })
 *
 * Commits never change, so a summary is kept for good. Failures are not kept: a commit that could
 * not be read is asked for again next time.
 *
 * @module
 */
import type * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import { Cache, Data, DateTime, Duration, Effect, Exit } from "effect"
import type { CodeCommitSummary } from "../../host-contract.js"

/** The commit to name and where it lives. */
export interface CommitTarget {
  readonly account: ReadClient.CodeCommitReadAccount
  readonly repositoryName: string
  readonly commit: string
}

class CommitKey extends Data.Class<{
  readonly profile: ReadClient.CodeCommitReadAccount["profile"]
  readonly region: ReadClient.CodeCommitReadAccount["region"]
  readonly repositoryName: string
  readonly commit: string
}> {}

/** The wire shape: commit time in epoch milliseconds. */
export const commitSummaryWire = (summary: ReadClient.CodeCommitCommitSummary): CodeCommitSummary => ({
  commitId: summary.commitId,
  title: summary.title,
  committedAt: DateTime.toEpochMillis(summary.committedAt)
})

export const makeCommitSummaryReader = Effect.fn("CommitSummaries.make")(function*(
  getCommit: ReadClient.CodeCommitReadClientService["getCommit"]
) {
  const cache = yield* Cache.makeWith(
    (key: CommitKey) =>
      getCommit({
        account: { profile: key.profile, region: key.region },
        repositoryName: key.repositoryName,
        commitId: key.commit
      }).pipe(Effect.map(commitSummaryWire)),
    { capacity: 1024, timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero }
  )
  return (target: CommitTarget) =>
    Cache.get(
      cache,
      new CommitKey({
        profile: target.account.profile,
        region: target.account.region,
        repositoryName: target.repositoryName,
        commit: target.commit
      })
    )
})
