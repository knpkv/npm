import type { CommentThreadJsonEncoded } from "@knpkv/codecommit-core/Domain.js"
import { StatePanel, Text } from "@knpkv/rly/primitives"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { CodeIcon } from "lucide-react"
import { useEffect, useRef } from "react"
import Markdown from "react-markdown"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"
import type { useComments } from "../hooks/useComments.js"
import {
  reviewCommentNavigationTarget,
  type ReviewCommentNavigation,
  type ReviewCommentNavigationTarget
} from "../review-comment-navigation.js"
import type { CommentCountSnapshot, PRCommentsViewProps } from "./pr-detail-view.js"
import { Separator } from "./ui/separator.js"
import styles from "./pr-detail.module.css"

export type PRCommentsResult = ReturnType<typeof useComments>
export type { PRCommentsViewProps } from "./pr-detail-view.js"

const formatRelativeDate = (dateStr: string, now: Date): string => {
  const date = new Date(dateStr)
  const abs = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return `${abs}, just now`
  if (diffMins < 60) return `${abs}, ${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${abs}, ${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${abs}, ${diffDays}d ago`
}

const earliestDate = (loc: { readonly comments: ReadonlyArray<CommentThreadJsonEncoded> }): number => {
  if (loc.comments.length === 0) return 0
  return Math.min(...loc.comments.map((t) => new Date(t.root.creationDate).getTime()))
}

const countThread = (thread: CommentThreadJsonEncoded): number =>
  1 + thread.replies.reduce((sum, reply) => sum + countThread(reply), 0)

const countVisibleThread = (thread: CommentThreadJsonEncoded): number =>
  thread.root.deleted ? 0 : 1 + thread.replies.reduce((sum, reply) => sum + countVisibleThread(reply), 0)

const commentIdsInThread = (thread: CommentThreadJsonEncoded): ReadonlyArray<string> => [
  thread.root.id,
  ...thread.replies.flatMap(commentIdsInThread)
]

function CommentsCountReporter({
  onCountChange,
  snapshot
}: {
  readonly snapshot: CommentCountSnapshot
  readonly onCountChange: (snapshot: CommentCountSnapshot) => void
}) {
  const lastSnapshotKeyRef = useRef("")
  useEffect(() => {
    const snapshotKey = `${String(snapshot.count)}:${snapshot.commentIds.join("\u0000")}`
    if (lastSnapshotKeyRef.current === snapshotKey) return
    lastSnapshotKeyRef.current = snapshotKey
    onCountChange(snapshot)
  })
  return null
}

interface CommentLocationCoordinates {
  readonly afterCommitId?: string | undefined
  readonly beforeCommitId?: string | undefined
  readonly filePath?: string | undefined
  readonly relativeFileVersion?: "AFTER" | "BEFORE" | undefined
}

function CommentThread({
  depth,
  location,
  navigation,
  now,
  onNavigateToDiff,
  thread,
  visible
}: {
  readonly now: Date
  readonly thread: CommentThreadJsonEncoded
  readonly depth: number
  readonly location: CommentLocationCoordinates
  readonly navigation: ReviewCommentNavigation | null
  readonly onNavigateToDiff: (target: ReviewCommentNavigationTarget) => void
  readonly visible: boolean
}) {
  const target = depth === 0 ? reviewCommentNavigationTarget(location, thread.root) : null
  const active = navigation?.destination === "comment" && navigation.target.commentId === thread.root.id
  const articleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!active || !visible || articleRef.current === null) return
    articleRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    articleRef.current.focus({ preventScroll: true })
  }, [active, visible])

  if (thread.root.deleted) return null

  return (
    <article
      className={depth > 0 ? styles.commentReply : styles.comment}
      data-active={active ? "true" : undefined}
      ref={articleRef}
      tabIndex={active ? -1 : undefined}
    >
      <div className={styles.commentBody}>
        <div className={styles.commentMeta}>
          <span>
            <strong>{thread.root.author}</strong>,{" "}
            <time dateTime={thread.root.creationDate}>{formatRelativeDate(thread.root.creationDate, now)}</time>
          </span>
          {target === null ? null : (
            <button className={styles.commentJump} onClick={() => onNavigateToDiff(target)} type="button">
              <CodeIcon aria-hidden="true" /> View in diff
            </button>
          )}
        </div>
        <div
          className={`${styles.markdown ?? ""} prose prose-sm dark:prose-invert max-w-none break-words [&_a]:text-primary [&_img]:inline [&_img]:h-5 [&_img]:w-auto`}
        >
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
            {thread.root.content}
          </Markdown>
        </div>
      </div>
      {thread.replies.map((reply) => (
        <CommentThread
          depth={depth + 1}
          key={reply.root.id}
          location={location}
          navigation={navigation}
          now={now}
          onNavigateToDiff={onNavigateToDiff}
          thread={reply}
          visible={visible}
        />
      ))}
    </article>
  )
}

export function PRCommentsView({
  comments,
  navigation,
  now,
  onCountChange,
  onNavigateToDiff,
  visible
}: PRCommentsViewProps) {
  return AsyncResult.builder(comments)
    .onInitialOrWaiting(() => (
      <StatePanel
        announce="polite"
        description="Reading the current CodeCommit conversation."
        title="Loading comments"
        tone="progress"
      />
    ))
    .onFailure(() => (
      <StatePanel
        announce="polite"
        description="Refresh the pull request to try reading the conversation again."
        title="Comments unavailable"
        tone="critical"
      />
    ))
    .onSuccess((comments) => {
      const totalCount = comments.reduce((sum, loc) => sum + loc.comments.reduce((s, t) => s + countThread(t), 0), 0)
      const commentIds = comments.flatMap((location) => location.comments.flatMap(commentIdsInThread)).sort()
      const visibleCount = comments.reduce(
        (sum, loc) => sum + loc.comments.reduce((locationSum, thread) => locationSum + countVisibleThread(thread), 0),
        0
      )

      return (
        <div className={styles.comments}>
          <CommentsCountReporter onCountChange={onCountChange} snapshot={{ commentIds, count: totalCount }} />
          {comments.length === 0 && (
            <Text tone="secondary" variant="meta">
              No comments
            </Text>
          )}
          {visibleCount > 0 && (
            <div className={styles.commentLocations}>
              {[...comments]
                .sort((a, b) => earliestDate(b) - earliestDate(a))
                .map((loc, i) => (
                  <section className={styles.commentLocation} key={loc.filePath ?? `loc-${i}`}>
                    {loc.filePath !== undefined && loc.filePath.length > 0 && (
                      <code className={styles.commentPath}>{loc.filePath}</code>
                    )}
                    {loc.comments.map((thread) => (
                      <CommentThread
                        depth={0}
                        key={thread.root.id}
                        location={loc}
                        navigation={navigation}
                        now={now}
                        onNavigateToDiff={onNavigateToDiff}
                        thread={thread}
                        visible={visible}
                      />
                    ))}
                    {i < comments.length - 1 && <Separator className="my-2" />}
                  </section>
                ))}
            </div>
          )}
        </div>
      )
    })
    .exhaustive()
}
