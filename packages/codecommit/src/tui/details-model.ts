import { type Domain, ReadClient, type ReviewClient } from "@knpkv/codecommit-core"
import { parsePatch, structuredPatch } from "diff"
import { Effect, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"
import { WorktreeError, type WorktreePlan, type WorktreeResult } from "../WorktreeService.js"

const MAX_RENDERED_LINES = 500
const MAX_RENDERED_LINE_LENGTH = 2_000
const DIFF_CONTEXT_LINES = 3
const BINARY_SAMPLE_BYTES = 8_000
const MAX_PREVIEW_BLOB_BYTES = ReadClient.CODECOMMIT_BLOB_MAXIMUM_BYTES
const MAX_ACTION_DIAGNOSTIC_CHARACTERS = 2_048
const FILETYPE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml"
}

export interface PullRequestWorkspaceIdentity {
  readonly profile: string
  readonly pullRequestId: string
  readonly repoAccountId: string | undefined
  readonly region: string
  readonly repositoryName: string
}

/** Collision-safe selection key for provider-local pull-request numbers. */
export const pullRequestSelectionKey = (pr: Domain.PullRequest): string =>
  JSON.stringify([pr.account.profile, pr.account.region, pr.account.repoAccountId ?? null, pr.repositoryName, pr.id])

interface PullRequestSelectionResolution {
  readonly key: string
  readonly pullRequest: Domain.PullRequest
}

const unknownAccountPullRequestSelection = (
  selectionKey: string
): {
  readonly profile: string
  readonly pullRequestId: string
  readonly region: string
  readonly repositoryName: string
} | null => {
  try {
    const value: unknown = JSON.parse(selectionKey)
    if (!Array.isArray(value)) return null
    if (
      value.length === 4 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string" &&
      typeof value[2] === "string" &&
      typeof value[3] === "string"
    ) {
      return { profile: value[0], region: value[1], repositoryName: value[2], pullRequestId: value[3] }
    }
    return value.length === 5 &&
        typeof value[0] === "string" &&
        typeof value[1] === "string" &&
        value[2] === null &&
        typeof value[3] === "string" &&
        typeof value[4] === "string"
      ? { profile: value[0], region: value[1], repositoryName: value[3], pullRequestId: value[4] }
      : null
  } catch {
    return null
  }
}

/** Reconciles only the unambiguous unknown-to-known repository-account enrichment of an open PR selection. */
export const resolvePullRequestSelection = (
  pullRequests: ReadonlyArray<Domain.PullRequest>,
  selectionKey: string | null
): PullRequestSelectionResolution | null => {
  if (selectionKey === null) return null
  const exact = pullRequests.find((candidate) => pullRequestSelectionKey(candidate) === selectionKey)
  if (exact !== undefined) return { key: selectionKey, pullRequest: exact }
  const unknownAccount = unknownAccountPullRequestSelection(selectionKey)
  if (unknownAccount === null) return null
  const candidates = pullRequests.filter(
    (candidate) =>
      candidate.account.profile === unknownAccount.profile &&
      candidate.account.region === unknownAccount.region &&
      candidate.repositoryName === unknownAccount.repositoryName &&
      candidate.id === unknownAccount.pullRequestId
  )
  return candidates.length === 1
    ? { key: pullRequestSelectionKey(candidates[0]!), pullRequest: candidates[0]! }
    : null
}

/** Exact-head path accepted by local editors; deleted files have no head path. */
export const changedFileHeadPath = (file: ReadClient.CodeCommitChangedFile | null): string | null =>
  file?.after?.path ?? null

export type WorkspaceActionPhase = "idle" | "preflight" | "ready" | "running-review" | "running-worktree" | "terminal"

export type WorkspaceLifecycleTransition =
  | { readonly _tag: "preserve" }
  | {
    readonly _tag: "reset"
    readonly interrupt: "checkout" | "none" | "preflight" | "review"
    readonly preserveFindingPost: boolean
  }

export type WorkspaceResetInterruption = "checkout" | "conversation" | "preflight" | "review" | "verification"

export interface FileDiffIdentity extends PullRequestWorkspaceIdentity {
  readonly afterBlobId: string | null
  readonly afterPath: string | null
  readonly beforeBlobId: string | null
  readonly beforePath: string | null
  readonly destinationCommit: string
  readonly sourceCommit: string
}

export type WorkspaceSelection<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly value: A }
  | {
    readonly _tag: "stale"
  }

export interface ActionDiagnostic {
  readonly message: string
  readonly operation: string
  readonly workspaceRefreshReason?: WorkspaceRefreshReason
}

export type WorkspaceRefreshReason =
  | "revision-changed"
  | "source-commit-changed"
  | "destination-commit-changed"
  | "destination-reference-changed"
  | "repository-changed"

/** Typed action failure whose immutable workspace must be reloaded before another attempt. */
export class WorkspaceRefreshActionError extends Schema.TaggedErrorClass<WorkspaceRefreshActionError>()(
  "WorkspaceRefreshActionError",
  {
    operation: Schema.String,
    message: Schema.String,
    workspaceRefreshReason: Schema.Literals([
      "revision-changed",
      "source-commit-changed",
      "destination-commit-changed",
      "destination-reference-changed",
      "repository-changed"
    ])
  }
) {}

