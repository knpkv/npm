import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { parseColor, SyntaxStyle } from "@opentui/core"
import type { Domain } from "@knpkv/codecommit-core"
import { DateUtils } from "@knpkv/codecommit-core"
import { calculateHealthScore, getScoreTier, type HealthScore } from "@knpkv/codecommit-core/HealthScore.js"
import { Option } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import { type AppState, appStateAtom } from "../atoms/app.js"
import { fetchPrCommentsAtom } from "../atoms/actions.js"
import { selectedPrIdAtom, showDetailsCommentsAtom } from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"
import { Badge } from "./Badge.js"
import { StatusRow } from "./StatusRow.js"

const defaultState: AppState = {
  status: "loading",
  pullRequests: [],
  accounts: []
}

const formatRelativeDate = (date: Date): string => {
  const abs = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return `${abs} \u00B7 just now`
  if (diffMins < 60) return `${abs} \u00B7 ${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${abs} \u00B7 ${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${abs} \u00B7 ${diffDays}d ago`
}

const earliestLocDate = (loc: Domain.PRCommentLocation): number =>
  loc.comments.length === 0 ? 0 : Math.min(...loc.comments.map((t) => t.root.creationDate.getTime()))

const countThread = (t: Domain.CommentThread): number => 1 + t.replies.reduce((sum, r) => sum + countThread(r), 0)

function CommentThread({
  thread,
  depth,
  syntaxStyle
}: {
  readonly thread: Domain.CommentThread
  readonly depth: number
  readonly syntaxStyle: SyntaxStyle | null
}) {
  const { theme } = useTheme()
  const indent = depth * 2
  const prefix = depth > 0 ? "\u2502 ".repeat(depth) : "\u250C "

  if (thread.root.deleted) return null

  return (
    <box flexDirection="column" style={{ paddingLeft: indent }}>
      <text
        fg={theme.textMuted}
      >{`${prefix}${thread.root.author} \u00B7 ${formatRelativeDate(thread.root.creationDate)}`}</text>
      {syntaxStyle ? (
        <markdown
          style={{ width: "100%", paddingLeft: indent + 2 }}
          syntaxStyle={syntaxStyle}
          content={thread.root.content}
        />
      ) : (
        <text fg={theme.text} style={{ paddingLeft: indent + 2 }}>
          {thread.root.content}
        </text>
      )}
      {thread.replies.map((reply) => (
        <CommentThread key={reply.root.id} thread={reply} depth={depth + 1} syntaxStyle={syntaxStyle} />
      ))}
    </box>
  )
}

function CommentsSection({
  pr,
  syntaxStyle
}: {
  readonly pr: Domain.PullRequest
  readonly syntaxStyle: SyntaxStyle | null
}) {
  const { theme } = useTheme()
  const fetchComments = useAtomSet(fetchPrCommentsAtom)
  const commentsResult = useAtomValue(fetchPrCommentsAtom)
  const fetchedRef = useRef<string | null>(null)

  useEffect(() => {
    if (fetchedRef.current === pr.id) return
    fetchedRef.current = pr.id
    fetchComments(pr)
  }, [pr, fetchComments])

  const loading = Result.isInitial(commentsResult)
  const comments = Result.getOrElse(commentsResult, () => [] as Array<Domain.PRCommentLocation>)
  const totalCount = comments.reduce((sum, loc) => sum + loc.comments.reduce((s, t) => s + countThread(t), 0), 0)

  return (
    <box flexDirection="column">
      {loading && <text fg={theme.textMuted}>Loading comments...</text>}
      {comments.length === 0 && !loading && <text fg={theme.textMuted}>No comments</text>}
      {!loading &&
        totalCount > 0 &&
        [...comments]
          .sort((a, b) => earliestLocDate(b) - earliestLocDate(a))
          .map((loc, i) => (
            <box key={i} flexDirection="column" style={{ paddingBottom: 1 }}>
              {loc.filePath && <text fg={theme.textAccent}>{loc.filePath}</text>}
              {loc.comments.map((thread) => (
                <CommentThread key={thread.root.id} thread={thread} depth={0} syntaxStyle={syntaxStyle} />
              ))}
            </box>
          ))}
    </box>
  )
}

/**
 * PR details view showing full PR information
 * @category components
 */
