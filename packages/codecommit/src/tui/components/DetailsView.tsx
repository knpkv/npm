import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Domain } from "@knpkv/codecommit-core"
import { parseColor, SyntaxStyle } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
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
import { changedFilePath } from "../details-model.js"
import { selectedPrIdAtom, viewAtom } from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"
import { Badge } from "./Badge.js"

const defaultState: AppState = { status: "loading", pullRequests: [], accounts: [] }
const emptyCommentLocations = (): Array<Domain.PRCommentLocation> => []

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
  if (thread.root.deleted) return null
  return (
    <box flexDirection="column" style={{ paddingLeft: depth * 2 }}>
      <text
        fg={theme.textMuted}
      >{`${depth > 0 ? "│" : "┌"} ${thread.root.author} · ${formatRelativeDate(thread.root.creationDate)}`}</text>
      {syntaxStyle ? (
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
  useEffect(() => {
    if (fetchedRef.current === pr.id) return
    fetchedRef.current = pr.id
    fetchComments(pr)
  }, [fetchComments, pr])
  const comments = AsyncResult.getOrElse(result, emptyCommentLocations)
  return (
    <scrollbox focused style={{ flexGrow: 1, padding: 2, width: "100%" }}>
      {AsyncResult.isInitial(result) && <text fg={theme.textMuted}>Loading review thread…</text>}
      {!AsyncResult.isInitial(result) && comments.length === 0 && <text fg={theme.textMuted}>No comments</text>}
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
  | { readonly _tag: "preflight"; readonly action: PendingAction }
  | { readonly _tag: "ready"; readonly action: PendingAction; readonly plan: WorktreePlan }
  | { readonly _tag: "running"; readonly action: PendingAction }
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
  const workspace =
    AsyncResult.isSuccess(workspaceResult) && !AsyncResult.isWaiting(workspaceResult) ? workspaceResult.value : null
  const selectedFile = workspace?.files[selectedFileIndex] ?? null
  const selectedPath = selectedFile === null ? null : changedFilePath(selectedFile)
  const renderedDiff =
    AsyncResult.isSuccess(diffResult) && !AsyncResult.isWaiting(diffResult) && diffResult.value.path === selectedPath
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
    loadDiff({ account: pr.account, file: selectedFile, repositoryName: workspace.revision.repositoryName })
  }, [loadDiff, pr, selectedFile, workspace])

  useEffect(() => {
    if (action._tag !== "preflight" || AsyncResult.isWaiting(preflightResult) || workspace === null) return
    if (AsyncResult.isFailure(preflightResult)) {
      setAction({ _tag: "failed", action: action.action })
      return
    }
    if (!AsyncResult.isSuccess(preflightResult)) return
    if (preflightResult.value.sourceCommit !== workspace.revision.sourceCommit) return
    setAction({ _tag: "ready", action: action.action, plan: preflightResult.value })
  }, [action, preflightResult, workspace])

  useEffect(() => {
    if (action._tag !== "running" || action.action !== "worktree" || AsyncResult.isWaiting(checkoutResult)) return
    if (AsyncResult.isSuccess(checkoutResult)) {
      setAction({ _tag: "done", action: "worktree", detail: checkoutResult.value.path })
    } else if (AsyncResult.isFailure(checkoutResult)) {
      setAction({ _tag: "failed", action: "worktree" })
    }
  }, [action, checkoutResult])

  useEffect(() => {
    if (action._tag !== "running" || action.action === "worktree" || AsyncResult.isWaiting(reviewResult)) return
    if (AsyncResult.isSuccess(reviewResult)) {
      setAction({ _tag: "done", action: action.action, detail: reviewResult.value.summary })
    } else if (AsyncResult.isFailure(reviewResult)) {
      setAction({ _tag: "failed", action: action.action })
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
    setAction({ _tag: "preflight", action: next })
    preflight({ pr, revision: workspace.revision })
  }

  useKeyboard((key) => {
    key.stopPropagation()
    if (key.name === "escape") {
      if (action._tag === "preflight" || action._tag === "ready") setAction({ _tag: "idle" })
      else setView("prs")
      return
    }
    if (key.name === "1") setTab("diff")
    else if (key.name === "2" || key.name === "c") setTab("comments")
    else if (key.name === "o" && pr !== null) openPr(pr)
    else if (tab === "diff" && (key.name === "up" || key.name === "k")) {
      setSelectedFileIndex((index) => Math.max(0, index - 1))
    } else if (tab === "diff" && (key.name === "down" || key.name === "j")) {
      setSelectedFileIndex((index) => Math.min(Math.max(0, (workspace?.files.length ?? 1) - 1), index + 1))
    } else if (key.name === "w") beginAction("worktree")
    else if (key.name === "r") beginAction("review")
    else if (key.name === "s") beginAction("security")
    else if (key.name === "t") beginAction("tests")
    else if (key.name === "e") beginAction("explain")
    else if (key.name === "x" && action._tag !== "running") setAction({ _tag: "idle" })
    else if (key.name === "return" && action._tag === "ready" && workspace !== null) {
      const ready = action
      setAction({ _tag: "running", action: ready.action })
      if (ready.action === "worktree") checkout(ready.plan)
      else runReview({ kind: ready.action, plan: ready.plan, revision: workspace.revision })
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
  const humanState = pr.isApproved ? "APPROVED" : pr.isMergeable ? "NEEDS REVIEW" : "BLOCKED"
  const statusColor = pr.isApproved ? theme.textSuccess : pr.isMergeable ? theme.textWarning : theme.textError

  return (
    <box flexDirection="column" style={{ backgroundColor: theme.backgroundPanel, flexGrow: 1, width: "100%" }}>
      <box
        flexDirection="column"
        style={{ backgroundColor: theme.backgroundElement, height: 4, paddingLeft: 2, paddingRight: 2 }}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textAccent}>{`${pr.repositoryName}  PR #${pr.id}  ${pr.title}`}</text>
          <text fg={statusColor}>{humanState}</text>
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
            {renderedDiff !== null && !renderedDiff.binary && (
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
              <text fg={theme.textWarning}>{`${actionLabel(action.action)} · RUNNING…`}</text>
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