/** Classifies only stale immutable-target conflicts as reasons to reload before an explicit retry. */
export const mergeWorkspaceRefreshReason = (
  reason: ReviewClient.CodeCommitReviewConflictError["reason"]
): WorkspaceRefreshReason | null => {
  switch (reason) {
    case "revision-changed":
    case "source-commit-changed":
    case "destination-commit-changed":
    case "destination-reference-changed":
    case "repository-changed":
      return reason
    case "pull-request-closed":
    case "approval-by-author":
    case "approval-rules-unsatisfied":
    case "merge-conflict":
      return null
  }
}

/** Reloads stale revisions narrowly, but refreshes the PR list when selection identity changed. */
export const mergeFailureWorkspaceReloadPolicy = (
  diagnostic: ActionDiagnostic
): "refresh-list" | "reload" | "retain" => {
  if (diagnostic.workspaceRefreshReason === "repository-changed") return "refresh-list"
  return diagnostic.workspaceRefreshReason === undefined ? "retain" : "reload"
}

/** Clears an exact verification overlay whenever fresh provider workspace state is required. */
export const verifiedWorkspaceAfterMergeFailure = <A>(current: A | null, diagnostic: ActionDiagnostic): A | null =>
  mergeFailureWorkspaceReloadPolicy(diagnostic) === "retain" ? current : null

export type MergeResultObservation =
  | { readonly _tag: "failure" }
  | { readonly _tag: "pending" }
  | { readonly _tag: "success"; readonly requestId: string }

/** Correlates merge settlement and treats untyped runtime failure as an ambiguous provider outcome. */
export const mergeResultSettlement = (
  runningRequestId: string | null,
  observation: MergeResultObservation
): "ambiguous" | "ignore" | "settle" => {
  if (runningRequestId === null || observation._tag === "pending") return "ignore"
  if (observation._tag === "failure") return "ambiguous"
  return observation.requestId === runningRequestId ? "settle" : "ignore"
}

/**
 * Allows merge selection for a loaded exact revision when no workspace mutation is active.
 * Cached list-level mergeability is advisory; the conditional provider merge is authoritative.
 */
export const mergeStrategySelectionEnabled = (input: {
  readonly actionCancelable: boolean
  readonly cachedMergeable: boolean
  readonly exactRevisionLoaded: boolean
  readonly findingPostRunning: boolean
  readonly providerDriftPending: boolean
}): boolean =>
  input.exactRevisionLoaded &&
  !input.actionCancelable &&
  !input.findingPostRunning &&
  !input.providerDriftPending

/** Resolves an open merge dialog against the current render, never its captured opening revision. */
export const mergeDialogWorkspaceSelection = <A>(input: {
  readonly actionCancelable: boolean
  readonly cachedMergeable: boolean
  readonly currentWorkspace: A | null
  readonly findingPostRunning: boolean
  readonly providerDriftPending: boolean
}): A | null =>
  input.currentWorkspace !== null &&
    mergeStrategySelectionEnabled({
      actionCancelable: input.actionCancelable,
      cachedMergeable: input.cachedMergeable,
      exactRevisionLoaded: true,
      findingPostRunning: input.findingPostRunning,
      providerDriftPending: input.providerDriftPending
    })
    ? input.currentWorkspace
    : null

export type ActionOutcome<A> =
  | { readonly _tag: "failure"; readonly diagnostic: ActionDiagnostic; readonly requestId: string }
  | { readonly _tag: "success"; readonly requestId: string; readonly value: A }

export interface FindingPostSession {
  readonly findingId: string
  readonly findingIndex: number
  readonly fingerprint: string
  readonly requestId: string
  readonly workspaceReloadKey: string
}

/** Starts posting synchronously so a second key in the same terminal batch observes the in-flight write. */
export const beginFindingPostSession = (
  current: FindingPostSession | null,
  next: FindingPostSession
): FindingPostSession => current ?? next

type WorktreeLocalDiff =
  | { readonly _tag: "ready"; readonly plan: WorktreePlan; readonly worktree: WorktreeResult }
  | { readonly _tag: "provider" }
  | { readonly _tag: "outdated"; readonly plan: WorktreePlan; readonly worktree: WorktreeResult }

/** Promotes only the receipt for the expected exact-head checkout into local workspace readiness. */
export const worktreeCheckoutLocalDiff = (
  current: WorktreeLocalDiff,
  pending: { readonly plan: WorktreePlan; readonly requestId: string },
  outcome: ActionOutcome<WorktreeResult>
): WorktreeLocalDiff =>
  outcome._tag === "success" &&
    outcome.requestId === pending.requestId &&
    outcome.value.path === pending.plan.targetPath &&
    outcome.value.sourceCommit === pending.plan.sourceCommit
    ? { _tag: "ready", plan: pending.plan, worktree: outcome.value }
    : current

/** Enables editors only for a surviving head file in an exact-head local worktree. */
export const localEditorReady = (
  localDiff: { readonly _tag: "ready" | "provider" | "outdated" },
  headPath: string | null,
  actionCancelable: boolean
): boolean => localDiff._tag === "ready" && headPath !== null && !actionCancelable

/** Polls only while an exact local checkout is idle and no provider finding mutation owns the workspace. */
export const pullRequestRevisionPollingEnabled = (input: {
  readonly actionCancelable: boolean
  readonly checkoutIdentityMatches: boolean
  readonly findingPostRunning: boolean
  readonly hasLocalCheckout: boolean
}): boolean =>
  input.hasLocalCheckout &&
  input.checkoutIdentityMatches &&
  !input.actionCancelable &&
  !input.findingPostRunning

/** Keeps an interval tick from replacing a revision request that has not settled. */
export const pullRequestRevisionPollTickEnabled = (revisionPollWaiting: boolean): boolean => !revisionPollWaiting

