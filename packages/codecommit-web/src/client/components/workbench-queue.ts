/**
 * The review Workbench's queue: which open pull requests belong to the current user and why, in
 * three groups (needs your review, yours, watching), plus the one-line summary above them.
 *
 * Pure: callers pass the already account-filtered list (`queuePullRequests`) and `now`.
 *
 * Two clocks, never mixed: *open* runs from creation (CodeCommit exposes no revision timestamps
 * to the client yet), *quiet* runs from the last modification. An unknown caller identity is
 * reported as `Unknown`, never as an empty queue.
 */
import { identityMatches, needsMyReview } from "@knpkv/codecommit-core/Domain.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"

const DAY_MS = 86_400_000

/** A pull request counts as quiet after this long without any modification. */
export const QUIET_AFTER_MS = 7 * DAY_MS

export type WorkbenchGroup = "review" | "yours" | "watching"

/** Why one of your own pull requests is not merged yet; the worst reason only. */
export type StuckReason = "conflicts" | "quiet" | "approvals" | "ready"

/** Approvals on the least-satisfied unsatisfied rule (or the first rule when all are met). */
export interface RuleProgress {
  readonly name: string
  readonly approved: number
  readonly required: number
}

export interface WorkbenchRow {
  readonly pullRequest: Domain.PullRequest
  readonly group: WorkbenchGroup
  readonly openMs: number
  readonly quietMs: number
  readonly rule: RuleProgress | undefined
  readonly stuck: StuckReason | undefined
}

export type WorkbenchSummary =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Waiting"; readonly count: number; readonly oldest: WorkbenchRow }
  | { readonly _tag: "Clear"; readonly next: WorkbenchRow | undefined }

export interface WorkbenchQueue {
  readonly summary: WorkbenchSummary
  readonly rows: ReadonlyArray<WorkbenchRow>
}

const approvalsOn = (pullRequest: Domain.PullRequest, rule: Domain.ApprovalRule): number =>
  pullRequest.approvedBy.filter((approver) => rule.poolMembers.some((member) => identityMatches(approver, member)))
    .length

/** The rule furthest from being met, so "0/2 two maintainers" outranks "1/1 security". */
export const ruleProgress = (pullRequest: Domain.PullRequest): RuleProgress | undefined => {
  const progress = pullRequest.approvalRules.map((rule) => ({
    approved: Math.min(approvalsOn(pullRequest, rule), rule.requiredApprovals),
    name: rule.ruleName,
    required: rule.requiredApprovals,
    satisfied: rule.satisfied
  }))
  const unsatisfied = progress
    .filter((rule) => !rule.satisfied)
    .sort((a, b) => a.approved / Math.max(1, a.required) - b.approved / Math.max(1, b.required))
  const chosen = unsatisfied[0] ?? progress[0]
  return chosen === undefined ? undefined : { approved: chosen.approved, name: chosen.name, required: chosen.required }
}

const stuckReason = (pullRequest: Domain.PullRequest, quietMs: number): StuckReason => {
  if (!pullRequest.isMergeable) return "conflicts"
  if (quietMs > QUIET_AFTER_MS) return "quiet"
  return pullRequest.approvalRules.every((rule) => rule.satisfied) && pullRequest.isApproved ? "ready" : "approvals"
}

const groupOf = (pullRequest: Domain.PullRequest, currentUser: string): WorkbenchGroup | undefined => {
  if (identityMatches(currentUser, pullRequest.author)) return "yours"
  if (needsMyReview(pullRequest, currentUser)) return "review"
  if (pullRequest.commentedBy.some((name) => identityMatches(currentUser, name))) return "watching"
  return undefined
}

const groupOrder = { review: 0, yours: 1, watching: 2 } satisfies Readonly<Record<WorkbenchGroup, number>>

/**
 * Builds the queue for one user. Only open pull requests take part; within a group the longest
 * open comes first. With no identity, every open pull request is listed under "review" and the
 * summary is `Unknown`, because membership cannot be decided.
 */
export const workbenchQueue = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  currentUser: string | undefined,
  now: Date
): WorkbenchQueue => {
  const known = currentUser !== undefined && currentUser.length > 0
  const rows = pullRequests
    .filter((pullRequest) => pullRequest.status === "OPEN")
    .flatMap((pullRequest): ReadonlyArray<WorkbenchRow> => {
      const group = known ? groupOf(pullRequest, currentUser) : "review"
      if (group === undefined) return []
      const quietMs = Math.max(0, now.getTime() - pullRequest.lastModifiedDate.getTime())
      return [{
        group,
        openMs: Math.max(0, now.getTime() - pullRequest.creationDate.getTime()),
        pullRequest,
        quietMs,
        rule: ruleProgress(pullRequest),
        stuck: group === "yours" ? stuckReason(pullRequest, quietMs) : undefined
      }]
    })
    .sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || b.openMs - a.openMs)
  if (!known) return { rows, summary: { _tag: "Unknown" } }
  const waiting = rows.filter((row) => row.group === "review")
  const oldest = waiting[0]
  return {
    rows,
    summary: oldest === undefined
      ? { _tag: "Clear", next: rows.find((row) => row.group === "yours") }
      : { _tag: "Waiting", count: waiting.length, oldest }
  }
}

/** "2d 6h", "5h", "40m": two units at most, rounded down to whole minutes. */
export const formatSpan = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}
