/**
 * The review Workbench's queue: which open pull requests belong to the current user and why, in
 * groups (needs your review, open to a role pool, yours, watching), plus the one-line summary above them.
 *
 * Pure: callers pass the already account-filtered list (`queuePullRequests`) and `now`.
 *
 * Two clocks, never mixed: *open* runs from creation (CodeCommit exposes no revision timestamps
 * to the client yet), *quiet* runs from the last modification. An unknown caller identity is
 * reported as `Unknown`, never as an empty queue.
 */
import { approvalOf, identityMatches } from "@knpkv/codecommit-core/Domain.js"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { Data } from "effect"

const DAY_MS = 86_400_000

/** A pull request counts as quiet after this long without any modification. */
export const QUIET_AFTER_MS = 7 * DAY_MS

/**
 * `pool` holds pull requests waiting on a wildcard role pool (`…/Reviewers/*`) in an account where
 * the caller is known only by user name, not role, so it cannot tell whether the caller is in that
 * pool; once the account's identity resolves (`Caller.identities`) the ARN decides exactly.
 * `unsorted` holds every open pull request when no caller identity resolved: membership cannot
 * be decided, so nothing is presented as needing the user's review.
 */
export type WorkbenchGroup = "review" | "pool" | "yours" | "watching" | "unsorted"

/**
 * Why one of your own pull requests is not merged yet; the worst reason only. `unverified` means
 * every rule reads satisfied while the pull request as a whole is not approved, so the two
 * provider answers disagree.
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
  Clear: { readonly next: WorkbenchRow | undefined; readonly pooled: number }
}>

/** Constructors and exhaustive `$match` for {@link WorkbenchSummary}. */
export const WorkbenchSummary = Data.taggedEnum<WorkbenchSummary>()

/**
 * The caller in one account, as the server resolved it with STS: the subset of core's L2-8 (v3)
 * `CallerIdentity` the queue reads, so core's value is assignable as is. The queue ignores the
 * `Unresolved` reason; any unresolved account keeps the name fallback. `arn` can carry an email
 * address (SSO session names): never log or persist it.
 */
export type CallerIdentity =
  | { readonly _tag: "Resolved"; readonly arn: string; readonly username: string }
  | { readonly _tag: "Unresolved" }

/**
 * Who the queue is for. `username` is the app-wide `currentUser`. `identities` is keyed by AWS
 * profile (`pullRequest.account.profile`); `undefined` until the server publishes it. Only a
 * `Resolved` identity decides pool membership exactly; every other case falls back to the name.
 */
export interface Caller {
  readonly username: string | undefined
  readonly identities: Readonly<Record<string, CallerIdentity>> | undefined
}

/**
 * The queue's caller from app state. Reads only the user name until core publishes per-account
 * identities (L2-8), so every pool decision keeps today's name fallback.
 */
export const callerOf = (state: { readonly currentUser?: string | undefined }): Caller => ({
  identities: undefined,
  username: state.currentUser
})

/** The caller as seen from one pull request's account: always a name, an ARN when resolved. */
interface Viewer {
  readonly name: string
  readonly arn: string | undefined
}

const viewerOf = (caller: Caller, pullRequest: Domain.PullRequest): Viewer | undefined => {
  const identity = caller.identities?.[pullRequest.account.profile]
  if (identity?._tag === "Resolved") return { arn: identity.arn, name: identity.username }
  return caller.username === undefined || caller.username.length === 0
    ? undefined
    : { arn: undefined, name: caller.username }
}

export interface WorkbenchQueue {
  readonly summary: WorkbenchSummary
  readonly rows: ReadonlyArray<WorkbenchRow>
}

/**
 * Whole-string match where each `*` stands for any run of characters, anywhere in the pattern.
 * Greedy with one remembered star, so it stays O(pattern × value) for any number of stars; pool
 * entries are repository data and must not be able to stall the page with a backtracking regex.
 */
export const globMatches = (pattern: string, value: string): boolean => {
  let p = 0
  let v = 0
  let star = -1
  let resume = 0
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++
      v++
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++
      resume = v
    } else if (star >= 0) {
      p = star + 1
      v = ++resume
    } else {
      return false
    }
  }
  while (pattern[p] === "*") p++
  return p === pattern.length
}