/** Starts each provider drift refresh once, after the previous refresh has settled. */
export const pullRequestDriftRefreshStartEnabled = (input: {
  readonly handledObservationKey: string | null
  readonly observationKey: string
  readonly refreshWaiting: boolean
}): boolean => !input.refreshWaiting && input.handledObservationKey !== input.observationKey

/** Rejects a poll result whenever another operation owns the workspace. */
export const pullRequestRevisionObservationEnabled = (input: {
  readonly actionCancelable: boolean
  readonly findingPostRunning: boolean
}): boolean => !input.actionCancelable && !input.findingPostRunning

/** Keeps an already-open finding dialog from mutating a workspace during provider drift. */
export const findingConversationSubmissionEnabled = (providerDriftPending: boolean): boolean => !providerDriftPending

const isWorktreeError = Schema.is(WorktreeError)
const isWorkspaceRefreshActionError = Schema.is(WorkspaceRefreshActionError)

/** Retains only bounded, already-sanitized fields from typed action failures. */
export const actionDiagnostic = (error: unknown): ActionDiagnostic => {
  if (isWorkspaceRefreshActionError(error)) {
    return {
      message: error.message.slice(0, MAX_ACTION_DIAGNOSTIC_CHARACTERS),
      operation: error.operation,
      workspaceRefreshReason: error.workspaceRefreshReason
    }
  }
  if (isWorktreeError(error)) {
    return {
      message: error.message.slice(0, MAX_ACTION_DIAGNOSTIC_CHARACTERS),
      operation: error.operation
    }
  }
  if (AiError.isAiError(error)) {
    return {
      message: error.reason.message.slice(0, MAX_ACTION_DIAGNOSTIC_CHARACTERS),
      operation: `codex-${error.method}`
    }
  }
  return { message: "Unexpected action failure", operation: "action" }
}

const actionFailure = (requestId: string, error: unknown): ActionOutcome<never> => ({
  _tag: "failure",
  diagnostic: actionDiagnostic(error),
  requestId
})

const actionSuccess = <A>(requestId: string, value: A): ActionOutcome<A> => ({ _tag: "success", requestId, value })

export const actionOutcome = <A, E, R>(requestId: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => actionFailure(requestId, error),
      onSuccess: (value) => actionSuccess(requestId, value)
    })
  )

export type DetailsKeyIntent =
  | "ack-finding"
  | "back"
  | "cancel-action"
  | "consume"
  | "choose-review-skills"
  | "choose-merge-strategy"
  | "checkout-worktree"
  | "confirm-action"
  | "confirm-merge"
  | "discuss-finding"
  | "explain-risk"
  | "next-file"
  | "open-browser"
  | "open-neovim"
  | "open-vscode"
  | "next-finding"
  | "next-pending-finding"
  | "previous-file"
  | "post-finding"
  | "previous-finding"
  | "reject-finding"
  | "review-pr"
  | "review-security"
  | "review-tests"
  | "scroll-content-down"
  | "scroll-content-up"
  | "scroll-files-left"
  | "scroll-files-right"
  | "show-comments"
  | "show-diff"
  | "choose-finding-target"
  | "verify-finding"
  | "yield"

