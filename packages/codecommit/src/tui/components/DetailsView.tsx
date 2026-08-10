import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Domain, ReadClient } from "@knpkv/codecommit-core"
import { type DiffRenderable, parseColor, type ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  type RelayFindingPublicationTarget,
  type RelayReviewConversationTurn,
  type RelayReviewFinding,
  type RelayReviewKind,
  type RelayReviewResult,
  type RelayReviewVerificationResult,
  relayFindingAnchor,
  relayFindingFileIndex,
  relayFindingPublicationLabel,
  relayReviewPriorityLabel
} from "../../RelayReview.js"
import { defaultRelayReviewSkills, relayReviewSkillsLabel, type RelayReviewSkillId } from "../../ReviewSkills.js"
import type { WorktreePlan } from "../../WorktreeService.js"
import { fetchPrCommentsAtom, openPrAtom } from "../atoms/actions.js"
import { type AppState, appStateAtom } from "../atoms/app.js"
import {
  checkoutWorktreeAtom,
  continueRelayReviewAtom,
  loadFileDiffAtom,
  loadPullRequestWorkspaceAtom,
  openEditorAtom,
  postRelayFindingAtom,
  preflightWorktreeAtom,
  type PullRequestWorkspace,
  runRelayReviewAtom,
  verifyRelayFindingAtom
} from "../atoms/details.js"
import {
  type ActionDiagnostic,
  adjacentChangedFileIndex,
  beginFindingPostSession,
  changedFileHeadPath,
  changedFileRowId,
  changedFileTreeContentWidth,
  changedFileTreeRows,
  changedFileTreeVisibleName,
  commentLocationAnchor,
  commentRevisionContext,
  currentFileDiffOutcome,
  currentWorkspaceSelection,
  detailsKeyIntent,
  displayedCommentLocations,
  exactRevisionReviewState,
  fileDiffIdentity,
  fileDiffIdentityKey,
  localEditorReady,
  postedCommentsPresentation,
  pullRequestCommentsRequestKey,
  pullRequestWorkspaceReloadKey,
  pullRequestWorkspaceIdentity,
  pullRequestSelectionKey,
  revisionHeaderText,
  splitDiffLineRow,
  terminalSafeCompactText,
  terminalSafeMultilineText,
  terminalSafeText,
  type FindingPostSession,
  type WorkspaceActionPhase,
  workspaceFindingPostSettlement,
  workspaceLifecycleTransition,
  workspaceReviewDeckAfterPostSettlement,
  workspaceReviewDeckAfterReset,
  workspaceResetInterruptions,
  worktreeCheckoutLocalDiff,
  workspaceIdentityMatches
} from "../details-model.js"
import type { FileDiffOutcome } from "../file-diff.js"
import type { LocalEditor } from "../editor-launch.js"
import { selectedPrIdAtom, viewAtom } from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import {
  adjacentFindingIndex,
  detachedStalePublicationDiagnostic,
  detachedStalePublicationIds,
  findingDispositionNeedsResolution,
  findingDispositionMarker,
  type FindingDisposition,
  nextPendingFindingIndex,
  type RelayReviewReconciliation,
  relayFindingFingerprint,
  relayFindingHeadEditorLine,
  relayFindingPostReceiptDisposition,
  relayFindingSessionReceiptMatches,
  relayFindingSessionReply,
  relayReviewReconciliationLabel,
  reconcileRelayVerificationResult,
  reconcileRelayReviewSession
} from "../review-session.js"
import { DialogFindingConversation } from "../ui/DialogFindingConversation.js"
import { DialogFindingTarget } from "../ui/DialogFindingTarget.js"
import { DialogReviewSkills } from "../ui/DialogReviewSkills.js"

const defaultState: AppState = { status: "loading", pullRequests: [], accounts: [] }
const emptyCommentLocations = (): Array<Domain.PRCommentLocation> => []
let nextActionRequestSequence = 0

const hasVerticalScroll = (value: object): value is object & { scrollY: number } =>
  "scrollY" in value && typeof value.scrollY === "number"

const scrollDiffBy = (diff: DiffRenderable | null, lines: number): void => {
  if (diff === null) return
  const pending = [...diff.getChildren()]
  while (pending.length > 0) {
    const renderable = pending.pop()
    if (renderable === undefined) continue
    if (hasVerticalScroll(renderable)) renderable.scrollY += lines
    for (const child of renderable.getChildren()) pending.push(child)
  }
}

const scrollDiffToRow = (diff: DiffRenderable, row: number): void => {
  const offset = Math.max(0, row - 2)
  const pending = [...diff.getChildren()]
  while (pending.length > 0) {
    const renderable = pending.pop()
    if (renderable === undefined) continue
    if (hasVerticalScroll(renderable)) renderable.scrollY = offset
    for (const child of renderable.getChildren()) pending.push(child)
  }
}

const formatRelativeDate = (date: Date): string => {
  const diffMins = Math.floor((Date.now() - date.getTime()) / 60_000)
  if (diffMins < 1) return "just now"
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  return diffHours < 24 ? `${diffHours}h ago` : `${Math.floor(diffHours / 24)}d ago`
}

function CommentThread({
  depth,
  syntaxStyle,
  thread
}: {
  readonly depth: number
  readonly syntaxStyle: SyntaxStyle | null
  readonly thread: Domain.CommentThread
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" style={{ paddingLeft: depth * 2 }}>
      {thread.root.deleted ? (
        <text fg={theme.textMuted}>{`${depth > 0 ? "│" : "┌"} comment deleted`}</text>
      ) : (
        <text
          fg={theme.textMuted}
        >{`${depth > 0 ? "│" : "┌"} ${terminalSafeText(thread.root.author)} · ${formatRelativeDate(thread.root.creationDate)}`}</text>
      )}
      {thread.root.deleted ? null : syntaxStyle ? (
        <markdown
          content={terminalSafeMultilineText(thread.root.content)}
          syntaxStyle={syntaxStyle}
          style={{ paddingLeft: 2, width: "100%" }}
        />
      ) : (
        <text fg={theme.text} style={{ paddingLeft: 2 }}>
          {terminalSafeMultilineText(thread.root.content)}
        </text>
      )}
      {thread.replies.map((reply) => (
        <CommentThread depth={depth + 1} key={reply.root.id} syntaxStyle={syntaxStyle} thread={reply} />
      ))}
    </box>
  )
}

function CommentLocationHeader({
  location,
  revision
}: {
  readonly location: Domain.PRCommentLocation
  readonly revision: ReadClient.CodeCommitPullRequestRevision
}) {
  const { theme } = useTheme()
  const anchor = commentLocationAnchor(location)
  const revisionContext = commentRevisionContext(location, revision)
  const lineSide =
    anchor._tag !== "line" || anchor.side === undefined
      ? ""
      : anchor.side === "before"
        ? " · BASE / BEFORE"
        : " · HEAD / AFTER"
  const badge = anchor._tag === "line" ? ` LINE ${anchor.lineNumber}${lineSide} ` : ` ${anchor._tag.toUpperCase()} `
  const target = anchor._tag === "general" ? anchor.label : anchor.filePath
  const revisionLabel =
    revisionContext._tag === "current"
      ? "CURRENT REVISION"
      : revisionContext._tag === "historical"
        ? `OLDER REVISION · head ${revisionContext.headCommit?.slice(0, 12) ?? "unknown"} · current ${revision.sourceCommit.slice(0, 12)}`
        : revisionContext._tag === "unlocated"
          ? "REVISION NOT PROVIDED"
          : null
  return (
    <box flexDirection="column" style={{ paddingBottom: 1 }}>
      <box flexDirection="row">
        <text bg={theme.accentTint} fg={theme.textAccent}>
          {badge}
        </text>
        <text fg={theme.textMuted}> {"→"} </text>
        <text fg={theme.text}>{terminalSafeText(target)}</text>
      </box>
      {revisionLabel === null ? null : (
        <text fg={revisionContext._tag === "historical" ? theme.textWarning : theme.textMuted}>
          {` ${revisionLabel}`}
        </text>
      )}
    </box>
  )
}

function CommentsPanel({
  pr,
  revision,
  syntaxStyle,
  workspaceFailed
}: {
  readonly pr: Domain.PullRequest
  readonly revision: ReadClient.CodeCommitPullRequestRevision | null
  readonly syntaxStyle: SyntaxStyle | null
  readonly workspaceFailed: boolean
}) {
  const { theme } = useTheme()
  const fetchComments = useAtomSet(fetchPrCommentsAtom)
  const result = useAtomValue(fetchPrCommentsAtom)
  const fetchedRef = useRef<string | null>(null)
  const expectedIdentity = pullRequestWorkspaceIdentity(pr)
  const requestKey = revision === null ? null : pullRequestCommentsRequestKey(pr, revision)
  useEffect(() => {
    if (requestKey === null) return
    if (fetchedRef.current === requestKey) return
    fetchedRef.current = requestKey
    fetchComments(pr)
  }, [fetchComments, pr, requestKey])
  const commentsResult =
    AsyncResult.isSuccess(result) &&
    !AsyncResult.isWaiting(result) &&
    workspaceIdentityMatches(result.value.identity, expectedIdentity)
      ? result.value.comments
      : null
  const comments =
    commentsResult === null || revision === null
      ? emptyCommentLocations()
      : displayedCommentLocations(commentsResult, revision)
  const commentsFailed = AsyncResult.isFailure(result) && !AsyncResult.isWaiting(result)
  const presentation = postedCommentsPresentation({
    commentCount: comments.length,
    commentsFailed,
    commentsReady: commentsResult !== null,
    revisionReady: revision !== null,
    workspaceFailed
  })
  useKeyboard((key) => {
    if (presentation !== "failure" || key.ctrl === true || key.meta === true || key.name !== "r") return
    key.stopPropagation()
    fetchComments(pr)
  })
  return (
    <scrollbox
      focused
      style={{ backgroundColor: theme.background, flexGrow: 1, padding: 1, paddingLeft: 2, width: "100%" }}
    >
      {presentation === "workspace-failure" ? (
        <text fg={theme.textError}>Exact-head read failed.</text>
      ) : presentation === "failure" ? (
        <text fg={theme.textError}>Posted comments unavailable · R retry</text>
      ) : presentation === "loading" ? (
        <text fg={theme.textMuted}>Loading review thread…</text>
      ) : null}
      {presentation === "empty" ? <text fg={theme.textMuted}>No posted comments</text> : null}
      {revision === null
        ? null
        : comments.map((location, locationIndex) => (
            <box
              flexDirection="column"
              key={`${location.filePath ?? "general"}-${locationIndex}`}
              style={{ paddingBottom: 1 }}
            >
              <CommentLocationHeader location={location} revision={revision} />
              {location.comments.map((thread) => (
                <CommentThread depth={0} key={thread.root.id} syntaxStyle={syntaxStyle} thread={thread} />
              ))}
            </box>
          ))}
    </scrollbox>
  )
}

