/** Pure thread join for a decoded workspace. Readings stay independent and no authority is added. @module */
import { Result, Schema } from "effect"
import { reviewSeverityOrder } from "./model.js"
import { type ReviewFinding, ReviewThread, type ReviewWorkspace } from "./workspace.js"

/** Conflicting snapshot identities must be shown as a conflict, never empty or unavailable history. */
export class ThreadsConflict extends Schema.TaggedError<ThreadsConflict>()("ThreadsConflict", {
  source: ReviewThread.fields.source,
  id: ReviewThread.fields.id
}) {}

/** Totals count all threads, without a resolved/disposition policy. AtLeast zero is unknown, not an exact zero. */
export type ReviewThreadTotal =
  | { readonly _tag: "Exact"; readonly n: number }
  | { readonly _tag: "AtLeast"; readonly n: number }

export interface ReviewFindingRow {
  readonly thread: ReviewThread
  readonly finding: ReviewFinding
}

export interface ReviewWorkspaceThreads {
  readonly total: ReviewThreadTotal
  /** P0/P1 findings in severity order; equal severity retains snapshot input order. */
  readonly primary: ReadonlyArray<ReviewFindingRow>
  /** P2-P4 findings in severity order, for the collapsed lower-priority group. */
  readonly secondary: ReadonlyArray<ReviewFindingRow>
  /** Non-finding threads stay separate, in run-then-conversations input order. */
  readonly conversations: ReadonlyArray<ReviewThread>
}

/**
 * Join readable snapshots without changing their identities, anchors or dispositions.
 * NotRecorded is known absence. Any unavailable snapshot makes the total a lower bound.
 * Duplicate source/id within or across snapshots refuses the join; the UI must handle ThreadsConflict.
 */
export const reviewWorkspaceThreads = (
  workspace: ReviewWorkspace
): Result.Result<ReviewWorkspaceThreads, ThreadsConflict> => {
  const threads = [
    ...(workspace.run._tag === "Ready" ? workspace.run.run.threads : []),
    ...(workspace.conversations._tag === "Ready" ? workspace.conversations.threads : [])
  ]
  const seen = new Set<string>()
  const findings: Array<ReviewFindingRow> = []
  const conversations: Array<ReviewThread> = []
  for (const thread of threads) {
    const key = JSON.stringify([thread.source, thread.id])
    if (seen.has(key)) return Result.fail(new ThreadsConflict({ source: thread.source, id: thread.id }))
    seen.add(key)
    if (thread.finding === null) conversations.push(thread)
    else findings.push({ thread, finding: thread.finding })
  }
  findings.sort((left, right) =>
    reviewSeverityOrder.indexOf(left.finding.severity) - reviewSeverityOrder.indexOf(right.finding.severity)
  )
  const primary: Array<ReviewFindingRow> = []
  const secondary: Array<ReviewFindingRow> = []
  for (const row of findings) {
    if (row.finding.severity === "P0" || row.finding.severity === "P1") primary.push(row)
    else secondary.push(row)
  }
  return Result.succeed({
    total: workspace.run._tag !== "Unavailable" && workspace.conversations._tag === "Ready"
      ? { _tag: "Exact", n: threads.length }
      : { _tag: "AtLeast", n: threads.length },
    primary,
    secondary,
    conversations
  })
}