/** Decides whether the exact-head workspace consumes a key or yields it to dialogs/focused controls. */
export const detailsKeyIntent = (input: {
  readonly actionCancelable: boolean
  readonly actionReady: boolean
  readonly conversationRunning?: boolean
  readonly dialogOpen: boolean
  readonly findingPostRunning?: boolean
  readonly findingReviewActive?: boolean
  readonly keyName: string
  readonly mergeReady?: boolean
  readonly mergeRunning?: boolean
  readonly modified: boolean
  readonly shifted?: boolean
  readonly tab: "comments" | "diff"
  readonly workspaceRefreshing?: boolean
}): DetailsKeyIntent => {
  if (input.dialogOpen || input.modified) return "yield"
  if (input.mergeRunning === true) return "consume"
  if (
    input.findingPostRunning === true &&
    ["escape", "r", "s", "t", "e", "w"].includes(input.keyName)
  ) {
    return "consume"
  }
  if (input.keyName === "escape") return input.actionCancelable ? "cancel-action" : "back"
  if (
    input.workspaceRefreshing === true &&
    ["a", "d", "e", "g", "m", "M", "n", "p", "r", "s", "t", "v", "V", "w", "x", "return"].includes(input.keyName)
  ) {
    return "consume"
  }
  if (input.tab === "diff" && input.keyName === "return" && input.mergeReady === true) return "confirm-merge"
  if (input.tab === "diff" && input.keyName === "return" && input.actionReady) return "confirm-action"
  if (
    input.actionCancelable &&
    (
      ["a", "d", "e", "m", "M", "p", "r", "s", "t", "V", "w", "x"].includes(input.keyName) ||
      (input.keyName === "v" && input.shifted === true)
    )
  ) return input.keyName === "x" ? "cancel-action" : "consume"
  if (input.keyName === "1") return "show-diff"
  if (input.keyName === "2" || input.keyName === "c") return input.actionCancelable ? "yield" : "show-comments"
  if (input.keyName === "o") return "open-browser"
  if (
    input.tab === "diff" &&
    (input.keyName === "M" || (input.keyName === "m" && input.shifted === true))
  ) return input.actionCancelable ? "consume" : "choose-merge-strategy"
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    (input.keyName === "h" || input.keyName === "[")
  ) return "previous-finding"
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    (input.keyName === "l" || input.keyName === "]")
  ) return "next-finding"
  if (input.tab === "diff" && input.findingReviewActive === true && input.keyName === "u") {
    return "next-pending-finding"
  }
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    input.keyName === "d" &&
    input.conversationRunning !== true
  ) {
    return "discuss-finding"
  }
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    input.keyName === "m" &&
    input.conversationRunning !== true
  ) {
    return "choose-finding-target"
  }
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    (input.keyName === "V" || (input.keyName === "v" && input.shifted === true)) &&
    input.conversationRunning !== true
  ) {
    return "verify-finding"
  }
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    input.conversationRunning !== true &&
    input.keyName === "p"
  ) {
    return "post-finding"
  }
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    input.conversationRunning !== true &&
    input.keyName === "a"
  ) {
    return "ack-finding"
  }
  if (
    input.tab === "diff" &&
    input.findingReviewActive === true &&
    input.conversationRunning !== true &&
    input.keyName === "x"
  ) {
    return "reject-finding"
  }
  if (
    input.tab === "diff" &&
    !input.actionCancelable &&
    input.conversationRunning !== true &&
    input.keyName === "n"
  ) {
    return "open-neovim"
  }
  if (
    input.tab === "diff" &&
    !input.actionCancelable &&
    input.conversationRunning !== true &&
    input.keyName === "v" &&
    input.shifted !== true
  ) {
    return "open-vscode"
  }
  if (input.tab === "diff" && !input.actionCancelable && input.keyName === "g") return "choose-review-skills"
  if (input.tab === "diff" && input.keyName === "k") return "previous-file"
  if (input.tab === "diff" && input.keyName === "j") return "next-file"
  if (input.tab === "diff" && input.keyName === "up") return "scroll-content-up"
  if (input.tab === "diff" && input.keyName === "down") return "scroll-content-down"
  if (input.tab === "diff" && input.keyName === "left") return "scroll-files-left"
  if (input.tab === "diff" && input.keyName === "right") return "scroll-files-right"
  if (input.tab === "diff" && input.keyName === "w") return "checkout-worktree"
  if (input.tab === "diff" && input.keyName === "r") return "review-pr"
  if (input.tab === "diff" && input.keyName === "s") return "review-security"
  if (input.tab === "diff" && input.keyName === "t") return "review-tests"
  if (input.tab === "diff" && input.keyName === "e") return "explain-risk"
  return "yield"
}

export type BlobPreviewDisposition = "binary" | "text" | "too-large"

/** Classifies fetched blobs before allocating decoded strings for the terminal preview. */
export const blobPreviewDisposition = (beforeBytes: Uint8Array, afterBytes: Uint8Array): BlobPreviewDisposition => {
  if (beforeBytes.byteLength > MAX_PREVIEW_BLOB_BYTES || afterBytes.byteLength > MAX_PREVIEW_BLOB_BYTES) {
    return "too-large"
  }
  const hasNullByte = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_SAMPLE_BYTES).some((byte) => byte === 0)
  if (hasNullByte(beforeBytes) || hasNullByte(afterBytes)) return "binary"
  const isValidUtf8 = (bytes: Uint8Array): boolean => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return true
    } catch {
      return false
    }
  }
  if (!isValidUtf8(beforeBytes) || !isValidUtf8(afterBytes)) return "binary"
  return "text"
}

export const pullRequestWorkspaceIdentity = (pr: Domain.PullRequest): PullRequestWorkspaceIdentity => ({
  profile: pr.account.profile,
  pullRequestId: pr.id,
  repoAccountId: pr.account.repoAccountId,
  region: pr.account.region,
  repositoryName: pr.repositoryName
})

/** Names the exact base/head movement that made a retained checkout stale. */
export const localRevisionDriftMessage = (
  local: Pick<WorktreePlan, "destinationCommit" | "sourceCommit">,
  provider: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">,
  action: string
): string => {
  const baseChanged = local.destinationCommit !== provider.destinationCommit
  const headChanged = local.sourceCommit !== provider.sourceCommit
  const compact = (commit: string): string => commit.slice(0, 12)
  const movement = baseChanged && headChanged
    ? `Base ${compact(local.destinationCommit)} → ${compact(provider.destinationCommit)} · head ${
      compact(local.sourceCommit)
    } → ${compact(provider.sourceCommit)}`
    : baseChanged
    ? `Base local ${compact(local.destinationCommit)} → provider ${compact(provider.destinationCommit)}`
    : headChanged
    ? `Head local ${compact(local.sourceCommit)} → provider ${compact(provider.sourceCommit)}`
    : "Local checkout matches provider"
  return `${movement} · ${action}`
}

/** Stable refresh key for every PR field that can change exact-head loading or local actions. */
export const pullRequestWorkspaceReloadKey = (pr: Domain.PullRequest): string =>
  [
    pr.account.profile,
    pr.account.region,
    pr.account.repoAccountId ?? "",
    pr.repositoryName,
    pr.id,
    pr.lastModifiedDate.getTime()
  ].join("\u0000")

/** Stable comment request key for one PR revision and its latest observed comment activity. */
export const pullRequestCommentsRequestKey = (
  pr: Domain.PullRequest,
  revision: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">
): string =>
  [
    pr.account.profile,
    pr.account.region,
    pr.account.repoAccountId ?? "",
    pr.repositoryName,
    pr.id,
    pr.lastModifiedDate.getTime(),
    pr.commentCount ?? "",
    revision.destinationCommit,
    revision.sourceCommit
  ].join("\u0000")