/**
 * Whether a pool entry could match a principal whose user or session name is `name`, whatever
 * its role and account. The name is the entry's last path segment (`user/alice`,
 * `assumed-role/Reviewers/alice`, shorthand `Reviewers/alice`) and must glob-match it. A `*` in
 * that segment can also cover `/` (a role before the session, IAM user paths: `user/team/al*`
 * matches `user/team/alex/bob`), so then only the literal text after the last `*` has to fit the
 * end of `/name`. Role-session and federated-user ARNs are the exception: their final segment is
 * the session name itself, so `assumed-role/Reviewers/b*` cannot be alice.
 */
const nameCompatible = (entry: string, name: string): boolean => {
  const resource = entry.slice(entry.lastIndexOf(":") + 1).toLowerCase()
  const segments = resource.split("/")
  const named = entry.startsWith("arn:") ? segments.slice(1) : segments
  const last = named.at(-1) ?? ""
  const wanted = name.trim().toLowerCase().split(/[/:]/).at(-1) ?? ""
  if (isRoleOnly(entry)) return true
  const sessionIsLast = entry.startsWith("arn:") &&
    ((segments[0] === "assumed-role" && named.length >= 2) || segments[0] === "federated-user")
  if (last.includes("*") && !sessionIsLast) return `/${wanted}`.endsWith(last.slice(last.lastIndexOf("*") + 1))
  return globMatches(last, wanted)
}

/** `arn:aws:sts::ACCOUNT:assumed-role/RoleName`: CodeCommit's documented form for "any session of this role". */
const isRoleOnly = (entry: string): boolean => /^arn:aws[\w-]*:sts::[^:]*:assumed-role\/[^/]+$/.test(entry)

const approverArn = /^arn:aws[\w-]*:(?:iam|sts)::(\d+):(?:user|federated-user|assumed-role)\/(.+)$/

/**
 * One approval-pool entry against one approver ARN, with CodeCommit's semantics: a fully
 * qualified ARN matches the whole ARN, and a role-only `assumed-role/RoleName` ARN matches every
 * session of that role; the `CodeCommitApprovers:ACCOUNT:RESOURCE` shorthand
 * matches an IAM user, federated user or role session in that account whose name (after
 * `user/`, `federated-user/` or `assumed-role/`) matches RESOURCE. Both accept `*` anywhere.
 */
export const poolEntryMatches = (entry: string, arn: string): boolean => {
  const shorthand = /^CodeCommitApprovers:(\d+):(.+)$/.exec(entry)
  if (shorthand === null) return globMatches(entry, arn) || (isRoleOnly(entry) && globMatches(`${entry}/*`, arn))
  const approver = approverArn.exec(arn)
  return approver !== null && approver[1] === shorthand[1] && globMatches(shorthand[2] ?? "", approver[2] ?? "")
}

/** Raw pool entries when the provider sent them; the normalized names only for legacy rules. */
const poolEntries = (rule: Domain.ApprovalRule): ReadonlyArray<string> =>
  rule.poolMemberArns.length > 0 ? rule.poolMemberArns : rule.poolMembers

/**
 * Approvals that count toward one rule. A satisfied rule is complete by definition; a rule with
 * no pool accepts any approver. Otherwise ARNs decide whenever both sides carry them (wildcards
 * included), because names are lossy: `Operations/alice` and `Reviewers/alice` share one. Names
 * only count when ARN evidence is missing, and never against a wildcard member.
 */
const approvalsOn = (pullRequest: Domain.PullRequest, rule: Domain.ApprovalRule): number => {
  if (rule.satisfied) return rule.requiredApprovals
  if (rule.poolMembers.length === 0 && rule.poolMemberArns.length === 0) return pullRequest.approvedBy.length
  if (rule.poolMemberArns.length > 0 && pullRequest.approvedByArns.length > 0) {
    return pullRequest.approvedByArns.filter((arn) => rule.poolMemberArns.some((entry) => poolEntryMatches(entry, arn)))
      .length
  }
  // Name fallback: wildcard entries never count by name. Raw entries carry the wildcards that
  // normalization strips (`Review*/alice` becomes `alice`), so they decide when present.
  const exactMembers = poolEntries(rule).filter((entry) => !entry.includes("*"))
  return pullRequest.approvedBy.filter((approver) => exactMembers.some((member) => identityMatches(approver, member)))
    .length
}

