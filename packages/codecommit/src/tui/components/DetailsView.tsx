import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Domain } from "@knpkv/codecommit-core"
import { parseColor, SyntaxStyle } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import { useEffect, useMemo, useRef, useState } from "react"
import type { RelayReviewKind } from "../../RelayReview.js"
import type { WorktreePlan } from "../../WorktreeService.js"
import { fetchPrCommentsAtom, openPrAtom } from "../atoms/actions.js"
import { type AppState, appStateAtom } from "../atoms/app.js"
import {
  checkoutWorktreeAtom,
  loadFileDiffAtom,
  loadPullRequestWorkspaceAtom,
  preflightWorktreeAtom,
  runRelayReviewAtom
} from "../atoms/details.js"
import {
  changedFilePath,
  detailsKeyIntent,
  exactRevisionReviewState,
  fileDiffIdentity,
  fileDiffIdentityMatches,
  pullRequestWorkspaceIdentity,
  workspaceIdentityMatches
} from "../details-model.js"
import { selectedPrIdAtom, viewAtom } from "../atoms/ui.js"
import { useDialog } from "../context/dialog.js"
import { useTheme } from "../context/theme.js"
import { Badge } from "./Badge.js"

const defaultState: AppState = { status: "loading", pullRequests: [], accounts: [] }
const emptyCommentLocations = (): Array<Domain.PRCommentLocation> => []
let nextActionRequestSequence = 0

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
        >{`${depth > 0 ? "│" : "┌"} ${thread.root.author} · ${formatRelativeDate(thread.root.creationDate)}`}</text>
      )}
      {thread.root.deleted ? null : syntaxStyle ? (
        <markdown content={thread.root.content} syntaxStyle={syntaxStyle} style={{ paddingLeft: 2, width: "100%" }} />
      ) : (
        <text fg={theme.text} style={{ paddingLeft: 2 }}>
          {thread.root.content}
        </text>
      )}
      {thread.replies.map((reply) => (
        <CommentThread depth={depth + 1} key={reply.root.id} syntaxStyle={syntaxStyle} thread={reply} />
      ))}
    </box>
  )
}