/** Preserves semantic no-op refreshes and identifies the atom to interrupt before a real reset. */
export const workspaceLifecycleTransition = (
  previousKey: string | null,
  nextKey: string | null,
  phase: WorkspaceActionPhase,
  findingPostRunning = false
): WorkspaceLifecycleTransition => {
  if (previousKey === nextKey) return { _tag: "preserve" }
  const interrupt = phase === "preflight"
    ? "preflight"
    : phase === "running-worktree"
    ? "checkout"
    : phase === "running-review"
    ? "review"
    : "none"
  return { _tag: "reset", interrupt, preserveFindingPost: findingPostRunning }
}

/** Retires an old review deck once its post settles against a replacement workspace. */
export const workspaceFindingPostSettlement = (
  postingWorkspaceReloadKey: string,
  currentWorkspaceReloadKey: string | null
): "retain-review-deck" | "retire-review-deck" =>
  postingWorkspaceReloadKey === currentWorkspaceReloadKey ? "retain-review-deck" : "retire-review-deck"

/** Retains the finding deck that owns an in-flight post so its receipt remains visible. */
export const workspaceReviewDeckAfterReset = <Action>(
  current: { readonly action: Action; readonly selectedFindingIndex: number },
  preserveFindingPost: boolean,
  idleAction: Action
): { readonly action: Action; readonly selectedFindingIndex: number } =>
  preserveFindingPost ? current : { action: idleAction, selectedFindingIndex: 0 }

/** Makes a replaced workspace's old findings non-interactive as soon as their post settles. */
export const workspaceReviewDeckAfterPostSettlement = <Action>(
  current: { readonly action: Action; readonly selectedFindingIndex: number },
  postingWorkspaceReloadKey: string,
  currentWorkspaceReloadKey: string | null,
  idleAction: Action
): { readonly action: Action; readonly selectedFindingIndex: number } =>
  workspaceFindingPostSettlement(postingWorkspaceReloadKey, currentWorkspaceReloadKey) === "retain-review-deck"
    ? current
    : { action: idleAction, selectedFindingIndex: 0 }

/** Includes review children that must never outlive the exact workspace they inspect. */
export const workspaceResetInterruptions = (
  interrupt: Extract<WorkspaceLifecycleTransition, { readonly _tag: "reset" }>["interrupt"]
): ReadonlyArray<WorkspaceResetInterruption> => [
  ...(interrupt === "none" ? [] : [interrupt]),
  "conversation",
  "verification"
]

/** Keeps an external merge mutation alive while retiring merge state that has not started. */
export const workspaceMergeResetPolicy = (
  phase: "failed" | "idle" | "ready" | "running"
): "interrupt" | "preserve" => phase === "running" ? "preserve" : "interrupt"

export const workspaceIdentityMatches = (
  actual: PullRequestWorkspaceIdentity,
  expected: PullRequestWorkspaceIdentity
): boolean =>
  actual.profile === expected.profile &&
  actual.pullRequestId === expected.pullRequestId &&
  actual.repoAccountId === expected.repoAccountId &&
  actual.region === expected.region &&
  actual.repositoryName === expected.repositoryName

/** Makes a completed response terminal even when CodeCommit reports a renamed repository. */
export const currentWorkspaceSelection = <
  A extends {
    readonly identity: PullRequestWorkspaceIdentity
    readonly revision: {
      readonly pullRequestId: string
      readonly repositoryName: string
    }
  }
>(
  candidate: A | null,
  expected: PullRequestWorkspaceIdentity | null
): WorkspaceSelection<A> => {
  if (candidate === null || expected === null) return { _tag: "loading" }
  return workspaceIdentityMatches(candidate.identity, expected) &&
      candidate.revision.pullRequestId === expected.pullRequestId &&
      candidate.revision.repositoryName === expected.repositoryName
    ? { _tag: "ready", value: candidate }
    : { _tag: "stale" }
}

export type CommentRevisionContext =
  | { readonly _tag: "current" }
  | { readonly _tag: "historical"; readonly headCommit: string | undefined }
  | { readonly _tag: "pull-request" }
  | { readonly _tag: "unlocated" }

/** Describes which immutable PR revision owns a fetched review coordinate. */
export const commentRevisionContext = (
  location: Pick<Domain.PRCommentLocation, "afterCommitId" | "beforeCommitId" | "filePath">,
  revision: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">
): CommentRevisionContext => {
  const commitless = location.beforeCommitId === undefined && location.afterCommitId === undefined
  if (commitless) return { _tag: location.filePath === undefined ? "pull-request" : "unlocated" }
  if (location.beforeCommitId === revision.destinationCommit && location.afterCommitId === revision.sourceCommit) {
    return { _tag: "current" }
  }
  return { _tag: "historical", headCommit: location.afterCommitId }
}

/** Keeps every posted thread visible while placing exact-revision comments first. */
export const displayedCommentLocations = (
  locations: ReadonlyArray<Domain.PRCommentLocation>,
  revision: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "sourceCommit">
): ReadonlyArray<Domain.PRCommentLocation> => {
  const rank = (location: Domain.PRCommentLocation): number =>
    ({ current: 0, "pull-request": 1, unlocated: 1, historical: 2 })[commentRevisionContext(location, revision)._tag]
  return locations
    .map((location, index) => ({ index, location }))
    .sort((left, right) => rank(left.location) - rank(right.location) || left.index - right.index)
    .map(({ location }) => location)
}

