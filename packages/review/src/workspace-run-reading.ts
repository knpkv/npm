/** Derived read presentation only; never a persisted state or write permission. @module */
import { type ReviewThreadIdentity, sameReviewThread } from "./model.js"
import type { ReviewFindingRow } from "./workspace-threads.js"
import type { ReviewAnchor, ReviewRun, ReviewRunReading, ReviewWorkspace } from "./workspace.js"

export type ReviewRunWorkspaceReading =
  | Exclude<ReviewRunReading, { readonly _tag: "Ready" }>
  | { readonly _tag: "Current"; readonly run: ReviewRun }
  | { readonly _tag: "DifferentRevision"; readonly run: ReviewRun; readonly current: ReviewThreadIdentity }

export type CurrentReviewRunReading = Extract<ReviewRunWorkspaceReading, { readonly _tag: "Current" }>

export interface CurrentReviewLineFinding extends ReviewFindingRow {
  readonly anchor: Extract<ReviewAnchor, { readonly _tag: "Line" }>
}

/**
 * Consume a decoded workspace, which already proves the run belongs to this namespace/subject.
 * Current means exact namespace/subject/revision/base/head equality, including null base == null
 * base, relative to this read's identity. Reuse sameReviewThread; never match on head alone.
 * DifferentRevision is a comparison, not ancestry. Neither state grants patch/write authority.
 */
export const reviewRunReadingForWorkspace = (workspace: ReviewWorkspace): ReviewRunWorkspaceReading => {
  if (workspace.run._tag !== "Ready") return workspace.run
  const run = workspace.run.run
  return sameReviewThread(run.identity, workspace.identity)
    ? { _tag: "Current", run }
    : { _tag: "DifferentRevision", run, current: workspace.identity }
}

/**
 * Only a Current run can supply current-diff line candidates. Preserve original records and input order;
 * general/file/outdated anchors stay with the parent index and their separate read panels.
 * The renderer still checks the path/side/line exists in this immutable diff; unplaced rows stay
 * with the parent. A command owner independently rechecks head, permission and idempotency.
 */
export const currentReviewLineFindings = (
  reading: CurrentReviewRunReading
): ReadonlyArray<CurrentReviewLineFinding> => {
  const rows: Array<CurrentReviewLineFinding> = []
  for (const thread of reading.run.threads) {
    if (thread.finding !== null && thread.anchor._tag === "Line" && !thread.anchor.outdated) {
      rows.push({ thread, finding: thread.finding, anchor: thread.anchor })
    }
  }
  return rows
}
