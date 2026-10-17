/**
 * A commit's title and time on the wire, for review pages that name commits instead of showing their ids.
 *
 *   const summary = yield* readClient.getCommit({ account, repositoryName, commitId })
 *   return commitSummaryWire(summary)
 *
 * Reads are not cached on the server: each one passes the caller's grants and audit, and pages read
 * each commit once.
 *
 * @module
 */
import type * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import { DateTime } from "effect"
import type { CodeCommitSummary } from "../../host-contract.js"

/** The wire shape: commit time in epoch milliseconds. */
export const commitSummaryWire = (summary: ReadClient.CodeCommitCommitSummary): CodeCommitSummary => ({
  commitId: summary.commitId,
  title: summary.title,
  committedAt: DateTime.toEpochMillis(summary.committedAt)
})