export type PostedCommentsPresentation = "workspace-failure" | "failure" | "loading" | "empty" | "threads"

/** Keeps provider failures distinct from a successful read with no posted threads. */
export const postedCommentsPresentation = (input: {
  readonly commentCount: number
  readonly commentsFailed: boolean
  readonly commentsReady: boolean
  readonly revisionReady: boolean
  readonly workspaceFailed: boolean
}): PostedCommentsPresentation => {
  if (input.workspaceFailed) return "workspace-failure"
  if (input.commentsFailed) return "failure"
  if (!input.commentsReady || !input.revisionReady) return "loading"
  return input.commentCount === 0 ? "empty" : "threads"
}

export type CommentLocationAnchor =
  | { readonly _tag: "general"; readonly label: "Pull request" }
  | { readonly _tag: "file"; readonly filePath: string }
  | {
    readonly _tag: "line"
    readonly filePath: string
    readonly lineNumber: number
    readonly side: "before" | "after" | undefined
  }

/** Turns CodeCommit's grouped comment shape into one scan-friendly review coordinate. */
export const commentLocationAnchor = (
  location: Pick<Domain.PRCommentLocation, "comments" | "filePath" | "relativeFileVersion">
): CommentLocationAnchor => {
  if (location.filePath === undefined) return { _tag: "general", label: "Pull request" }
  const lineNumber = location.comments
    .map((thread) => thread.root.lineNumber)
    .find((candidate): candidate is number => candidate !== undefined)
  return lineNumber === undefined
    ? { _tag: "file", filePath: location.filePath }
    : {
      _tag: "line",
      filePath: location.filePath,
      lineNumber,
      side: location.relativeFileVersion === "BEFORE"
        ? "before"
        : location.relativeFileVersion === "AFTER"
        ? "after"
        : undefined
    }
}

export const fileDiffIdentity = (
  identity: PullRequestWorkspaceIdentity,
  revision: ReadClient.CodeCommitPullRequestRevision,
  file: ReadClient.CodeCommitChangedFile
): FileDiffIdentity => ({
  ...identity,
  afterBlobId: file.after?.blobId ?? null,
  afterPath: file.after?.path ?? null,
  beforeBlobId: file.before?.blobId ?? null,
  beforePath: file.before?.path ?? null,
  destinationCommit: revision.destinationCommit,
  sourceCommit: revision.sourceCommit
})

export const fileDiffIdentityMatches = (actual: FileDiffIdentity, expected: FileDiffIdentity): boolean =>
  workspaceIdentityMatches(actual, expected) &&
  actual.afterBlobId === expected.afterBlobId &&
  actual.afterPath === expected.afterPath &&
  actual.beforeBlobId === expected.beforeBlobId &&
  actual.beforePath === expected.beforePath &&
  actual.destinationCommit === expected.destinationCommit &&
  actual.sourceCommit === expected.sourceCommit

/** Stable in-memory cache key for one exact file revision and both immutable blob identities. */
export const fileDiffIdentityKey = (identity: FileDiffIdentity): string =>
  [
    identity.profile,
    identity.region,
    identity.repoAccountId ?? "",
    identity.repositoryName,
    identity.pullRequestId,
    identity.destinationCommit,
    identity.sourceCommit,
    identity.beforePath ?? "",
    identity.beforeBlobId ?? "",
    identity.afterPath ?? "",
    identity.afterBlobId ?? ""
  ].join("\u0000")

/** Keeps a retained async result only when it belongs to the file currently on screen. */
export const currentFileDiffOutcome = <A extends { readonly identity: FileDiffIdentity }>(
  outcome: A | null,
  expected: FileDiffIdentity | null
): A | null =>
  outcome !== null && expected !== null && fileDiffIdentityMatches(outcome.identity, expected) ? outcome : null

export const humanReviewState = (pr: Pick<Domain.PullRequest, "isApproved" | "isMergeable">) => ({
  approval: pr.isApproved ? "APPROVED" : "NEEDS REVIEW",
  mergeability: pr.isMergeable ? "MERGEABLE" : "CONFLICTS"
})

/** Cached list decisions have no revision identifier, so they cannot label an exact-head workspace. */
export const exactRevisionReviewState = (): {
  readonly approval: "UNVERIFIED"
  readonly mergeability: "UNVERIFIED"
} => ({
  approval: "UNVERIFIED",
  mergeability: "UNVERIFIED"
})

export const changedFilePath = (file: ReadClient.CodeCommitChangedFile): string =>
  file.after?.path ?? file.before?.path ?? "unknown"

export const changedFileRowId = (index: number): string => `changed-file-${index}`

export type ChangedFileTreeRow =
  | {
    readonly _tag: "directory"
    readonly depth: number
    readonly key: string
    readonly name: string
  }
  | {
    readonly _tag: "file"
    readonly depth: number
    readonly fileIndex: number
    readonly key: string
    readonly name: string
  }

const MAXIMUM_CHANGED_FILE_TREE_NAME_CHARACTERS = 120

/** Preserves ordinary file names while bounding hostile provider text independently of tree depth. */
export const changedFileTreeVisibleName = (row: ChangedFileTreeRow): string =>
  terminalSafeCompactText(row.name, MAXIMUM_CHANGED_FILE_TREE_NAME_CHARACTERS)

/** Natural horizontal width required to expose every bounded tree row without wrapping. */
export const changedFileTreeContentWidth = (rows: ReadonlyArray<ChangedFileTreeRow>): number =>
  rows.reduce(
    (maximum, row) =>
      Math.max(
        maximum,
        (row._tag === "directory" ? 3 : 5) + row.depth * 2 + Array.from(changedFileTreeVisibleName(row)).length
      ),
    1
  )