/**
 * Whether the caller is in one rule's approval pool. `open` means the rule has no pool, so any
 * approval counts. With the caller's ARN in this account and the rule's raw entries, the provider's
 * own matching decides: `member` or `out`. Otherwise the caller is known only by user name:
 * `member` means an entry without a wildcard names them (role and account unchecked); `maybe` means
 * only a wildcard or role-only entry could match, and its fixed name part does not rule them out.
 *
 * This intentionally differs from core's `needsMyReview` (and so the TUI's review count) in two
 * cases: a rule with no pool is `open` here (core says no review needed), and a wildcard entry is
 * `maybe` here (core matches it by its tail name as a certain member).
 */
const poolStanding = (rule: Domain.ApprovalRule, viewer: Viewer): "member" | "maybe" | "open" | "out" => {
  const entries = poolEntries(rule)
  if (entries.length === 0) return "open"
  const arn = viewer.arn
  if (arn !== undefined && rule.poolMemberArns.length > 0) {
    return rule.poolMemberArns.some((entry) => poolEntryMatches(entry, arn)) ? "member" : "out"
  }
  const possible = entries.filter((entry) => nameCompatible(entry, viewer.name))
  if (possible.some((entry) => !entry.includes("*") && !isRoleOnly(entry))) return "member"
  return possible.length > 0 ? "maybe" : "out"
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
    .sort(
      (a, b) =>
        a.approved / Math.max(1, a.required) - b.approved / Math.max(1, b.required) ||
        b.required - b.approved - (a.required - a.approved)
    )
  const chosen = unsatisfied[0] ?? progress[0]
  return chosen === undefined ? undefined : { approved: chosen.approved, name: chosen.name, required: chosen.required }
}

const stuckReason = (pullRequest: Domain.PullRequest, quietMs: number): StuckReason => {
  if (!pullRequest.isMergeable) return "conflicts"
  if (quietMs > QUIET_AFTER_MS) return "quiet"
  const approval = approvalOf(pullRequest)
  // An unknown approval has only last known rules, so it can be neither ready nor waiting on approvals.
  if (approval._tag === "Unknown") return "unverified"
  if (pullRequest.approvalRules.length === 0) return "ready"
  if (!pullRequest.approvalRules.every((rule) => rule.satisfied)) return "approvals"
  return approval._tag === "Approved" ? "ready" : "unverified"
}

/**
 * Whether the caller already approved toward this rule. With the caller's ARN and approver ARNs,
 * only the caller's own ARN counts, so another session of the same role is not "you". With
 * approver ARNs only, a same-name approval that the rule's pool counts does, so `Operations/alice`
 * approving leaves a `Reviewers/*` rule open for alice; without ARNs, any same-name approval does.
 */
const approvedToward = (pullRequest: Domain.PullRequest, rule: Domain.ApprovalRule, viewer: Viewer): boolean => {
  if (viewer.arn !== undefined && pullRequest.approvedByArns.length > 0) {
    return pullRequest.approvedByArns.includes(viewer.arn)
  }
  if (pullRequest.approvedByArns.length === 0 || rule.poolMemberArns.length === 0) {
    return pullRequest.approvedBy.some((approver) => identityMatches(viewer.name, approver))
  }
  return pullRequest.approvedByArns.some(
    (arn) => identityMatches(viewer.name, arn) && rule.poolMemberArns.some((entry) => poolEntryMatches(entry, arn))
  )
}

/**
 * Yours first; then, for the unsatisfied rules the caller hasn't approved toward, `review` when one
 * certainly counts their approval (named member, or no pool at all) and `pool` when one only might.
 * While approval is unknown, which rules are satisfied is only last known: any rule the caller could
 * count toward makes it `pool`, never the certain `review`.
 */