type PendingAction = "worktree" | RelayReviewKind
type ReviewSkillSnapshot = { readonly reviewSkills: ReadonlyArray<RelayReviewSkillId> }
type ActionStatus =
  | { readonly _tag: "idle" }
  | ({ readonly _tag: "preflight"; readonly action: PendingAction; readonly requestId: string } & ReviewSkillSnapshot)
  | ({
      readonly _tag: "ready"
      readonly action: PendingAction
      readonly plan: WorktreePlan
      readonly requestId: string
    } & ReviewSkillSnapshot)
  | ({
      readonly _tag: "running"
      readonly action: PendingAction
      readonly plan: WorktreePlan
      readonly requestId: string
    } & ReviewSkillSnapshot)
  | { readonly _tag: "done"; readonly action: PendingAction; readonly detail: string }
  | ({
      readonly _tag: "reviewed"
      readonly action: RelayReviewKind
      readonly plan: WorktreePlan
      readonly result: RelayReviewResult
    } & ReviewSkillSnapshot)
  | { readonly _tag: "failed"; readonly action: PendingAction; readonly diagnostic: ActionDiagnostic }

type EditorStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "opening"; readonly editor: LocalEditor; readonly requestId: string }
  | { readonly _tag: "done"; readonly editor: LocalEditor }
  | { readonly _tag: "failed"; readonly diagnostic: ActionDiagnostic }

type ConversationStatus =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "running"
      readonly findingId: string
      readonly previousReview: RelayReviewResult
      readonly requestId: string
    }
  | { readonly _tag: "failed"; readonly diagnostic: ActionDiagnostic }
  | {
      readonly _tag: "complete"
      readonly findingId: string
      readonly reconciliation: RelayReviewReconciliation
      readonly reply: string | null
    }

type VerificationStatus =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "running"
      readonly findingId: string
      readonly previousReview: RelayReviewResult
      readonly previousRevision: ReadClient.CodeCommitPullRequestRevision
      readonly requestId: string
    }
  | { readonly _tag: "failed"; readonly diagnostic: ActionDiagnostic }
  | {
      readonly _tag: "complete"
      readonly findingId: string
      readonly headChanged: boolean
      readonly outcome: RelayReviewVerificationResult["outcome"]
      readonly reconciliation: RelayReviewReconciliation
      readonly reply: string
    }

type FindingPostReceipt = {
  readonly findingId: string
  readonly message: string
  readonly status: "failed" | "posted-stale"
}

const actionLabel = (action: PendingAction): string =>
  ({
    review: "Review",
    security: "Security",
    tests: "Tests",
    explain: "Risk",
    worktree: "Worktree"
  })[action]

const verificationOutcomeLabel = (outcome: RelayReviewVerificationResult["outcome"]): string =>
  ({
    resolved: "RESOLVED",
    "still-actionable": "STILL OPEN",
    superseded: "SUPERSEDED",
    inconclusive: "INCONCLUSIVE"
  })[outcome]

function ActionKey({
  active,
  keyName,
  label
}: {
  readonly active: boolean
  readonly keyName: string
  readonly label: string
}) {
  const { theme } = useTheme()
  return (
    <text fg={active ? theme.text : theme.textMuted} {...(active ? { bg: theme.backgroundRaised } : {})}>
      <span fg={theme.textAccent}>{` ${keyName} `}</span>
      {`${label} `}
    </text>
  )
}