interface MutableChangedFileTreeDirectory {
  readonly children: Map<string, MutableChangedFileTreeDirectory>
  readonly entries: Array<
    | { readonly _tag: "directory"; readonly name: string }
    | { readonly _tag: "file"; readonly fileIndex: number; readonly name: string }
  >
}

const mutableChangedFileTreeDirectory = (): MutableChangedFileTreeDirectory => ({
  children: new Map(),
  entries: []
})

/** Groups shared path prefixes once while retaining stable first-seen sibling order and original file identities. */
export const changedFileTreeRows = (
  files: ReadonlyArray<ReadClient.CodeCommitChangedFile>
): ReadonlyArray<ChangedFileTreeRow> => {
  const root = mutableChangedFileTreeDirectory()
  files.forEach((file, fileIndex) => {
    const path = changedFilePath(file)
    const segments = path.split("/").filter((segment) => segment.length > 0)
    const fileName = segments.pop() ?? path
    let directory = root
    for (const segment of segments) {
      let child = directory.children.get(segment)
      if (child === undefined) {
        child = mutableChangedFileTreeDirectory()
        directory.children.set(segment, child)
        directory.entries.push({ _tag: "directory", name: segment })
      }
      directory = child
    }
    directory.entries.push({ _tag: "file", fileIndex, name: fileName })
  })

  const rows: Array<ChangedFileTreeRow> = []
  const append = (directory: MutableChangedFileTreeDirectory, depth: number, prefix: string): void => {
    for (const entry of directory.entries) {
      if (entry._tag === "file") {
        rows.push({
          _tag: "file",
          depth,
          fileIndex: entry.fileIndex,
          key: `${prefix}${entry.name}\u0000${entry.fileIndex}`,
          name: entry.name
        })
        continue
      }
      const path = `${prefix}${entry.name}/`
      rows.push({ _tag: "directory", depth, key: path, name: entry.name })
      const child = directory.children.get(entry.name)
      if (child !== undefined) append(child, depth + 1, path)
    }
  }
  append(root, 0, "")
  return rows
}

/** Moves between selectable file leaves in visual tree order; directory rows never receive focus. */
export const adjacentChangedFileIndex = (
  rows: ReadonlyArray<ChangedFileTreeRow>,
  currentFileIndex: number,
  direction: -1 | 1
): number => {
  const fileIndexes = rows.flatMap((row) => (row._tag === "file" ? [row.fileIndex] : []))
  if (fileIndexes.length === 0) return 0
  const currentPosition = fileIndexes.indexOf(currentFileIndex)
  if (currentPosition < 0) return fileIndexes[0] ?? 0
  const nextPosition = Math.max(0, Math.min(fileIndexes.length - 1, currentPosition + direction))
  return fileIndexes[nextPosition] ?? currentFileIndex
}

export const filetypeForPath = (path: string): string | undefined => {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : ""
  return FILETYPE_ALIASES[extension] ?? (extension.length > 0 ? extension : undefined)
}

const escapedCodePoint = (character: string): string =>
  `\\u{${character.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}}`

const isTerminalControl = (codePoint: number): boolean =>
  (codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)

const BIDI_CONTROL = /\p{Bidi_Control}/u

const isTerminalUnsafe = (character: string, codePoint: number): boolean =>
  isTerminalControl(codePoint) || BIDI_CONTROL.test(character)

/** Makes an untrusted single-line value visibly safe for terminal rendering. */
export const terminalSafeText = (value: string): string =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && isTerminalUnsafe(character, codePoint) ? escapedCodePoint(character) : character
  }).join("")

/** Keeps untrusted single-line text within a fixed terminal column budget. */
export const terminalSafeCompactText = (value: string, maxLength: number): string => {
  if (maxLength <= 0) return ""
  const safeCharacters = Array.from(terminalSafeText(value))
  if (safeCharacters.length <= maxLength) return safeCharacters.join("")
  if (maxLength === 1) return "…"
  return `${safeCharacters.slice(0, maxLength - 1).join("")}…`
}

/** Formats untrusted provider revision metadata for a single terminal-safe header. */
export const revisionHeaderText = (
  revision: Pick<ReadClient.CodeCommitPullRequestRevision, "destinationCommit" | "revisionId" | "sourceCommit">
): string =>
  terminalSafeText(
    `head ${revision.sourceCommit.slice(0, 12)}  ·  base ${revision.destinationCommit.slice(0, 12)}  ·  revision ${
      revision.revisionId.slice(
        0,
        10
      )
    }`
  )

/** Normalizes CRLF and preserves tabs and line feeds while escaping terminal controls. */
export const terminalSafeMultilineText = (value: string): string =>
  Array.from(value.replaceAll("\r\n", "\n"), (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint !== 0x09 && codePoint !== 0x0a && isTerminalUnsafe(character, codePoint)
      ? escapedCodePoint(character)
      : character
  }).join("")

const terminalSafePatchLine = (value: string): string => terminalSafeMultilineText(value.replace(/\r$/u, ""))