const groupOf = (pullRequest: Domain.PullRequest, viewer: Viewer): WorkbenchGroup | undefined => {
  if (identityMatches(viewer.name, pullRequest.author)) return "yours"
  if (approvalOf(pullRequest)._tag === "Unknown") {
    const couldCount = pullRequest.approvalRules
      .filter((rule) => !approvedToward(pullRequest, rule, viewer))
      .some((rule) => poolStanding(rule, viewer) !== "out")
    if (couldCount) return "pool"
  }
  const standings = pullRequest.approvalRules
    .filter((rule) => !rule.satisfied && !approvedToward(pullRequest, rule, viewer))
    .map((rule) => poolStanding(rule, viewer))
  if (standings.some((standing) => standing === "member" || standing === "open")) return "review"
  if (standings.includes("maybe")) return "pool"
  if (pullRequest.commentedBy.some((name) => identityMatches(viewer.name, name))) return "watching"
  return undefined
}

/**
 * Whether an open pull request belongs in "Needs your review" for this user. The one definition
 * that the rail, the header badge, the review reminder and the pull request list's review filter
 * all count with, so their numbers agree.
 */
export const needsYourReview = (pullRequest: Domain.PullRequest, caller: Caller): boolean => {
  const viewer = viewerOf(caller, pullRequest)
  return viewer !== undefined && pullRequest.status === "OPEN" && groupOf(pullRequest, viewer) === "review"
}

/** How many of these pull requests need the user's review; pass the account-filtered queue. */
export const yourReviewCount = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  caller: Caller
): number => pullRequests.filter((pullRequest) => needsYourReview(pullRequest, caller)).length

const groupOrder = { review: 0, pool: 1, yours: 2, watching: 3, unsorted: 4 } satisfies Readonly<
  Record<WorkbenchGroup, number>
>

/**
 * Builds the queue for one user. Only open pull requests take part; within a group the longest
 * open comes first. A pull request whose account has neither a resolved identity nor the user-name
 * fallback is `unsorted`; with no identity at all the summary is `Unknown`, because membership
 * cannot be decided.
 */
export const workbenchQueue = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  caller: Caller,
  now: Date
): WorkbenchQueue => {
  // Known when some account can decide: an app-wide user name, or any account's resolved identity.
  // A pull request whose own account cannot is still `unsorted`, the same rule `needsYourReview` uses.
  const known = (caller.username !== undefined && caller.username.length > 0) ||
    Object.values(caller.identities ?? {}).some((identity) => identity._tag === "Resolved")
  const rows = pullRequests
    .filter((pullRequest) => pullRequest.status === "OPEN")
    .flatMap((pullRequest): ReadonlyArray<WorkbenchRow> => {
      const viewer = viewerOf(caller, pullRequest)
      const group = viewer === undefined ? "unsorted" : groupOf(pullRequest, viewer)
      if (group === undefined) return []
      const quietMs = Math.max(0, now.getTime() - pullRequest.lastModifiedDate.getTime())
      return [
        {
          group,
          openMs: Math.max(0, now.getTime() - pullRequest.creationDate.getTime()),
          pullRequest,
          quietMs,
          // While approval is unknown, rule progress is only last known, so the row says unknown instead.
          rule: approvalOf(pullRequest)._tag === "Unknown" ? undefined : ruleProgress(pullRequest),
          stuck: group === "yours"
            ? stuckReason(pullRequest, quietMs)
            : approvalOf(pullRequest)._tag === "Unknown"
            ? "unverified"
            : undefined
        }
      ]
    })
    .sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || b.openMs - a.openMs)
  if (!known) return { rows, summary: WorkbenchSummary.Unknown() }
  const waiting = rows.filter((row) => row.group === "review")
  const oldest = waiting[0]
  return {
    rows,
    summary: oldest === undefined
      ? WorkbenchSummary.Clear({
        next: rows.find((row) => row.group === "yours"),
        pooled: rows.filter((row) => row.group === "pool").length
      })
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
