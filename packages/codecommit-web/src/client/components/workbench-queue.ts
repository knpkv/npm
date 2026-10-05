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
import { Data } from "effect"

const DAY_MS = 86_400_000

/** A pull request counts as quiet after this long without any modification. */
export const QUIET_AFTER_MS = 7 * DAY_MS

/**
 * `unsorted` holds every open pull request when no caller identity resolved: membership cannot
 * be decided, so nothing is presented as needing the user's review.
 */
export type WorkbenchGroup = "review" | "yours" | "watching" | "unsorted"

/**
 * Why one of your own pull requests is not merged yet; the worst reason only. `unverified` means
 * every rule reads satisfied but the approval state itself could not be evaluated.
 */
export type StuckReason = "conflicts" | "quiet" | "approvals" | "unverified" | "ready"

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

/** The one-line summary above the queue. */
export type WorkbenchSummary = Data.TaggedEnum<{
  Unknown: {}
  Waiting: { readonly count: number; readonly oldest: WorkbenchRow }
  Clear: { readonly next: WorkbenchRow | undefined }
}>

/** Constructors and exhaustive `$match` for {@link WorkbenchSummary}. */
export const WorkbenchSummary = Data.taggedEnum<WorkbenchSummary>()

export interface WorkbenchQueue {
  readonly summary: WorkbenchSummary
  readonly rows: ReadonlyArray<WorkbenchRow>
}

/** CodeCommit pool entries may end in `*` (e.g. `…:assumed-role/Reviewers/*`); match them as prefixes. */
const arnMatches = (pattern: string, arn: string): boolean =>
  pattern.endsWith("*") ? arn.startsWith(pattern.slice(0, -1)) : pattern === arn

/**
 * Approvals that count toward one rule. A satisfied rule is complete by definition; a rule with
 * no pool accepts any approver; otherwise an approver counts when their ARN matches a pool ARN
 * (wildcards included) or, for exact names, when the normalized identities match.
 */
const approvalsOn = (pullRequest: Domain.PullRequest, rule: Domain.ApprovalRule): number => {
  if (rule.satisfied) return rule.requiredApprovals
  if (rule.poolMembers.length === 0 && rule.poolMemberArns.length === 0) return pullRequest.approvedBy.length
  const byArn =
    pullRequest.approvedByArns.filter((arn) => rule.poolMemberArns.some((pattern) => arnMatches(pattern, arn)))
      .length
  const exactMembers = rule.poolMembers.filter((member) => !member.includes("*"))
  const byName =
    pullRequest.approvedBy.filter((approver) => exactMembers.some((member) => identityMatches(approver, member))).length
  return Math.max(byArn, byName)
}

/**
 * The rule furthest from being met: lowest share approved, then most approvals still missing, so
 * "0/2 two maintainers" outranks "0/1 security" and "1/2" outranks "1/1".
 */
export const ruleProgress = (pullRequest: Domain.PullRequest): RuleProgress | undefined => {
  const progress = pullRequest.approvalRules.map((rule) => ({
    approved: Math.min(approvalsOn(pullRequest, rule), rule.requiredApprovals),
    name: rule.ruleName,
    required: rule.requiredApprovals,
    satisfied: rule.satisfied
  }))
  const unsatisfied = progress
    .filter((rule) => !rule.satisfied)
    .sort((a, b) =>
      a.approved / Math.max(1, a.required) - b.approved / Math.max(1, b.required) ||
      (b.required - b.approved) - (a.required - a.approved)
    )
  const chosen = unsatisfied[0] ?? progress[0]
  return chosen === undefined ? undefined : { approved: chosen.approved, name: chosen.name, required: chosen.required }
}

const stuckReason = (pullRequest: Domain.PullRequest, quietMs: number): StuckReason => {
  if (!pullRequest.isMergeable) return "conflicts"
  if (quietMs > QUIET_AFTER_MS) return "quiet"
  if (pullRequest.approvalRules.length === 0) return "ready"
  if (!pullRequest.approvalRules.every((rule) => rule.satisfied)) return "approvals"
  return pullRequest.isApproved ? "ready" : "unverified"
}

const groupOf = (pullRequest: Domain.PullRequest, currentUser: string): WorkbenchGroup | undefined => {
  if (identityMatches(currentUser, pullRequest.author)) return "yours"
  if (needsMyReview(pullRequest, currentUser)) return "review"
  if (pullRequest.commentedBy.some((name) => identityMatches(currentUser, name))) return "watching"
  return undefined
}

const groupOrder = { review: 0, yours: 1, watching: 2, unsorted: 3 } satisfies Readonly<Record<WorkbenchGroup, number>>

/**
 * Builds the queue for one user. Only open pull requests take part; within a group the longest
 * open comes first. With no identity, every open pull request is listed under `unsorted` and the
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
      const group = known ? groupOf(pullRequest, currentUser) : "unsorted"
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
  if (!known) return { rows, summary: WorkbenchSummary.Unknown() }
  const waiting = rows.filter((row) => row.group === "review")
  const oldest = waiting[0]
  return {
    rows,
    summary: oldest === undefined
      ? WorkbenchSummary.Clear({ next: rows.find((row) => row.group === "yours") })
      : WorkbenchSummary.Waiting({ count: waiting.length, oldest })
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