const fileMetadata = (file: ReadClient.CodeCommitChangedFile): Array<string> => {
  const metadata: Array<string> = []
  if (file.before?.path !== undefined && file.after?.path !== undefined && file.before.path !== file.after.path) {
    metadata.push(`rename ${terminalSafeText(file.before.path)} → ${terminalSafeText(file.after.path)}`)
  }
  if (file.before?.mode !== undefined && file.after?.mode !== undefined && file.before.mode !== file.after.mode) {
    metadata.push(`mode ${terminalSafeText(file.before.mode)} → ${terminalSafeText(file.after.mode)}`)
  }
  return metadata
}

const formatHunk = (hunk: {
  readonly lines: ReadonlyArray<string>
  readonly newLines: number
  readonly newStart: number
  readonly oldLines: number
  readonly oldStart: number
}): ReadonlyArray<string> => [
  `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  ...hunk.lines.map(terminalSafePatchLine)
]

/** Builds a bounded valid unified patch for OpenTUI's native diff renderable. */
export const buildUnifiedDiff = (
  file: ReadClient.CodeCommitChangedFile,
  beforeText: string,
  afterText: string
): { readonly diff: string; readonly metadata: string | null; readonly truncated: boolean } => {
  const beforePath = terminalSafeText(file.before?.path ?? "/dev/null")
  const afterPath = terminalSafeText(file.after?.path ?? "/dev/null")
  const oldFileName = file.before === null ? "/dev/null" : `a/${beforePath}`
  const newFileName = file.after === null ? "/dev/null" : `b/${afterPath}`
  const patch = structuredPatch(oldFileName, newFileName, beforeText, afterText, "", "", {
    context: DIFF_CONTEXT_LINES,
    maxEditLength: 20_000,
    timeout: 1_000
  })
  if (patch === undefined) return { diff: "", metadata: null, truncated: true }

  if (patch.hunks.length === 0) {
    const metadata = fileMetadata(file)
    if (file.before === null && file.after !== null) metadata.push("empty file added")
    if (file.before !== null && file.after === null) metadata.push("empty file deleted")
    if (metadata.length === 0) metadata.push("No textual changes")
    return { diff: "", metadata: metadata.join("\n"), truncated: false }
  }

  const lines = [`--- ${oldFileName}`, `+++ ${newFileName}`]
  if (lines.some((line) => line.length > MAX_RENDERED_LINE_LENGTH)) {
    return { diff: "", metadata: null, truncated: true }
  }
  let retainedHunks = 0
  for (const hunk of patch.hunks) {
    const formatted = formatHunk(hunk)
    const fitsBudget = lines.length + formatted.length <= MAX_RENDERED_LINES
    const hasBoundedLines = formatted.every((line) => line.length <= MAX_RENDERED_LINE_LENGTH)
    if (!fitsBudget || !hasBoundedLines) break
    for (const line of formatted) lines.push(line)
    retainedHunks += 1
  }

  const truncated = retainedHunks < patch.hunks.length
  const metadata = fileMetadata(file)
  return {
    diff: retainedHunks === 0 && truncated ? "" : lines.join("\n"),
    metadata: metadata.length === 0 ? null : metadata.join("\n"),
    truncated
  }
}

/** Validates that one exact-side line is an addition or deletion in the complete immutable blob diff. */
export const isChangedDiffLine = (
  beforeText: string,
  afterText: string,
  side: "before" | "after",
  line: number
): boolean => {
  const patch = structuredPatch("before", "after", beforeText, afterText, "", "", {
    context: 0,
    maxEditLength: 20_000,
    timeout: 1_000
  })
  if (patch === undefined) return false
  for (const hunk of patch.hunks) {
    let beforeLine = hunk.oldStart
    let afterLine = hunk.newStart
    for (const content of hunk.lines) {
      const prefix = content[0]
      if (prefix === "\\") continue
      if (prefix === "-" && side === "before" && beforeLine === line) return true
      if (prefix === "+" && side === "after" && afterLine === line) return true
      if (prefix !== "+") beforeLine += 1
      if (prefix !== "-") afterLine += 1
    }
  }
  return false
}

/** Resolves an exact provider line coordinate to OpenTUI's zero-based split-diff row. */
export const splitDiffLineRow = (diff: string, side: "before" | "after", line: number): number | null => {
  if (!Number.isInteger(line) || line < 1) return null
  let patches: ReturnType<typeof parsePatch>
  try {
    patches = parsePatch(diff)
  } catch {
    return null
  }
  const patch = patches[0]
  if (patch === undefined) return null
  let row = 0
  for (const hunk of patch.hunks) {
    let beforeLine = hunk.oldStart
    let afterLine = hunk.newStart
    let index = 0
    while (index < hunk.lines.length) {
      const content = hunk.lines[index]
      const prefix = content?.[0]
      if (prefix === " ") {
        if (side === "before" ? beforeLine === line : afterLine === line) return row
        beforeLine += 1
        afterLine += 1
        row += 1
        index += 1
        continue
      }
      if (prefix === "\\") {
        index += 1
        continue
      }
      const beforeStart = beforeLine
      const afterStart = afterLine
      let removed = 0
      let added = 0
      while (index < hunk.lines.length) {
        const changePrefix = hunk.lines[index]?.[0]
        if (changePrefix === " " || changePrefix === "\\") break
        if (changePrefix === "-") {
          removed += 1
          beforeLine += 1
        } else if (changePrefix === "+") {
          added += 1
          afterLine += 1
        }
        index += 1
      }
      if (side === "before" && line >= beforeStart && line < beforeStart + removed) {
        return row + line - beforeStart
      }
      if (side === "after" && line >= afterStart && line < afterStart + added) {
        return row + line - afterStart
      }
      row += Math.max(removed, added)
    }
  }
  return null
}