/** Exact-head PR workspace: files, native diff, human state, and preflighted local actions. */
export function DetailsView() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const selectedPrId = useAtomValue(selectedPrIdAtom)
  const appState = AsyncResult.getOrElse(useAtomValue(appStateAtom), () => defaultState)
  const setView = useAtomSet(viewAtom)
  const openPr = useAtomSet(openPrAtom)
  const loadWorkspace = useAtomSet(loadPullRequestWorkspaceAtom)
  const workspaceResult = useAtomValue(loadPullRequestWorkspaceAtom)
  const loadDiff = useAtomSet(loadFileDiffAtom)
  const diffResult = useAtomValue(loadFileDiffAtom)
  const preflight = useAtomSet(preflightWorktreeAtom)
  const preflightResult = useAtomValue(preflightWorktreeAtom)
  const checkout = useAtomSet(checkoutWorktreeAtom)
  const checkoutResult = useAtomValue(checkoutWorktreeAtom)
  const runReview = useAtomSet(runRelayReviewAtom)
  const reviewResult = useAtomValue(runRelayReviewAtom)
  const continueReview = useAtomSet(continueRelayReviewAtom)
  const continueReviewResult = useAtomValue(continueRelayReviewAtom)
  const verifyFindingAction = useAtomSet(verifyRelayFindingAtom)
  const verifyFindingResult = useAtomValue(verifyRelayFindingAtom)
  const postFinding = useAtomSet(postRelayFindingAtom)
  const postFindingResult = useAtomValue(postRelayFindingAtom)
  const openEditor = useAtomSet(openEditorAtom)
  const openEditorResult = useAtomValue(openEditorAtom)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [selectedFindingIndex, setSelectedFindingIndex] = useState(0)
  const [findingDispositions, setFindingDispositions] = useState<Record<string, FindingDisposition>>({})
  const [findingPostDiagnostics, setFindingPostDiagnostics] = useState<Record<string, ActionDiagnostic>>({})
  const [postingFinding, setPostingFinding] = useState<FindingPostSession | null>(null)
  const [findingPostReceipt, setFindingPostReceipt] = useState<FindingPostReceipt | null>(null)
  const [conversationTurns, setConversationTurns] = useState<ReadonlyArray<RelayReviewConversationTurn>>([])
  const [conversationStatus, setConversationStatus] = useState<ConversationStatus>({ _tag: "idle" })
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>({ _tag: "idle" })
  const [verifiedWorkspace, setVerifiedWorkspace] = useState<PullRequestWorkspace | null>(null)
  const [tab, setTab] = useState<"comments" | "diff">("diff")
  const [reviewSkills, setReviewSkills] = useState<ReadonlyArray<RelayReviewSkillId>>(defaultRelayReviewSkills)
  const [action, setAction] = useState<ActionStatus>({ _tag: "idle" })
  const [editorStatus, setEditorStatus] = useState<EditorStatus>({ _tag: "idle" })
  const [diffCache, setDiffCache] = useState<ReadonlyMap<string, FileDiffOutcome>>(() => new Map())
  const [syntaxStyle, setSyntaxStyle] = useState<SyntaxStyle | null>(null)
  const actionScrollRef = useRef<ScrollBoxRenderable>(null)
  const actionRef = useRef<ActionStatus>(action)
  const selectedFindingIndexRef = useRef(selectedFindingIndex)
  const diffRef = useRef<DiffRenderable>(null)
  const highlightedFindingRef = useRef<{ readonly diff: DiffRenderable; readonly row: number } | null>(null)
  const filesScrollRef = useRef<ScrollBoxRenderable>(null)
  const loadedWorkspaceKeyRef = useRef<string | null>(null)
  const pendingDiffKeyRef = useRef<string | null>(null)
  const postingFindingRef = useRef<FindingPostSession | null>(null)
  actionRef.current = action
  selectedFindingIndexRef.current = selectedFindingIndex

  const updatePostingFinding = (next: FindingPostSession | null) => {
    postingFindingRef.current = next
    setPostingFinding(next)
  }

  const pr = useMemo(
    () =>
      selectedPrId === null
        ? null
        : (appState.pullRequests.find((candidate) => pullRequestSelectionKey(candidate) === selectedPrId) ?? null),
    [appState.pullRequests, selectedPrId]
  )
  const loadedWorkspaceCandidate =
    AsyncResult.isSuccess(workspaceResult) && !AsyncResult.isWaiting(workspaceResult) ? workspaceResult.value : null
  const expectedWorkspaceIdentity = pr === null ? null : pullRequestWorkspaceIdentity(pr)
  const workspaceCandidate =
    verifiedWorkspace !== null &&
    expectedWorkspaceIdentity !== null &&
    workspaceIdentityMatches(verifiedWorkspace.identity, expectedWorkspaceIdentity)
      ? verifiedWorkspace
      : loadedWorkspaceCandidate
  const workspaceSelection = currentWorkspaceSelection(workspaceCandidate, expectedWorkspaceIdentity)
  const workspace = workspaceSelection._tag === "ready" ? workspaceSelection.value : null
  const fileTreeRows = useMemo(() => changedFileTreeRows(workspace?.files ?? []), [workspace?.files])
  const fileTreeContentWidth = useMemo(() => changedFileTreeContentWidth(fileTreeRows), [fileTreeRows])
  const selectedFile = workspace?.files[selectedFileIndex] ?? null
  const headEditorPath = changedFileHeadPath(selectedFile)
  const beforePath = selectedFile?.before?.path ?? "/dev/null"
  const afterPath = selectedFile?.after?.path ?? "/dev/null"
  const expectedFileIdentity =
    workspace === null || selectedFile === null
      ? null
      : fileDiffIdentity(workspace.identity, workspace.revision, selectedFile)
  const selectedDiffKey = expectedFileIdentity === null ? null : fileDiffIdentityKey(expectedFileIdentity)
  const retainedDiffOutcome =
    AsyncResult.isSuccess(diffResult) && !AsyncResult.isWaiting(diffResult) ? diffResult.value : null
  const liveDiffOutcome = currentFileDiffOutcome(retainedDiffOutcome, expectedFileIdentity)
  const diffOutcome =
    selectedDiffKey === null
      ? null
      : (diffCache.get(selectedDiffKey) ?? workspace?.fileDiffs.get(selectedDiffKey) ?? liveDiffOutcome)
  const renderedDiff = diffOutcome?._tag === "success" ? diffOutcome.value : null
  const diffFailed = diffOutcome?._tag === "failure"
  const workspaceFailed =
    workspaceSelection._tag === "stale" ||
    (AsyncResult.isFailure(workspaceResult) && !AsyncResult.isWaiting(workspaceResult))
  const workspaceReloadKey = pr === null ? null : pullRequestWorkspaceReloadKey(pr)

  useEffect(() => {
    const currentAction = actionRef.current
    const phase: WorkspaceActionPhase =
      currentAction._tag === "running"
        ? currentAction.action === "worktree"
          ? "running-worktree"
          : "running-review"
        : currentAction._tag === "done" || currentAction._tag === "reviewed" || currentAction._tag === "failed"
          ? "terminal"
          : currentAction._tag
    const transition = workspaceLifecycleTransition(
      loadedWorkspaceKeyRef.current,
      workspaceReloadKey,
      phase,
      postingFindingRef.current !== null
    )
    if (transition._tag === "preserve") return
    loadedWorkspaceKeyRef.current = workspaceReloadKey
    for (const interrupt of workspaceResetInterruptions(transition.interrupt)) {
      if (interrupt === "preflight") preflight(Atom.Interrupt)
      else if (interrupt === "checkout") checkout(Atom.Interrupt)
      else if (interrupt === "review") runReview(Atom.Interrupt)
      else if (interrupt === "conversation") continueReview(Atom.Interrupt)
      else verifyFindingAction(Atom.Interrupt)
    }
    const reviewDeck = workspaceReviewDeckAfterReset(
      { action: actionRef.current, selectedFindingIndex: selectedFindingIndexRef.current },
      transition.preserveFindingPost,
      { _tag: "idle" }
    )
    setSelectedFileIndex(0)
    setSelectedFindingIndex(reviewDeck.selectedFindingIndex)
    if (!transition.preserveFindingPost) {
      setFindingDispositions({})
      setFindingPostDiagnostics({})
      setFindingPostReceipt(null)
      updatePostingFinding(null)
    }
    setConversationTurns([])
    setConversationStatus({ _tag: "idle" })
    setVerificationStatus({ _tag: "idle" })
    setVerifiedWorkspace(null)
    setDiffCache(new Map())
    setEditorStatus({ _tag: "idle" })
    pendingDiffKeyRef.current = null
    setTab("diff")
    setAction(reviewDeck.action)
    if (pr !== null) loadWorkspace(pr)
  }, [checkout, continueReview, loadWorkspace, preflight, pr, runReview, verifyFindingAction, workspaceReloadKey])

  useEffect(() => {
    if (pr === null || workspace === null || selectedFile === null || selectedDiffKey === null) return
    if (diffCache.has(selectedDiffKey)) return
    if (workspace.fileDiffs.has(selectedDiffKey)) return
    if (pendingDiffKeyRef.current === selectedDiffKey) return
    pendingDiffKeyRef.current = selectedDiffKey
    loadDiff({
      account: pr.account,
      file: selectedFile,
      identity: workspace.identity,
      ...(workspace.localDiff._tag === "ready" ? { localWorktreePath: workspace.localDiff.worktree.path } : {}),
      repositoryName: workspace.revision.repositoryName,
      revision: workspace.revision
    })
  }, [diffCache, loadDiff, pr, selectedDiffKey, selectedFile, workspace])

  useEffect(() => {
    if (retainedDiffOutcome === null) return
    const completedKey = fileDiffIdentityKey(retainedDiffOutcome.identity)
    if (pendingDiffKeyRef.current === completedKey) pendingDiffKeyRef.current = null
    if (retainedDiffOutcome._tag !== "success") return
    setDiffCache((current) => {
      if (current.has(completedKey)) return current
      const next = new Map(current)
      next.set(completedKey, retainedDiffOutcome)
      return next
    })
  }, [retainedDiffOutcome])

  useLayoutEffect(() => {
    filesScrollRef.current?.scrollChildIntoView(changedFileRowId(selectedFileIndex))
  }, [selectedFileIndex, workspace?.files.length])

  useEffect(() => {
    if (action._tag !== "preflight" || AsyncResult.isWaiting(preflightResult) || workspace === null) return
    if (!AsyncResult.isSuccess(preflightResult)) return
    const outcome = preflightResult.value
    if (outcome.requestId !== action.requestId) return
    if (outcome._tag === "failure") {
      setAction({ _tag: "failed", action: action.action, diagnostic: outcome.diagnostic })
      return
    }
    const plan = outcome.value
    if (
      pr === null ||
      plan.account.profile !== pr.account.profile ||
      plan.account.region !== pr.account.region ||
      plan.destinationCommit !== workspace.revision.destinationCommit ||
      plan.pullRequestId !== pr.id ||
      plan.repositoryName !== workspace.revision.repositoryName ||
      plan.sourceCommit !== workspace.revision.sourceCommit
    )
      return
    setAction({
      _tag: "ready",
      action: action.action,
      plan,
      requestId: action.requestId,
      reviewSkills: action.reviewSkills
    })
  }, [action, pr, preflightResult, workspace])

  useEffect(() => {
    if (
      workspace === null ||
      action._tag !== "running" ||
      action.action !== "worktree" ||
      AsyncResult.isWaiting(checkoutResult)
    )
      return
    if (!AsyncResult.isSuccess(checkoutResult) || checkoutResult.value.requestId !== action.requestId) return
    const outcome = checkoutResult.value
    if (outcome._tag === "failure") {
      setAction({ _tag: "failed", action: "worktree", diagnostic: outcome.diagnostic })
      return
    }
    const localDiff = worktreeCheckoutLocalDiff(workspace.localDiff, action, outcome)
    if (localDiff !== workspace.localDiff) {
      setVerifiedWorkspace({ ...workspace, localDiff })
      setAction({ _tag: "done", action: "worktree", detail: outcome.value.path })
    }
  }, [action, checkoutResult, workspace])

  useEffect(() => {
    if (action._tag !== "running" || action.action === "worktree" || AsyncResult.isWaiting(reviewResult)) return
    if (!AsyncResult.isSuccess(reviewResult) || reviewResult.value.requestId !== action.requestId) return
    const outcome = reviewResult.value
    if (outcome._tag === "failure") {
      setAction({ _tag: "failed", action: action.action, diagnostic: outcome.diagnostic })
      return
    }
    if (
      outcome.value.kind === action.action &&
      outcome.value.worktree.path === action.plan.targetPath &&
      outcome.value.worktree.sourceCommit === action.plan.sourceCommit
    ) {
      setSelectedFindingIndex(0)
      setFindingDispositions({})
      setFindingPostDiagnostics({})
      setConversationTurns([])
      setConversationStatus({ _tag: "idle" })
      setVerificationStatus({ _tag: "idle" })
      setAction({
        _tag: "reviewed",
        action: action.action,
        plan: action.plan,
        result: outcome.value.summary,
        reviewSkills: action.reviewSkills
      })
    }
  }, [action, reviewResult])

  useEffect(() => {
    if (postingFinding === null || AsyncResult.isWaiting(postFindingResult)) return
    if (!AsyncResult.isSuccess(postFindingResult) || postFindingResult.value.requestId !== postingFinding.requestId)
      return
    const outcome = postFindingResult.value
    const postSettlement = workspaceFindingPostSettlement(postingFinding.workspaceReloadKey, workspaceReloadKey)
    const settledReviewDeck = workspaceReviewDeckAfterPostSettlement(
      { action: actionRef.current, selectedFindingIndex: selectedFindingIndexRef.current },
      postingFinding.workspaceReloadKey,
      workspaceReloadKey,
      { _tag: "idle" }
    )
    if (outcome._tag === "failure") {
      if (postSettlement === "retire-review-deck") {
        setFindingPostReceipt({
          findingId: postingFinding.findingId,
          message: `${outcome.diagnostic.operation}: ${outcome.diagnostic.message}`,
          status: "failed"
        })
        setFindingDispositions({})
        setFindingPostDiagnostics({})
        setSelectedFindingIndex(settledReviewDeck.selectedFindingIndex)
        setAction(settledReviewDeck.action)
        updatePostingFinding(null)
        return
      }
      setFindingDispositions((current) => ({ ...current, [postingFinding.findingId]: "failed" }))
      setFindingPostDiagnostics((current) => ({
        ...current,
        [postingFinding.findingId]: outcome.diagnostic
      }))
      updatePostingFinding(null)
      return
    }
    let receiptReview = action._tag === "reviewed" ? action.result : null
    if (
      conversationStatus._tag === "running" &&
      !AsyncResult.isWaiting(continueReviewResult) &&
      AsyncResult.isSuccess(continueReviewResult) &&
      continueReviewResult.value.requestId === conversationStatus.requestId &&
      continueReviewResult.value._tag === "success"
    ) {
      receiptReview = continueReviewResult.value.value.response.review
    } else if (
      verificationStatus._tag === "running" &&
      !AsyncResult.isWaiting(verifyFindingResult) &&
      AsyncResult.isSuccess(verifyFindingResult) &&
      verifyFindingResult.value.requestId === verificationStatus.requestId &&
      verifyFindingResult.value._tag === "success"
    ) {
      receiptReview = reconcileRelayVerificationResult(
        verificationStatus.findingId,
        verificationStatus.previousReview,
        verifyFindingResult.value.value.response
      ).review
    }
    const currentFinding = receiptReview?.findings.find((finding) => finding.id === postingFinding.findingId)
    const postDisposition = relayFindingPostReceiptDisposition(postingFinding, currentFinding, outcome.value)
    if (postSettlement === "retire-review-deck") {
      setFindingPostReceipt({
        findingId: postingFinding.findingId,
        message: "The provider accepted a finding from the previous workspace; its old review deck was retired",
        status: "posted-stale"
      })
      setFindingDispositions({})
      setFindingPostDiagnostics({})
      setSelectedFindingIndex(settledReviewDeck.selectedFindingIndex)
      setAction(settledReviewDeck.action)
      updatePostingFinding(null)
      return
    }
    if (postDisposition === "posted-stale") {
      setFindingDispositions((current) => ({
        ...current,
        [postingFinding.findingId]: postDisposition
      }))
      setFindingPostDiagnostics((current) => ({
        ...current,
        [postingFinding.findingId]: {
          operation: "post-finding-receipt",
          message: "The provider accepted an older finding version; inspect or supersede the obsolete published comment"
        }
      }))
      updatePostingFinding(null)
      return
    }
    const nextDispositions: Record<string, FindingDisposition> = {
      ...findingDispositions,
      [postingFinding.findingId]: "posted"
    }
    const findingIds = action._tag === "reviewed" ? action.result.findings.map((finding) => finding.id) : []
    setFindingDispositions(nextDispositions)
    setSelectedFindingIndex((index) => nextPendingFindingIndex(findingIds, nextDispositions, index))
    setFindingPostDiagnostics((current) => {
      const next = { ...current }
      delete next[postingFinding.findingId]
      return next
    })
    updatePostingFinding(null)
  }, [
    action,
    continueReviewResult,
    conversationStatus,
    findingDispositions,
    postFindingResult,
    postingFinding,
    verificationStatus,
    verifyFindingResult,
    workspaceReloadKey
  ])

  useEffect(() => {
    if (conversationStatus._tag !== "running" || AsyncResult.isWaiting(continueReviewResult)) return
    if (
      !AsyncResult.isSuccess(continueReviewResult) ||
      continueReviewResult.value.requestId !== conversationStatus.requestId
    )
      return
    const outcome = continueReviewResult.value
    if (outcome._tag === "failure") {
      setConversationStatus({ _tag: "failed", diagnostic: outcome.diagnostic })
      return
    }
    const nextReview = outcome.value.response.review
    const reconciled = reconcileRelayReviewSession(conversationStatus.previousReview, nextReview, findingDispositions)
    const previousIndex = conversationStatus.previousReview.findings.findIndex(
      (finding) => finding.id === conversationStatus.findingId
    )
    const retainedIndex = nextReview.findings.findIndex((finding) => finding.id === conversationStatus.findingId)
    setSelectedFindingIndex(
      retainedIndex >= 0
        ? retainedIndex
        : Math.min(Math.max(0, previousIndex), Math.max(0, nextReview.findings.length - 1))
    )
    setFindingDispositions(
      (current) => reconcileRelayReviewSession(conversationStatus.previousReview, nextReview, current).dispositions
    )
    setConversationTurns((current) => [
      ...current,
      { findingId: conversationStatus.findingId, role: "assistant", message: outcome.value.response.reply }
    ])
    setAction((current) => (current._tag === "reviewed" ? { ...current, result: nextReview } : current))
    setConversationStatus({
      _tag: "complete",
      findingId: conversationStatus.findingId,
      reconciliation: reconciled.reconciliation,
      reply: outcome.value.response.reply
    })
  }, [continueReviewResult, conversationStatus, findingDispositions])

  useEffect(() => {
    if (verificationStatus._tag !== "running" || AsyncResult.isWaiting(verifyFindingResult)) return
    if (
      !AsyncResult.isSuccess(verifyFindingResult) ||
      verifyFindingResult.value.requestId !== verificationStatus.requestId
    )
      return
    const outcome = verifyFindingResult.value
    if (outcome._tag === "failure") {
      setVerificationStatus({ _tag: "failed", diagnostic: outcome.diagnostic })
      return
    }
    const verificationResult = reconcileRelayVerificationResult(
      verificationStatus.findingId,
      verificationStatus.previousReview,
      outcome.value.response
    )
    const nextReview = verificationResult.review
    const reconciled = reconcileRelayReviewSession(verificationStatus.previousReview, nextReview, findingDispositions)
    const previousIndex = verificationStatus.previousReview.findings.findIndex(
      (finding) => finding.id === verificationStatus.findingId
    )
    const retainedIndex = nextReview.findings.findIndex((finding) => finding.id === verificationStatus.findingId)
    setSelectedFindingIndex(
      retainedIndex >= 0
        ? retainedIndex
        : Math.min(Math.max(0, previousIndex), Math.max(0, nextReview.findings.length - 1))
    )
    setSelectedFileIndex(0)
    setFindingDispositions(
      (current) => reconcileRelayReviewSession(verificationStatus.previousReview, nextReview, current).dispositions
    )
    setConversationTurns((current) => [
      ...current,
      {
        findingId: verificationStatus.findingId,
        role: "user",
        message: `Verify against latest PR revision ${outcome.value.workspace.revision.sourceCommit}.`
      },
      {
        findingId: verificationStatus.findingId,
        role: "assistant",
        message: verificationResult.reply
      }
    ])
    setVerifiedWorkspace(outcome.value.workspace)
    setDiffCache(outcome.value.workspace.fileDiffs)
    pendingDiffKeyRef.current = null
    setAction((current) =>
      current._tag === "reviewed" ? { ...current, plan: outcome.value.plan, result: nextReview } : current
    )
    setVerificationStatus({
      _tag: "complete",
      findingId: verificationStatus.findingId,
      headChanged:
        verificationStatus.previousRevision.sourceCommit !== outcome.value.workspace.revision.sourceCommit ||
        verificationStatus.previousRevision.destinationCommit !== outcome.value.workspace.revision.destinationCommit,
      outcome: verificationResult.outcome,
      reconciliation: reconciled.reconciliation,
      reply: verificationResult.reply
    })
  }, [findingDispositions, verificationStatus, verifyFindingResult])

  useEffect(() => {
    if (editorStatus._tag !== "opening" || AsyncResult.isWaiting(openEditorResult)) return
    if (AsyncResult.isFailure(openEditorResult)) {
      setEditorStatus({
        _tag: "failed",
        diagnostic: { operation: "open-editor", message: "The editor action failed unexpectedly" }
      })
      return
    }
    if (!AsyncResult.isSuccess(openEditorResult) || openEditorResult.value.requestId !== editorStatus.requestId) return
    const outcome = openEditorResult.value
    if (outcome._tag === "failure") {
      setEditorStatus({ _tag: "failed", diagnostic: outcome.diagnostic })
      return
    }
    setEditorStatus({ _tag: "done", editor: outcome.value.editor })
  }, [editorStatus, openEditorResult])

  const reviewedFindings = action._tag === "reviewed" ? action.result.findings : []
  const selectedFinding: RelayReviewFinding | null = reviewedFindings[selectedFindingIndex] ?? null
  const selectedFindingDiffRow = useMemo(() => {
    if (selectedFinding?.location.scope !== "line" || renderedDiff === null || selectedFile === null) return null
    const selectedPath =
      selectedFinding.location.side === "after" ? selectedFile.after?.path : selectedFile.before?.path
    if (selectedPath !== selectedFinding.location.filePath) return null
    return splitDiffLineRow(renderedDiff.diff, selectedFinding.location.side, selectedFinding.location.line)
  }, [renderedDiff, selectedFile, selectedFinding])

  useEffect(() => {
    if (action._tag !== "reviewed" || workspace === null) return
    const finding = action.result.findings[selectedFindingIndex]
    if (finding === undefined) return
    const fileIndex = relayFindingFileIndex(finding, workspace.files)
    if (fileIndex !== null) setSelectedFileIndex(fileIndex)
  }, [action, selectedFindingIndex, workspace])

  useLayoutEffect(() => {
    const previous = highlightedFindingRef.current
    if (previous !== null) {
      previous.diff.clearHighlightLines(previous.row, previous.row)
      highlightedFindingRef.current = null
    }
    const diff = diffRef.current
    if (selectedFindingDiffRow === null || diff === null) return
    diff.highlightLines(selectedFindingDiffRow, selectedFindingDiffRow, {
      content: theme.accentTint,
      gutter: theme.accentTint
    })
    scrollDiffToRow(diff, selectedFindingDiffRow)
    highlightedFindingRef.current = { diff, row: selectedFindingDiffRow }
  }, [renderedDiff, selectedFile, selectedFinding, selectedFindingDiffRow, theme.accentTint])

  useLayoutEffect(() => {
    actionScrollRef.current?.scrollTo({ x: 0, y: 0 })
  }, [selectedFindingIndex])

  useEffect(() => {
    const style = SyntaxStyle.fromStyles({
      default: { fg: parseColor(theme.markdownText) },
      "markup.heading": { fg: parseColor(theme.markdownHeading), bold: true },
      "markup.link": { fg: parseColor(theme.markdownLink), underline: true },
      "markup.raw": { fg: parseColor(theme.markdownCode) },
      "markup.quote": { fg: parseColor(theme.markdownBlockQuote), italic: true },
      "markup.strong": { fg: parseColor(theme.markdownStrong), bold: true }
    })
    setSyntaxStyle(style)
    return () => style.destroy()
  }, [theme])

  const selectedFindingDisposition =
    selectedFinding === null ? "pending" : (findingDispositions[selectedFinding.id] ?? "pending")
  const selectedFindingPostDiagnostic =
    selectedFinding === null ? null : (findingPostDiagnostics[selectedFinding.id] ?? null)
  const detachedStaleFindingIds = detachedStalePublicationIds(
    reviewedFindings.map((finding) => finding.id),
    findingDispositions
  )
  const selectedFindingNeedsResolution = findingDispositionNeedsResolution(selectedFindingDisposition)
  const selectedFindingTurns =
    selectedFinding === null ? [] : conversationTurns.filter((turn) => turn.findingId === selectedFinding.id)
  const latestSelectedFindingReply = [...selectedFindingTurns]
    .reverse()
    .find((turn) => turn.role === "assistant")?.message
  const latestSessionReply =
    verificationStatus._tag === "complete"
      ? { findingId: verificationStatus.findingId, message: verificationStatus.reply }
      : conversationStatus._tag === "complete" && conversationStatus.reply !== null
        ? { findingId: conversationStatus.findingId, message: conversationStatus.reply }
        : undefined
  const selectedFindingSessionReply = relayFindingSessionReply(selectedFinding, latestSessionReply)
  const selectedFindingVerificationStatus =
    verificationStatus._tag === "complete" && relayFindingSessionReceiptMatches(selectedFinding, verificationStatus)
      ? verificationStatus
      : undefined
  const displayedFindingReply = selectedFindingSessionReply?.message ?? latestSelectedFindingReply
  const findingDeck = reviewedFindings
    .map(
      (finding, index) =>
        `${index + 1}${findingDispositionMarker(findingDispositions[finding.id] ?? "pending", index === selectedFindingIndex)}`
    )
    .join(" ")
  const conversationRunning = conversationStatus._tag === "running"
  const verificationRunning = verificationStatus._tag === "running"
  const agentRunning = conversationRunning || verificationRunning
  const actionCancelable =
    action._tag === "preflight" || action._tag === "ready" || action._tag === "running" || agentRunning
  const editorReady = workspace !== null && localEditorReady(workspace.localDiff, headEditorPath, actionCancelable)
  const reviewCardExpanded = action._tag === "reviewed"

  const openSelectedInEditor = (editor: LocalEditor) => {
    if (workspace === null || headEditorPath === null || actionCancelable) return
    if (workspace.localDiff._tag !== "ready") {
      setEditorStatus({
        _tag: "failed",
        diagnostic: {
          operation: `open-${editor}`,
          message: "A verified exact-head checkout is required before opening an editor"
        }
      })
      return
    }
    nextActionRequestSequence += 1
    const requestId = `${workspace.identity.profile}:${workspace.identity.region}:${workspace.identity.repositoryName}:${workspace.identity.pullRequestId}:${workspace.revision.sourceCommit}:editor:${editor}:${nextActionRequestSequence}`
    const lineNumber = relayFindingHeadEditorLine(selectedFinding, headEditorPath)
    setEditorStatus({ _tag: "opening", editor, requestId })
    openEditor({
      editor,
      filePath: headEditorPath,
      ...(lineNumber === undefined ? {} : { lineNumber }),
      requestId,
      worktreePath: workspace.localDiff.worktree.path
    })
  }

  const decideFinding = (disposition: "acknowledged" | "rejected") => {
    if (selectedFinding === null || !selectedFindingNeedsResolution) {
      return
    }
    const nextDispositions = { ...findingDispositions, [selectedFinding.id]: disposition }
    setFindingDispositions(nextDispositions)
    setSelectedFindingIndex(
      nextPendingFindingIndex(
        reviewedFindings.map((finding) => finding.id),
        nextDispositions,
        selectedFindingIndex
      )
    )
    setFindingPostDiagnostics((current) => {
      const next = { ...current }
      delete next[selectedFinding.id]
      return next
    })
  }

  const changeFindingTarget = (target: RelayFindingPublicationTarget) => {
    if (action._tag !== "reviewed" || selectedFinding === null) return
    const nextReview: RelayReviewResult = {
      ...action.result,
      findings: action.result.findings.map((finding) =>
        finding.id === selectedFinding.id ? { ...finding, publicationTarget: target } : finding
      )
    }
    const reconciled = reconcileRelayReviewSession(action.result, nextReview, findingDispositions)
    setFindingDispositions(reconciled.dispositions)
    setAction({ ...action, result: nextReview })
    setConversationStatus({
      _tag: "complete",
      findingId: selectedFinding.id,
      reconciliation: reconciled.reconciliation,
      reply: null
    })
  }

  const discussFinding = (message: string) => {
    if (action._tag !== "reviewed" || workspace === null || selectedFinding === null || agentRunning) return
    nextActionRequestSequence += 1
    const requestId = `${workspace.identity.profile}:${workspace.identity.region}:${workspace.identity.repositoryName}:${workspace.identity.pullRequestId}:${workspace.revision.sourceCommit}:conversation:${selectedFinding.id}:${nextActionRequestSequence}`
    const userTurn: RelayReviewConversationTurn = {
      findingId: selectedFinding.id,
      role: "user",
      message
    }
    const turns = [...conversationTurns, userTurn]
    setConversationTurns(turns)
    setVerificationStatus({ _tag: "idle" })
    setConversationStatus({
      _tag: "running",
      findingId: selectedFinding.id,
      previousReview: action.result,
      requestId
    })
    continueReview({
      currentReview: action.result,
      findingId: selectedFinding.id,
      kind: action.action,
      message,
      plan: action.plan,
      requestId,
      revision: workspace.revision,
      skills: action.reviewSkills,
      turns
    })
  }

  const verifyFinding = () => {
    if (action._tag !== "reviewed" || pr === null || workspace === null || selectedFinding === null || agentRunning)
      return
    nextActionRequestSequence += 1
    const requestId = `${workspace.identity.profile}:${workspace.identity.region}:${workspace.identity.repositoryName}:${workspace.identity.pullRequestId}:${workspace.revision.sourceCommit}:verify:${selectedFinding.id}:${nextActionRequestSequence}`
    setConversationStatus({ _tag: "idle" })
    setVerificationStatus({
      _tag: "running",
      findingId: selectedFinding.id,
      previousReview: action.result,
      previousRevision: workspace.revision,
      requestId
    })
    verifyFindingAction({
      currentReview: action.result,
      findingId: selectedFinding.id,
      kind: action.action,
      previousRevision: workspace.revision,
      pr,
      requestId,
      skills: action.reviewSkills,
      turns: conversationTurns
    })
  }

  const publishFinding = () => {
    if (
      pr === null ||
      workspace === null ||
      selectedFinding === null ||
      postingFindingRef.current !== null ||
      !selectedFindingNeedsResolution
    )
      return
    nextActionRequestSequence += 1
    const requestId = `${workspace.identity.profile}:${workspace.identity.region}:${workspace.identity.repositoryName}:${workspace.identity.pullRequestId}:${workspace.revision.sourceCommit}:finding:${selectedFindingIndex}:${nextActionRequestSequence}`
    setFindingDispositions((current) => ({ ...current, [selectedFinding.id]: "posting" }))
    setFindingPostDiagnostics((current) => {
      const next = { ...current }
      delete next[selectedFinding.id]
      return next
    })
    const nextPostingFinding = beginFindingPostSession(postingFindingRef.current, {
      findingId: selectedFinding.id,
      findingIndex: selectedFindingIndex,
      fingerprint: relayFindingFingerprint(selectedFinding),
      requestId,
      workspaceReloadKey: pullRequestWorkspaceReloadKey(pr)
    })
    setFindingPostReceipt(null)
    updatePostingFinding(nextPostingFinding)
    postFinding({
      files: workspace.files,
      finding: selectedFinding,
      findingIndex: selectedFindingIndex,
      pr,
      requestId,
      revision: workspace.revision
    })
  }

  const beginAction = (next: PendingAction) => {
    if (
      pr === null ||
      workspace === null ||
      action._tag === "running" ||
      agentRunning ||
      postingFindingRef.current !== null
    )
      return
    nextActionRequestSequence += 1
    setFindingPostReceipt(null)
    const requestId = `${workspace.identity.profile}:${workspace.identity.region}:${workspace.identity.repositoryName}:${workspace.identity.pullRequestId}:${workspace.revision.sourceCommit}:${nextActionRequestSequence}`
    const reviewSkillSnapshot = next === "worktree" ? [] : reviewSkills
    if (workspace.localDiff._tag === "ready") {
      setAction({
        _tag: "ready",
        action: next,
        plan: workspace.localDiff.plan,
        requestId,
        reviewSkills: reviewSkillSnapshot
      })
    } else {
      setAction({ _tag: "preflight", action: next, requestId, reviewSkills: reviewSkillSnapshot })
      preflight({ pr, requestId, revision: workspace.revision })
    }
  }

  useKeyboard((key) => {
    const intent = detailsKeyIntent({
      actionCancelable,
      actionReady: action._tag === "ready" && workspace !== null,
      conversationRunning: agentRunning,
      dialogOpen: dialog.current !== null,
      findingPostRunning: postingFindingRef.current !== null,
      findingReviewActive: selectedFinding !== null,
      keyName: key.name,
      modified: key.ctrl === true || key.meta === true,
      shifted: key.shift === true,
      tab
    })
    if (intent === "yield") return
    key.stopPropagation()
    if (intent === "back") setView("prs")
    else if (intent === "cancel-action") {
      if (verificationRunning) {
        verifyFindingAction(Atom.Interrupt)
        setVerificationStatus({ _tag: "idle" })
      } else if (conversationRunning) {
        continueReview(Atom.Interrupt)
        setConversationStatus({ _tag: "idle" })
      } else {
        if (action._tag === "preflight") preflight(Atom.Interrupt)
        else if (action._tag === "running" && action.action === "worktree") checkout(Atom.Interrupt)
        else if (action._tag === "running") runReview(Atom.Interrupt)
        setAction({ _tag: "idle" })
      }
    } else if (intent === "show-diff") setTab("diff")
    else if (intent === "show-comments") setTab("comments")
    else if (intent === "open-browser" && pr !== null) openPr(pr)
    else if (intent === "choose-review-skills") {
      dialog.show(() => <DialogReviewSkills onApply={setReviewSkills} selected={reviewSkills} />)
    } else if (intent === "open-neovim") openSelectedInEditor("neovim")
    else if (intent === "open-vscode") openSelectedInEditor("vscode")
    else if (intent === "previous-finding") {
      setSelectedFindingIndex((index) => adjacentFindingIndex(reviewedFindings.length, index, -1))
    } else if (intent === "next-finding") {
      setSelectedFindingIndex((index) => adjacentFindingIndex(reviewedFindings.length, index, 1))
    } else if (intent === "next-pending-finding") {
      setSelectedFindingIndex((index) =>
        nextPendingFindingIndex(
          reviewedFindings.map((finding) => finding.id),
          findingDispositions,
          index
        )
      )
    } else if (intent === "discuss-finding" && selectedFinding !== null) {
      dialog.show(() => (
        <DialogFindingConversation finding={selectedFinding} onSubmit={discussFinding} turns={conversationTurns} />
      ))
    } else if (intent === "choose-finding-target" && selectedFinding !== null) {
      dialog.show(() => <DialogFindingTarget finding={selectedFinding} onApply={changeFindingTarget} />)
    } else if (intent === "verify-finding") verifyFinding()
    else if (intent === "post-finding") publishFinding()
    else if (intent === "ack-finding") decideFinding("acknowledged")
    else if (intent === "reject-finding") decideFinding("rejected")
    else if (intent === "previous-file") {
      setSelectedFileIndex((index) => adjacentChangedFileIndex(fileTreeRows, index, -1))
    } else if (intent === "next-file") {
      setSelectedFileIndex((index) => adjacentChangedFileIndex(fileTreeRows, index, 1))
    } else if (intent === "scroll-content-up" || intent === "scroll-content-down") {
      const lines = intent === "scroll-content-up" ? -3 : 3
      scrollDiffBy(diffRef.current, lines)
      actionScrollRef.current?.scrollBy({ x: 0, y: lines })
    } else if (intent === "scroll-files-left" || intent === "scroll-files-right") {
      filesScrollRef.current?.scrollBy({ x: intent === "scroll-files-left" ? -8 : 8, y: 0 })
    } else if (intent === "checkout-worktree") beginAction("worktree")
    else if (intent === "review-pr") beginAction("review")
    else if (intent === "review-security") beginAction("security")
    else if (intent === "review-tests") beginAction("tests")
    else if (intent === "explain-risk") beginAction("explain")
    else if (intent === "confirm-action" && action._tag === "ready" && workspace !== null) {
      const ready = action
      setAction({
        _tag: "running",
        action: ready.action,
        plan: ready.plan,
        requestId: ready.requestId,
        reviewSkills: ready.reviewSkills
      })
      if (ready.action === "worktree") checkout({ plan: ready.plan, requestId: ready.requestId })
      else {
        runReview({
          kind: ready.action,
          plan: ready.plan,
          requestId: ready.requestId,
          revision: workspace.revision,
          skills: ready.reviewSkills
        })
      }
    }
  })

  if (pr === null) {
    return (
      <box alignItems="center" justifyContent="center" style={{ flexGrow: 1, width: "100%" }}>
        <text fg={theme.textMuted}>No PR selected</text>
      </box>
    )
  }

  const revision = workspace?.revision
  const humanState = exactRevisionReviewState()

  return (
    <box flexDirection="column" style={{ backgroundColor: theme.background, flexGrow: 1, width: "100%" }}>
      <box
        border={["left"]}
        borderColor={theme.primary}
        flexDirection="column"
        style={{ backgroundColor: theme.accentTint, height: 5, paddingLeft: 1, paddingRight: 1 }}
      >
        <box flexDirection="row">
          <text fg={theme.textAccent}>CODECOMMIT</text>
          <text fg={theme.textMuted}>{`  /  PR #${pr.id}  /  `}</text>
          <text fg={theme.text}>{terminalSafeCompactText(pr.repositoryName, 36)}</text>
        </box>
        <text fg={theme.text}>{terminalSafeCompactText(pr.title, 72)}</text>
        <text fg={theme.textMuted}>
          {terminalSafeCompactText(`HEAD ${pr.sourceBranch} → BASE ${pr.destinationBranch}  ·  ${pr.author}`, 72)}
        </text>
        <text fg={theme.textMuted}>
          {revision === undefined ? "Loading exact revision…" : revisionHeaderText(revision)}
        </text>
        <box flexDirection="row">
          <text fg={theme.textMuted}>HUMAN </text>
          <text fg={theme.textWarning}>{humanState.approval}</text>
          <text fg={theme.textMuted}> · MERGEABILITY </text>
          <text fg={theme.textWarning}>{humanState.mergeability}</text>
        </box>
      </box>

      <box
        border={["bottom"]}
        borderColor={theme.border}
        flexDirection="row"
        style={{ backgroundColor: theme.backgroundPanel, height: 2, paddingLeft: 2, alignItems: "center" }}
      >
        <text
          fg={tab === "diff" ? theme.textAccent : theme.textMuted}
          {...(tab === "diff" ? { bg: theme.accentTint } : {})}
        >
          {" 1  Changes "}
        </text>
        <text
          fg={tab === "comments" ? theme.textAccent : theme.textMuted}
          {...(tab === "comments" ? { bg: theme.accentTint } : {})}
        >{` 2  Comments${pr.commentCount ? ` ${pr.commentCount}` : ""} `}</text>
      </box>

      {tab === "comments" ? (
        <CommentsPanel
          pr={pr}
          revision={revision ?? null}
          syntaxStyle={syntaxStyle}
          workspaceFailed={workspaceFailed}
        />
      ) : (
        <box flexDirection="row" style={{ backgroundColor: theme.background, flexGrow: 1, width: "100%" }}>
          <box
            flexDirection="column"
            style={{
              backgroundColor: theme.backgroundPanel,
              border: true,
              borderColor: theme.border,
              flexShrink: 0,
              width: reviewCardExpanded ? "20%" : "26%"
            }}
          >
            <text fg={theme.textMuted}>{` FILES  ${workspace?.files.length ?? "…"}`}</text>
            <scrollbox
              contentOptions={{ minWidth: fileTreeContentWidth }}
              ref={filesScrollRef}
              scrollX
              scrollY
              style={{ flexGrow: 1, paddingTop: 1, width: "100%" }}
            >
              {workspace === null && !workspaceFailed && <text fg={theme.textMuted}> Loading changed files…</text>}
              {workspaceFailed && <text fg={theme.textError}> Exact-head read failed.</text>}
              {fileTreeRows.map((row) => {
                if (row._tag === "directory") {
                  return (
                    <text fg={theme.textMuted} key={row.key} truncate={false} wrapMode="none">
                      {` ${"│ ".repeat(row.depth)}▾ ${changedFileTreeVisibleName(row)}`}
                    </text>
                  )
                }
                const file = workspace?.files[row.fileIndex]
                if (file === undefined) return null
                const status =
                  file.status === "added"
                    ? "+"
                    : file.status === "deleted"
                      ? "−"
                      : file.status === "renamed"
                        ? "R"
                        : "M"
                return (
                  <text
                    {...(row.fileIndex === selectedFileIndex ? { bg: theme.selectedBackground } : {})}
                    fg={row.fileIndex === selectedFileIndex ? theme.text : theme.textMuted}
                    key={row.key}
                    id={changedFileRowId(row.fileIndex)}
                    truncate={false}
                    wrapMode="none"
                  >
                    {` ${row.fileIndex === selectedFileIndex ? "›" : " "} ${"│ ".repeat(row.depth)}${status} ${changedFileTreeVisibleName(row)}`}
                  </text>
                )
              })}
            </scrollbox>
          </box>

          <box
            flexDirection="column"
            style={{
              backgroundColor: theme.backgroundPanel,
              border: true,
              borderColor: theme.border,
              flexGrow: 1,
              flexShrink: 1,
              minWidth: 0
            }}
          >
            {selectedFile === null ? (
              <box style={{ backgroundColor: theme.backgroundElement, height: 1, paddingLeft: 1 }}>
                <text fg={theme.textMuted}>Select a changed file</text>
              </box>
            ) : (
              <box flexDirection="row" style={{ backgroundColor: theme.backgroundElement, height: 1 }}>
                <box style={{ paddingLeft: 1, width: "50%" }}>
                  <text fg={theme.textError}>{terminalSafeCompactText(`BASE · ${beforePath}`, 36)}</text>
                </box>
                <box border={["left"]} borderColor={theme.borderStrong} style={{ paddingLeft: 1, width: "50%" }}>
                  <text fg={theme.textSuccess}>{terminalSafeCompactText(`HEAD · ${afterPath}`, 36)}</text>
                </box>
              </box>
            )}
            {selectedFile !== null && diffOutcome === null && (
              <text fg={theme.textMuted}>
                {workspace?.localDiff._tag === "ready"
                  ? " Loading local immutable diff…"
                  : " Loading provider fallback diff…"}
              </text>
            )}
            {diffFailed && <text fg={theme.textError}> Unable to load this file preview.</text>}
            {renderedDiff?.binary && (
              <text fg={theme.textMuted}> Binary file changed. Checkout the worktree to inspect it locally.</text>
            )}
            {renderedDiff !== null && !renderedDiff.binary && renderedDiff.truncated && (
              <text fg={theme.textWarning}>
                Diff preview bounded to complete hunks. Checkout the exact head for omitted content.
              </text>
            )}
            {renderedDiff !== null && !renderedDiff.binary && renderedDiff.diff.length === 0 && (
              <text fg={renderedDiff.metadata === null ? theme.textMuted : theme.textAccent}>
                {renderedDiff.metadata === null
                  ? " This change is too large for a safe terminal preview."
                  : ` ${terminalSafeMultilineText(renderedDiff.metadata)}`}
              </text>
            )}
            {renderedDiff !== null && !renderedDiff.binary && renderedDiff.diff.length > 0 && renderedDiff.metadata && (
              <text fg={theme.textAccent}>{` ${terminalSafeMultilineText(renderedDiff.metadata)}`}</text>
            )}
            {renderedDiff !== null && !renderedDiff.binary && renderedDiff.diff.length > 0 && (
              <diff
                addedBg={theme.successTint}
                addedLineNumberBg={theme.successTint}
                addedSignColor={theme.textSuccess}
                contextBg={theme.backgroundPanel}
                diff={renderedDiff.diff}
                ref={diffRef}
                fg={theme.text}
                {...(renderedDiff.filetype === undefined ? {} : { filetype: renderedDiff.filetype })}
                lineNumberBg={theme.backgroundElement}
                lineNumberFg={theme.textMuted}
                removedBg={theme.errorTint}
                removedLineNumberBg={theme.errorTint}
                removedSignColor={theme.textError}
                showLineNumbers
                style={{ flexGrow: 1, width: "100%" }}
                syncScroll
                {...(syntaxStyle === null ? {} : { syntaxStyle })}
                view="split"
                wrapMode="none"
              />
            )}
          </box>

          <box
            flexDirection="column"
            style={{
              border: true,
              backgroundColor: theme.backgroundPanel,
              borderColor: theme.border,
              flexShrink: 0,
              paddingLeft: 1,
              paddingRight: 1,
              width: reviewCardExpanded ? "36%" : "22%"
            }}
          >
            {!reviewCardExpanded && (
              <>
                <text fg={theme.textMuted}>OPEN SELECTED</text>
                <ActionKey active={editorReady} keyName="n" label="Neovim" />
                <ActionKey active={editorReady} keyName="v" label="VS Code" />
                {editorStatus._tag === "opening" && (
                  <text
                    fg={theme.textWarning}
                  >{`Opening ${editorStatus.editor === "neovim" ? "Neovim" : "VS Code"}…`}</text>
                )}
                {editorStatus._tag === "done" && (
                  <text fg={theme.textSuccess}>
                    {editorStatus.editor === "neovim" ? "Returned from Neovim" : "Opened in VS Code"}
                  </text>
                )}
                {editorStatus._tag === "failed" && (
                  <text fg={theme.textError}>
                    {terminalSafeText(`${editorStatus.diagnostic.operation}: ${editorStatus.diagnostic.message}`)}
                  </text>
                )}
                <box style={{ height: 1 }} />
                <text fg={theme.textMuted}>RELAY</text>
                <text fg={theme.text}>{"Exact head · local Codex"}</text>
                <ActionKey active={!actionCancelable} keyName="g" label="Skills" />
                <text fg={theme.textAccent}>{`${reviewSkills.length} SELECTED`}</text>
                {workspace?.localDiff._tag === "ready" ? (
                  <text fg={theme.textSuccess}>DIFF · LOCAL GIT</text>
                ) : workspace?.localDiff._tag === "unavailable" ? (
                  <text fg={theme.textWarning}>DIFF · PROVIDER FALLBACK</text>
                ) : (
                  <text fg={theme.textMuted}>DIFF · PREPARING LOCAL HEAD</text>
                )}
                <box style={{ height: 1 }} />
                <ActionKey active={action._tag !== "idle" && action.action === "review"} keyName="r" label="Review" />
                <ActionKey
                  active={action._tag !== "idle" && action.action === "security"}
                  keyName="s"
                  label="Security"
                />
                <ActionKey active={action._tag !== "idle" && action.action === "tests"} keyName="t" label="Tests" />
                <ActionKey active={action._tag !== "idle" && action.action === "explain"} keyName="e" label="Risk" />
                <ActionKey
                  active={action._tag !== "idle" && action.action === "worktree"}
                  keyName="w"
                  label="Worktree"
                />
                <box style={{ height: 1 }} />
              </>
            )}
            {action._tag === "idle" && (
              <text fg={theme.textMuted}>Read-only sandbox. Human approval stays separate.</text>
            )}
            {findingPostReceipt === null ? null : (
              <box
                border={["left"]}
                borderColor={findingPostReceipt.status === "failed" ? theme.error : theme.warning}
                flexDirection="column"
                style={{ paddingLeft: 1 }}
              >
                <text fg={findingPostReceipt.status === "failed" ? theme.textError : theme.textWarning}>
                  {`${findingPostReceipt.status === "failed" ? "POST FAILED" : "STALE PROVIDER POST"} · ${findingPostReceipt.findingId}`}
                </text>
                <text fg={theme.textMuted}>{terminalSafeMultilineText(findingPostReceipt.message)}</text>
              </box>
            )}
            {action._tag === "preflight" && (
              <text fg={theme.textWarning}>{`Preparing ${actionLabel(action.action)} preflight…`}</text>
            )}
            {action._tag === "ready" && (
              <box flexDirection="column">
                <text fg={theme.textWarning}>{`${actionLabel(action.action)} · READY`}</text>
                <text fg={theme.textMuted}>{`head ${action.plan.sourceCommit.slice(0, 12)}`}</text>
                <text fg={theme.textMuted}>
                  {action.plan.targetExists ? "validate existing worktree" : "create detached worktree"}
                </text>
                <text fg={theme.textMuted}>{terminalSafeText(action.plan.targetPath)}</text>
                {action.action !== "worktree" && <text fg={theme.textMuted}>sandbox read-only · local Codex</text>}
                {action.action !== "worktree" && (
                  <text fg={theme.textAccent}>{terminalSafeText(relayReviewSkillsLabel(action.reviewSkills))}</text>
                )}
                <text fg={theme.textSuccess}>Enter run · x cancel</text>
              </box>
            )}
            {action._tag === "running" && (
              <box flexDirection="column">
                <text fg={theme.textWarning}>{`${actionLabel(action.action)} · RUNNING…`}</text>
                {action.action !== "worktree" && (
                  <text fg={theme.textAccent}>{terminalSafeText(relayReviewSkillsLabel(action.reviewSkills))}</text>
                )}
                <text fg={theme.textMuted}>Esc/x cancel</text>
              </box>
            )}
            {action._tag === "failed" && (
              <scrollbox ref={actionScrollRef} style={{ flexGrow: 1, width: "100%" }}>
                <text
                  fg={theme.textError}
                >{`${actionLabel(action.action)} failed · ${terminalSafeText(action.diagnostic.operation)}`}</text>
                <text fg={theme.textMuted}>{terminalSafeMultilineText(action.diagnostic.message)}</text>
              </scrollbox>
            )}
            {action._tag === "done" && (
              <scrollbox ref={actionScrollRef} style={{ flexGrow: 1, width: "100%" }}>
                <text fg={theme.textSuccess}>{`${actionLabel(action.action)} · COMPLETE`}</text>
                <text fg={theme.text}>{terminalSafeMultilineText(action.detail)}</text>
              </scrollbox>
            )}
            {action._tag === "reviewed" && (
              <scrollbox ref={actionScrollRef} style={{ flexGrow: 1, width: "100%" }}>
                <box flexDirection="row">
                  <text fg={theme.textSuccess}>{`${actionLabel(action.action)} · COMPLETE`}</text>
                  <text fg={theme.textMuted}>{`  ${action.result.findings.length} findings`}</text>
                </box>
                <text fg={theme.textMuted}>{terminalSafeText(relayReviewSkillsLabel(action.reviewSkills))}</text>
                <box flexDirection="row">
                  <ActionKey active={!agentRunning} keyName="g" label="Skills" />
                  <ActionKey active={!agentRunning} keyName="r" label="Rerun" />
                  <ActionKey active={editorReady} keyName="n/v" label="Open" />
                </box>
                {detachedStaleFindingIds.map((findingId) => {
                  const diagnostic = findingPostDiagnostics[findingId]
                  return (
                    <box
                      border={["left"]}
                      borderColor={theme.warning}
                      flexDirection="column"
                      key={findingId}
                      style={{ paddingLeft: 1 }}
                    >
                      <text fg={theme.textWarning}>{`STALE PROVIDER POST · ${findingId} · FINDING REMOVED`}</text>
                      <text fg={theme.textWarning}>
                        {terminalSafeText(detachedStalePublicationDiagnostic(diagnostic))}
                      </text>
                    </box>
                  )
                })}
                {selectedFinding === null ? (
                  <box flexDirection="column" style={{ paddingTop: 1 }}>
                    <text fg={theme.textSuccess}>No actionable findings</text>
                    <text fg={theme.text}>{terminalSafeMultilineText(action.result.verdict)}</text>
                    {conversationStatus._tag === "complete" && (
                      <text fg={theme.textAccent}>
                        {`RECONCILED  ${relayReviewReconciliationLabel(conversationStatus.reconciliation)}`}
                      </text>
                    )}
                    {verificationStatus._tag === "complete" && (
                      <box flexDirection="column">
                        <text fg={verificationStatus.outcome === "resolved" ? theme.textSuccess : theme.textWarning}>
                          {`VERIFIED · ${verificationOutcomeLabel(verificationStatus.outcome)} · ${verificationStatus.headChanged ? "NEW HEAD" : "SAME HEAD"}`}
                        </text>
                        <text fg={theme.textAccent}>
                          {`RECONCILED  ${relayReviewReconciliationLabel(verificationStatus.reconciliation)}`}
                        </text>
                      </box>
                    )}
                    {latestSessionReply === undefined ? null : (
                      <box
                        border={["left"]}
                        borderColor={theme.primary}
                        flexDirection="column"
                        style={{ paddingLeft: 1 }}
                      >
                        <text fg={theme.textSuccess}>
                          {verificationStatus._tag === "complete"
                            ? `LATEST VERIFICATION · ${latestSessionReply.findingId}`
                            : `LATEST SESSION REPLY · ${latestSessionReply.findingId}`}
                        </text>
                        <text fg={theme.text}>{terminalSafeMultilineText(latestSessionReply.message)}</text>
                      </box>
                    )}
                  </box>
                ) : (
                  <box flexDirection="column" style={{ paddingTop: 1 }}>
                    <box flexDirection="row" style={{ backgroundColor: theme.backgroundRaised }}>
                      <text
                        fg={theme.textAccent}
                      >{` ${selectedFindingIndex + 1}/${action.result.findings.length} `}</text>
                      <text fg={theme.textMuted}>{terminalSafeCompactText(findingDeck, 32)}</text>
                    </box>
                    <box flexDirection="row">
                      <ActionKey active keyName="[" label="Prev" />
                      <ActionKey active keyName="]" label="Next" />
                      <ActionKey active keyName="u" label="Unresolved" />
                    </box>
                    <text
                      fg={
                        selectedFinding.priority === "P1" || selectedFinding.priority === "P2"
                          ? theme.textError
                          : selectedFinding.priority === "P3"
                            ? theme.textWarning
                            : theme.textAccent
                      }
                    >
                      {`${selectedFinding.id} · ${selectedFinding.priority} · ${relayReviewPriorityLabel(selectedFinding.priority)}`}
                    </text>
                    <box flexDirection="row">
                      <text bg={theme.accentTint} fg={theme.textAccent}>
                        {` ${relayFindingPublicationLabel(selectedFinding.publicationTarget).toUpperCase()} `}
                      </text>
                      <text fg={theme.textMuted}> {"·"} </text>
                      <text fg={theme.textMuted}>{terminalSafeText(relayFindingAnchor(selectedFinding))}</text>
                    </box>
                    {selectedFinding.location.scope === "line" ? (
                      <box
                        border={["left"]}
                        borderColor={theme.primary}
                        flexDirection="column"
                        style={{ backgroundColor: theme.accentTint, paddingLeft: 1 }}
                      >
                        <box flexDirection="row">
                          <text fg={theme.textAccent}>{`LINE ${selectedFinding.location.line}`}</text>
                          <text fg={theme.textMuted}> {" · "} </text>
                          <text fg={selectedFinding.location.side === "after" ? theme.textSuccess : theme.textError}>
                            {selectedFinding.location.side === "after" ? "HEAD / AFTER" : "BASE / BEFORE"}
                          </text>
                        </box>
                        <text fg={theme.text}>{terminalSafeText(selectedFinding.location.filePath)}</text>
                        <text fg={selectedFindingDiffRow === null ? theme.textWarning : theme.textAccent}>
                          {selectedFindingDiffRow === null
                            ? "↳ exact line is outside the bounded preview"
                            : "↳ focused and highlighted in the split diff"}
                        </text>
                      </box>
                    ) : null}
                    <text fg={theme.text}>{terminalSafeText(selectedFinding.title)}</text>
                    <text fg={theme.textMuted}>SUMMARY</text>
                    <text fg={theme.text}>{terminalSafeMultilineText(selectedFinding.summary)}</text>
                    <text fg={theme.textMuted}>DETAILS</text>
                    <text fg={theme.textMuted}>{terminalSafeMultilineText(selectedFinding.details)}</text>
                    <text fg={theme.textMuted}>RECOMMENDATION</text>
                    <text fg={theme.text}>{terminalSafeMultilineText(selectedFinding.recommendation)}</text>
                    <text fg={theme.textMuted}>VERIFICATION</text>
                    <text fg={theme.textAccent}>{terminalSafeMultilineText(selectedFinding.verification)}</text>
                    <box style={{ height: 1 }} />
                    <box flexDirection="row">
                      <ActionKey active={!agentRunning} keyName="m" label="Target" />
                      <ActionKey active={!agentRunning} keyName="d" label="Discuss" />
                      <ActionKey active={!agentRunning} keyName="V" label="Verify" />
                      <text fg={theme.textMuted}>{` ${selectedFindingTurns.length} turns`}</text>
                    </box>
                    {conversationStatus._tag === "running" && (
                      <text
                        fg={theme.textWarning}
                      >{`Relay is reconsidering the full deck from ${conversationStatus.findingId}…`}</text>
                    )}
                    {conversationStatus._tag === "failed" && (
                      <text fg={theme.textError}>
                        {terminalSafeText(
                          `${conversationStatus.diagnostic.operation}: ${conversationStatus.diagnostic.message}`
                        )}
                      </text>
                    )}
                    {conversationStatus._tag === "complete" && (
                      <text fg={theme.textAccent}>
                        {`RECONCILED  ${relayReviewReconciliationLabel(conversationStatus.reconciliation)}`}
                      </text>
                    )}
                    {verificationStatus._tag === "running" && (
                      <text fg={theme.textWarning}>
                        {`Refreshing the provider head and verifying ${verificationStatus.findingId}…`}
                      </text>
                    )}
                    {verificationStatus._tag === "failed" && (
                      <text fg={theme.textError}>
                        {terminalSafeText(
                          `${verificationStatus.diagnostic.operation}: ${verificationStatus.diagnostic.message}`
                        )}
                      </text>
                    )}
                    {selectedFindingVerificationStatus !== undefined && (
                      <box flexDirection="column">
                        <text
                          fg={
                            selectedFindingVerificationStatus.outcome === "resolved"
                              ? theme.textSuccess
                              : theme.textWarning
                          }
                        >
                          {`VERIFIED · ${verificationOutcomeLabel(selectedFindingVerificationStatus.outcome)} · ${selectedFindingVerificationStatus.headChanged ? "NEW HEAD" : "SAME HEAD"}`}
                        </text>
                        <text fg={theme.textAccent}>
                          {`RECONCILED  ${relayReviewReconciliationLabel(selectedFindingVerificationStatus.reconciliation)}`}
                        </text>
                      </box>
                    )}
                    {displayedFindingReply === undefined ? null : (
                      <box
                        border={["left"]}
                        borderColor={theme.primary}
                        flexDirection="column"
                        style={{ paddingLeft: 1 }}
                      >
                        <text fg={theme.textSuccess}>
                          {selectedFindingSessionReply === undefined
                            ? "LATEST RELAY REPLY"
                            : verificationStatus._tag === "complete"
                              ? `LATEST VERIFICATION · ${selectedFindingSessionReply.findingId}`
                              : `LATEST SESSION REPLY · ${selectedFindingSessionReply.findingId}`}
                        </text>
                        <text fg={theme.text}>{terminalSafeMultilineText(displayedFindingReply)}</text>
                      </box>
                    )}
                    <box style={{ height: 1 }} />
                    <text
                      fg={
                        selectedFindingDisposition === "failed"
                          ? theme.textError
                          : selectedFindingDisposition === "rejected"
                            ? theme.textMuted
                            : selectedFindingDisposition === "pending" || selectedFindingDisposition === "posted-stale"
                              ? theme.textWarning
                              : theme.textSuccess
                      }
                    >{`STATE  ${selectedFindingDisposition.toUpperCase()}`}</text>
                    {selectedFindingPostDiagnostic !== null &&
                      (selectedFindingDisposition === "failed" || selectedFindingDisposition === "posted-stale") && (
                        <text fg={selectedFindingDisposition === "failed" ? theme.textError : theme.textWarning}>
                          {terminalSafeText(
                            `${selectedFindingPostDiagnostic.operation}: ${selectedFindingPostDiagnostic.message}`
                          )}
                        </text>
                      )}
                    <box flexDirection="row">
                      <ActionKey
                        active={!agentRunning && selectedFindingNeedsResolution}
                        keyName="p"
                        label={selectedFinding.publicationTarget === "description" ? "Add" : "Post"}
                      />
                      <ActionKey active={!agentRunning && selectedFindingNeedsResolution} keyName="a" label="Ack" />
                      <ActionKey active={!agentRunning && selectedFindingNeedsResolution} keyName="x" label="Reject" />
                    </box>
                  </box>
                )}
              </scrollbox>
            )}
          </box>
        </box>
      )}
    </box>
  )
}