export function DetailsView() {
  const { theme } = useTheme()
  const selectedPrId = useAtomValue(selectedPrIdAtom)
  const appStateResult = useAtomValue(appStateAtom)
  const appState = Result.getOrElse(appStateResult, () => defaultState)
  const showComments = useAtomValue(showDetailsCommentsAtom)
  const setShowComments = useAtomSet(showDetailsCommentsAtom)

  // Find PR by ID directly - stable even when items reorder
  const pr = useMemo(() => {
    if (!selectedPrId) return null
    return appState.pullRequests.find((p) => p.id === selectedPrId) ?? null
  }, [selectedPrId, appState.pullRequests])
  const [syntaxStyle, setSyntaxStyle] = useState<SyntaxStyle | null>(null)

  const score: HealthScore | undefined = useMemo(
    () => (pr ? Option.getOrUndefined(calculateHealthScore(pr, new Date())) : undefined),
    [pr]
  )
  const tier = score ? getScoreTier(score.total) : undefined
  const scoreBadgeVariant =
    tier === "green"
      ? ("success" as const)
      : tier === "yellow"
        ? ("warning" as const)
        : tier === undefined
          ? ("neutral" as const)
          : ("error" as const)

  // Reset comments visibility on PR change
  useEffect(() => {
    if (selectedPrId) setShowComments(false)
  }, [selectedPrId, setShowComments])

  useEffect(() => {
    const style = SyntaxStyle.fromStyles({
      default: { fg: parseColor(theme.markdownText) },
      "markup.heading": { fg: parseColor(theme.markdownHeading), bold: true },
      "markup.link": { fg: parseColor(theme.markdownLink), underline: true },
      "markup.link.label": { fg: parseColor(theme.markdownLinkText), underline: true },
      "markup.link.url": { fg: parseColor(theme.markdownLink), underline: true },
      "markup.raw": { fg: parseColor(theme.markdownCode) },
      "markup.quote": { fg: parseColor(theme.markdownBlockQuote), italic: true },
      "punctuation.special": { fg: parseColor(theme.markdownBlockQuote) },
      "markup.strong": { fg: parseColor(theme.markdownStrong), bold: true },
      "markup.bold": { fg: parseColor(theme.markdownStrong), bold: true },
      "markup.italic": { fg: parseColor(theme.markdownEmph), italic: true },
      "markup.list": { fg: parseColor(theme.markdownListItem) }
    })
    setSyntaxStyle(style)
    return () => style.destroy()
  }, [theme])

  if (!pr) {
    return (
      <box
        style={{
          flexGrow: 1,
          width: "100%",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.backgroundPanel
        }}
      >
        <text fg={theme.textMuted}>No PR selected</text>
      </box>
    )
  }

  const commentLabel =
    pr.commentCount !== undefined && pr.commentCount > 0 ? `Comments (${pr.commentCount})` : "Comments"

  return (
    <box
      style={{
        flexGrow: 1,
        width: "100%",
        flexDirection: "column",
        backgroundColor: theme.backgroundPanel
      }}
    >
      <box
        style={{
          height: 3,
          width: "100%",
          backgroundColor: theme.backgroundPanel,
          paddingLeft: 2,
          paddingRight: 2,
          justifyContent: "center",
          alignItems: "center"
        }}
      >
        <text fg={theme.textAccent}>{`  PR: ${pr.repositoryName} > ${pr.title}`}</text>
      </box>
      <box flexDirection="row" style={{ paddingLeft: 2, paddingBottom: 1, alignItems: "center" }}>
        <Badge variant={!showComments ? "info" : "neutral"} minWidth={8}>
          1 Info
        </Badge>
        <box style={{ width: 1 }} />
        <Badge variant={showComments ? "info" : "neutral"} minWidth={16}>{`2 ${commentLabel}`}</Badge>
      </box>
      <box style={{ paddingLeft: 2 }}>
        <text fg={theme.textMuted}>{"\u2500".repeat(42)}</text>
      </box>
      <scrollbox
        focused
        style={{
          flexGrow: 1,
          width: "100%",
          padding: 2,
          rootOptions: { backgroundColor: theme.backgroundPanel },
          viewportOptions: { backgroundColor: theme.backgroundPanel },
          contentOptions: { backgroundColor: theme.backgroundPanel }
        }}
      >
        {!showComments ? (
          <box flexDirection="column">
            <StatusRow label="Score:">
              <Badge variant={scoreBadgeVariant} minWidth={14}>
                {score ? score.total.toFixed(1) : "---"}
              </Badge>
            </StatusRow>
            <StatusRow label="Merge:">
              {!pr.isMergeable ? (
                <Badge variant="error" minWidth={14}>
                  CONFLICT
                </Badge>
              ) : (
                <Badge variant="success" minWidth={14}>
                  MERGEABLE
                </Badge>
              )}
            </StatusRow>
            <StatusRow label="Approval:">
              {pr.isApproved ? (
                <Badge variant="success" minWidth={14}>
                  APPROVED
                </Badge>
              ) : (
                <Badge variant="neutral" minWidth={14}>
                  PENDING
                </Badge>
              )}
            </StatusRow>
            <StatusRow label="State:">
              <text fg={theme.text}>{pr.status.toUpperCase()}</text>
            </StatusRow>

            <box style={{ height: 1 }} />

            <StatusRow label="Author:">
              <text fg={theme.text}>{pr.author}</text>
            </StatusRow>
            <StatusRow label="Created:">
              <text fg={theme.text}>{DateUtils.formatDateTime(pr.creationDate)}</text>
            </StatusRow>
            <StatusRow label="Branch:">
              <text fg={theme.text}>{`${pr.sourceBranch} -> ${pr.destinationBranch}`}</text>
            </StatusRow>

            <box style={{ height: 1 }} />
            <text fg={theme.textMuted}>{"\u2500".repeat(42)}</text>
            <box style={{ height: 1 }} />

            <text fg={theme.text}>DESCRIPTION</text>
            <box style={{ height: 1 }} />
            {syntaxStyle && (
              <markdown
                style={{ width: "100%" }}
                syntaxStyle={syntaxStyle}
                content={pr.description || "No description provided."}
              />
            )}

            <box style={{ height: 1 }} />
            <text fg={theme.textMuted}>{"\u2500".repeat(42)}</text>
            <box style={{ height: 1 }} />

            <text fg={theme.text}>LINK</text>
            <text fg={theme.textAccent}>{`URL: ${pr.link}`}</text>
          </box>
        ) : (
          <CommentsSection key={pr.id} pr={pr} syntaxStyle={syntaxStyle} />
        )}
      </scrollbox>
    </box>
  )
}