function CommentsPanel({
  pr,
  syntaxStyle
}: {
  readonly pr: Domain.PullRequest
  readonly syntaxStyle: SyntaxStyle | null
}) {
  const { theme } = useTheme()
  const fetchComments = useAtomSet(fetchPrCommentsAtom)
  const result = useAtomValue(fetchPrCommentsAtom)
  const fetchedRef = useRef<string | null>(null)
  const expectedIdentity = pullRequestWorkspaceIdentity(pr)
  const requestKey = `${expectedIdentity.profile}:${expectedIdentity.region}:${expectedIdentity.repositoryName}:${expectedIdentity.pullRequestId}`
  useEffect(() => {
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
  const comments = commentsResult ?? emptyCommentLocations()
  return (
    <scrollbox focused style={{ flexGrow: 1, padding: 2, width: "100%" }}>
      {commentsResult === null && <text fg={theme.textMuted}>Loading review thread…</text>}
      {commentsResult !== null && comments.length === 0 && <text fg={theme.textMuted}>No comments</text>}
      {comments.map((location, locationIndex) => (
        <box
          flexDirection="column"
          key={`${location.filePath ?? "general"}-${locationIndex}`}
          style={{ paddingBottom: 1 }}
        >
          <text fg={theme.textAccent}>{location.filePath ?? "General review"}</text>
          {location.comments.map((thread) => (
            <CommentThread depth={0} key={thread.root.id} syntaxStyle={syntaxStyle} thread={thread} />
          ))}
        </box>
      ))}
    </scrollbox>
  )
}

type PendingAction = "worktree" | RelayReviewKind
type ActionStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "preflight"; readonly action: PendingAction; readonly requestId: string }
  | { readonly _tag: "ready"; readonly action: PendingAction; readonly plan: WorktreePlan; readonly requestId: string }
  | {
      readonly _tag: "running"
      readonly action: PendingAction
      readonly plan: WorktreePlan
      readonly requestId: string
    }
  | { readonly _tag: "done"; readonly action: PendingAction; readonly detail: string }
  | { readonly _tag: "failed"; readonly action: PendingAction }

const actionLabel = (action: PendingAction): string =>
  ({
    review: "Review PR",
    security: "Security pass",
    tests: "Review tests",
    explain: "Explain risk",
    worktree: "Checkout worktree"
  })[action]

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
    <text fg={active ? theme.textWarning : theme.textMuted}>
      <span fg={active ? theme.textWarning : theme.textAccent}>{keyName}</span>
      {` ${label}`}
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
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [tab, setTab] = useState<"comments" | "diff">("diff")
  const [action, setAction] = useState<ActionStatus>({ _tag: "idle" })
  const [syntaxStyle, setSyntaxStyle] = useState<SyntaxStyle | null>(null)

  const pr = useMemo(
    () =>
      selectedPrId === null ? null : (appState.pullRequests.find((candidate) => candidate.id === selectedPrId) ?? null),
    [appState.pullRequests, selectedPrId]
  )
  const workspaceCandidate =
    AsyncResult.isSuccess(workspaceResult) && !AsyncResult.isWaiting(workspaceResult) ? workspaceResult.value : null
  const expectedWorkspaceIdentity = pr === null ? null : pullRequestWorkspaceIdentity(pr)
  const workspace =
    workspaceCandidate !== null &&
    expectedWorkspaceIdentity !== null &&
    workspaceIdentityMatches(workspaceCandidate.identity, expectedWorkspaceIdentity) &&
    workspaceCandidate.revision.pullRequestId === expectedWorkspaceIdentity.pullRequestId &&
    workspaceCandidate.revision.repositoryName === expectedWorkspaceIdentity.repositoryName
      ? workspaceCandidate
      : null
  const selectedFile = workspace?.files[selectedFileIndex] ?? null
  const selectedPath = selectedFile === null ? null : changedFilePath(selectedFile)
  const expectedFileIdentity =
    workspace === null || selectedFile === null
      ? null
      : fileDiffIdentity(workspace.identity, workspace.revision, selectedFile)
  const renderedDiff =
    AsyncResult.isSuccess(diffResult) &&
    !AsyncResult.isWaiting(diffResult) &&
    expectedFileIdentity !== null &&
    fileDiffIdentityMatches(diffResult.value.identity, expectedFileIdentity)
      ? diffResult.value
      : null

  useEffect(() => {
    if (pr === null) return
    setSelectedFileIndex(0)
    setTab("diff")
    setAction({ _tag: "idle" })
    loadWorkspace(pr)
  }, [loadWorkspace, pr])

  useEffect(() => {
    if (pr === null || workspace === null || selectedFile === null) return
    loadDiff({
      account: pr.account,
      file: selectedFile,
      identity: workspace.identity,
      repositoryName: workspace.revision.repositoryName,
      revision: workspace.revision
    })
  }, [loadDiff, pr, selectedFile, workspace])

  useEffect(() => {
    if (action._tag !== "preflight" || AsyncResult.isWaiting(preflightResult) || workspace === null) return
    if (!AsyncResult.isSuccess(preflightResult)) return
    const outcome = preflightResult.value
    if (outcome.requestId !== action.requestId) return
    if (outcome._tag === "failure") {
      setAction({ _tag: "failed", action: action.action })
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
    setAction({ _tag: "ready", action: action.action, plan, requestId: action.requestId })
  }, [action, pr, preflightResult, workspace])

  useEffect(() => {
    if (action._tag !== "running" || action.action !== "worktree" || AsyncResult.isWaiting(checkoutResult)) return
    if (!AsyncResult.isSuccess(checkoutResult) || checkoutResult.value.requestId !== action.requestId) return
    const outcome = checkoutResult.value
    if (outcome._tag === "failure") {
      setAction({ _tag: "failed", action: "worktree" })
      return
    }
    if (outcome.value.path === action.plan.targetPath && outcome.value.sourceCommit === action.plan.sourceCommit) {
      setAction({ _tag: "done", action: "worktree", detail: outcome.value.path })
    }
  }, [action, checkoutResult])

  useEffect(() => {
    if (action._tag !== "running" || action.action === "worktree" || AsyncResult.isWaiting(reviewResult)) return
    if (!AsyncResult.isSuccess(reviewResult) || reviewResult.value.requestId !== action.requestId) return
    const outcome = reviewResult.value
    if (outcome._tag === "failure") {
      setAction({ _tag: "failed", action: action.action })
      return
    }
    if (
      outcome.value.kind === action.action &&
      outcome.value.worktree.path === action.plan.targetPath &&
      outcome.value.worktree.sourceCommit === action.plan.sourceCommit
    ) {
      setAction({ _tag: "done", action: action.action, detail: outcome.value.summary })
    }
  }, [action, reviewResult])

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

  const beginAction = (next: PendingAction) => {
    if (pr === null || workspace === null || action._tag === "running") return
    nextActionRequestSequence += 1
    const requestId = `${workspace.identity.profile}:${workspace.identity.region}:${workspace.identity.repositoryName}:${workspace.identity.pullRequestId}:${workspace.revision.sourceCommit}:${nextActionRequestSequence}`
    setAction({ _tag: "preflight", action: next, requestId })
    preflight({ pr, requestId, revision: workspace.revision })
  }

  useKeyboard((key) => {
    const intent = detailsKeyIntent({
      actionCancelable: action._tag !== "idle",
      actionReady: action._tag === "ready" && workspace !== null,
      dialogOpen: dialog.current !== null,
      keyName: key.name,
      modified: key.ctrl === true || key.meta === true,
      tab
    })
    if (intent === "yield") return
    key.stopPropagation()
    if (intent === "back") setView("prs")
    else if (intent === "cancel-action") {
      if (action._tag === "preflight") preflight(Atom.Interrupt)
      else if (action._tag === "running" && action.action === "worktree") checkout(Atom.Interrupt)
      else if (action._tag === "running") runReview(Atom.Interrupt)
      setAction({ _tag: "idle" })
    } else if (intent === "show-diff") setTab("diff")
    else if (intent === "show-comments") setTab("comments")
    else if (intent === "open-browser" && pr !== null) openPr(pr)
    else if (intent === "previous-file") {
      setSelectedFileIndex((index) => Math.max(0, index - 1))
    } else if (intent === "next-file") {
      setSelectedFileIndex((index) => Math.min(Math.max(0, (workspace?.files.length ?? 1) - 1), index + 1))
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
        requestId: ready.requestId
      })
      if (ready.action === "worktree") checkout({ plan: ready.plan, requestId: ready.requestId })
      else {
        runReview({
          kind: ready.action,
          plan: ready.plan,
          requestId: ready.requestId,
          revision: workspace.revision
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
    <box flexDirection="column" style={{ backgroundColor: theme.backgroundPanel, flexGrow: 1, width: "100%" }}>
      <box
        flexDirection="column"
        style={{ backgroundColor: theme.backgroundElement, height: 4, paddingLeft: 2, paddingRight: 2 }}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textAccent}>{`${pr.repositoryName}  PR #${pr.id}  ${pr.title}`}</text>
          <box flexDirection="row">
            <text fg={theme.textMuted}>{`APPROVAL ${humanState.approval}`}</text>
            <text fg={theme.textMuted}> · </text>
            <text fg={theme.textMuted}>{`MERGEABILITY ${humanState.mergeability}`}</text>
          </box>
        </box>
        <text fg={theme.textMuted}>{`${pr.sourceBranch} → ${pr.destinationBranch}  ·  ${pr.author}`}</text>
        <text fg={theme.textMuted}>
          {revision === undefined
            ? "Loading exact revision…"
            : `head ${revision.sourceCommit.slice(0, 12)}  ·  base ${revision.destinationCommit.slice(0, 12)}  ·  revision ${revision.revisionId.slice(0, 10)}`}
        </text>
      </box>

      <box flexDirection="row" style={{ height: 2, paddingLeft: 2, alignItems: "center" }}>
        <Badge minWidth={10} variant={tab === "diff" ? "info" : "neutral"}>
          1 Changes
        </Badge>
        <box style={{ width: 1 }} />
        <Badge
          minWidth={14}
          variant={tab === "comments" ? "info" : "neutral"}
        >{`2 Comments${pr.commentCount ? ` (${pr.commentCount})` : ""}`}</Badge>
      </box>

      {tab === "comments" ? (
        <CommentsPanel pr={pr} syntaxStyle={syntaxStyle} />
      ) : (
        <box flexDirection="row" style={{ flexGrow: 1, width: "100%" }}>
          <box flexDirection="column" style={{ border: true, borderColor: theme.backgroundElement, width: "25%" }}>
            <text fg={theme.textMuted}>{` FILES · ${workspace?.files.length ?? "…"}`}</text>
            <scrollbox style={{ flexGrow: 1, width: "100%" }}>
              {workspace === null && !AsyncResult.isFailure(workspaceResult) && (
                <text fg={theme.textMuted}> Loading changed files…</text>
              )}
              {AsyncResult.isFailure(workspaceResult) && <text fg={theme.textError}> Exact-head read failed.</text>}
              {workspace?.files.map((file, index) => {
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
                    {...(index === selectedFileIndex ? { bg: theme.selectedBackground } : {})}
                    fg={index === selectedFileIndex ? theme.selectedText : theme.textMuted}
                    key={`${changedFilePath(file)}-${index}`}
                  >
                    {` ${status} ${changedFilePath(file)}`}
                  </text>
                )
              })}
            </scrollbox>
          </box>

          <box flexDirection="column" style={{ border: true, borderColor: theme.backgroundElement, flexGrow: 1 }}>
            <text fg={theme.textAccent}>{` ${selectedPath ?? "Select a changed file"}`}</text>
            {selectedFile !== null && renderedDiff === null && (
              <text fg={theme.textMuted}> Loading immutable blobs…</text>
            )}
            {AsyncResult.isFailure(diffResult) && <text fg={theme.textError}> Unable to load this file preview.</text>}
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
                  : ` ${renderedDiff.metadata}`}
              </text>
            )}
            {renderedDiff !== null && !renderedDiff.binary && renderedDiff.diff.length > 0 && (
              <diff
                addedSignColor={theme.textSuccess}
                diff={renderedDiff.diff}
                fg={theme.text}
                {...(renderedDiff.filetype === undefined ? {} : { filetype: renderedDiff.filetype })}
                removedSignColor={theme.textError}
                showLineNumbers
                style={{ flexGrow: 1, width: "100%" }}
                {...(syntaxStyle === null ? {} : { syntaxStyle })}
                view="unified"
                wrapMode="none"
              />
            )}
          </box>

          <box
            flexDirection="column"
            style={{
              border: true,
              borderColor: theme.backgroundElement,
              paddingLeft: 1,
              paddingRight: 1,
              width: "28%"
            }}
          >
            <text fg={theme.text}>ACTIONS · EXACT HEAD</text>
            <ActionKey active={action._tag !== "idle" && action.action === "review"} keyName="r" label="Review PR" />
            <ActionKey
              active={action._tag !== "idle" && action.action === "security"}
              keyName="s"
              label="Security pass"
            />
            <ActionKey active={action._tag !== "idle" && action.action === "tests"} keyName="t" label="Review tests" />
            <ActionKey
              active={action._tag !== "idle" && action.action === "explain"}
              keyName="e"
              label="Explain risk"
            />
            <ActionKey
              active={action._tag !== "idle" && action.action === "worktree"}
              keyName="w"
              label="Checkout worktree"
            />
            <box style={{ height: 1 }} />
            {action._tag === "idle" && (
              <text fg={theme.textMuted}>
                Relay uses local Codex in a read-only sandbox. Human approval stays separate.
              </text>
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
                <text fg={theme.textMuted}>{action.plan.targetPath}</text>
                {action.action !== "worktree" && <text fg={theme.textMuted}>sandbox read-only · local Codex</text>}
                <text fg={theme.textSuccess}>Enter run · x cancel</text>
              </box>
            )}
            {action._tag === "running" && (
              <box flexDirection="column">
                <text fg={theme.textWarning}>{`${actionLabel(action.action)} · RUNNING…`}</text>
                <text fg={theme.textMuted}>Esc/x cancel</text>
              </box>
            )}
            {action._tag === "failed" && <text fg={theme.textError}>{`${actionLabel(action.action)} failed.`}</text>}
            {action._tag === "done" && (
              <scrollbox style={{ flexGrow: 1, width: "100%" }}>
                <text fg={theme.textSuccess}>{`${actionLabel(action.action)} · COMPLETE`}</text>
                <text fg={theme.text}>{action.detail}</text>
              </scrollbox>
            )}
          </box>
        </box>
      )}
    </box>
  )
}
