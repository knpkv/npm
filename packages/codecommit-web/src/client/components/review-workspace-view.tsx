/** Controlled recorded review body. Header, navigation, diff reads and retry lifetime stay host-owned. @module */
import {
  reviewRunReadingForWorkspace,
  reviewWorkspaceThreads,
  type ReviewRun,
  type ReviewThread,
  type ReviewWorkspace
} from "@knpkv/review"
import { PatchDiffView } from "@knpkv/rly/diff/patch"
import { Result, type DateTime } from "effect"
import { useId, type ReactElement, type ReactNode } from "react"
import { reviewThreadElementId, type ReviewThreadTarget } from "../review-thread-target.js"
import { reviewReadingTime } from "../review-reading-time.js"
import { reviewRunProvenance } from "../review-run-provenance.js"
import {
  placeCurrentReviewFindings,
  placeReviewConversations,
  type ReviewDiffPlacementError,
  type ReviewParsedDiff
} from "../review-diff-placement.js"
import { ReviewDifferentRevisionView } from "./review-different-revision-view.js"
import { ReviewFindingCard } from "./review-finding-card.js"
import findingStyles from "./review-finding-card.module.css"
import { ReviewFindingsIndexView, type ReviewFindingsIndexViewProps } from "./review-findings-index-view.js"
import type { ReviewReadAgainActions } from "./review-read-again-button.js"
import { ReviewSummaryView } from "./review-summary-view.js"
import { ReviewThreadMessagesView } from "./review-thread-messages-view.js"
import { ReviewThreadsFallbackView } from "./review-threads-fallback-view.js"
import { ReviewWorkspaceNotices } from "./review-workspace-notices.js"
import styles from "./review-workspace-view.module.css"
import statusStyles from "./review-status-views.module.css"

export interface ReviewWorkspaceViewProps extends ReviewReadAgainActions {
  readonly workspace: ReviewWorkspace
  readonly presentation: "review" | "conversation"
  /** Unique owner scope. The view also includes subject and presentation in each thread target. */
  readonly scope: string
  /** Host resets expansion on subject/revision change, including DifferentRevision -> Current. */
  readonly secondary: ReviewFindingsIndexViewProps["secondary"]
  /** Hub hrefs retain the module route; standalone may use a fragment of the supplied element id. */
  readonly hrefForThread: (thread: ReviewThreadTarget, elementId: string) => string
  /** Own deliberate selection/focus through the shell; modified clicks keep normal link behavior. */
  readonly onOpenThread?: ((thread: ReviewThreadTarget, elementId: string) => void) | undefined
  readonly timeZone?: DateTime.TimeZone.Named | undefined
  /** Host-owned inventory, loading and rejected-file content, retained even when placement fails. */
  readonly diff: ReactNode
  /**
   * Exact bounded parsed files rendered below the host slot. Current findings place once globally;
   * DifferentRevision findings and conflicted threads never annotate lines. A typed placement failure keeps raw diff
   * and separate cards, and must be presented by the host's renderer, never hidden as clean output.
   */
  readonly parsedDiff?:
    | {
        readonly parsed: ReviewParsedDiff
        readonly renderFailure: (error: ReviewDiffPlacementError) => ReactElement
      }
    | undefined
}

const sourceWords = { agent: "Agent review", codecommit: "CodeCommit", slack: "Slack" } satisfies Record<
  ReviewThread["source"],
  string
>

function ThreadCard({
  findingReference,
  scope,
  thread,
  timeZone
}: {
  readonly scope: string
  readonly thread: ReviewThread
  readonly timeZone: DateTime.TimeZone.Named | undefined
  readonly findingReference?: { readonly href: string; readonly onOpen: (() => void) | undefined } | undefined
}): ReactElement {
  const heading = useId()
  const anchor = thread.anchor
  return (
    <article
      aria-labelledby={heading}
      className={styles.thread}
      data-review-thread-outdated={anchor._tag !== "Unanchored" && anchor.outdated ? "" : undefined}
      id={reviewThreadElementId(scope, thread)}
      tabIndex={-1}
    >
      <header className={styles.meta}>
        <h3 id={heading}>{sourceWords[thread.source]}</h3>
        {anchor._tag === "Unanchored" ? (
          <span>Whole pull request</span>
        ) : (
          <code>
            {anchor.path}
            {anchor._tag === "Line" ? `:${anchor.line}` : ""}
          </code>
        )}
        {anchor._tag === "Line" && anchor.side === "before" ? <span>Before change</span> : null}
        {anchor._tag !== "Unanchored" && anchor.outdated ? (
          <span data-review-thread-status="outdated">Outdated</span>
        ) : null}
        {thread.resolved ? <span>Thread resolved</span> : null}
      </header>
      {thread.finding !== null && findingReference !== undefined ? (
        <a
          className={styles.findingReference}
          title={thread.finding.claim}
          href={findingReference.href}
          onClick={(event) => {
            if (
              findingReference.onOpen === undefined ||
              event.button !== 0 ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return
            event.preventDefault()
            findingReference.onOpen()
          }}
        >
          <span className={findingStyles.severity} data-severity={thread.finding.severity}>
            {thread.finding.severity}
          </span>
          <span>{thread.finding.claim}</span>
        </a>
      ) : null}
      <ReviewThreadMessagesView messages={thread.messages} timeZone={timeZone} />
    </article>
  )
}

function AgentSummary({
  run,
  timeZone
}: {
  readonly run: ReviewRun
  readonly timeZone: DateTime.TimeZone.Named | undefined
}): ReactElement {
  const heading = useId()
  const time = reviewReadingTime(run.completedAt, timeZone)
  return (
    <article aria-labelledby={heading} className={styles.thread} data-review-agent-summary="recorded">
      <header className={styles.meta}>
        <h3 id={heading}>Agent summary</h3>
      </header>
      <p className={styles.verdict}>{run.summary}</p>
      <div className={statusStyles.provenance}>
        <span>{reviewRunProvenance(run)}</span>
        <small>
          <time dateTime={time.iso} title={time.full}>
            {time.clock}
          </time>
        </small>
      </div>
    </article>
  )
}

/**
 * Render decoded same-subject readings without provider or command clients. The host's focusTarget
 * must remain mounted and focusable across Loading/Retained/Failed/Ready, outside this body.
 * A conflict keeps recorded summary/diff and refuses every joined row. No inferred avatars or actions.
 */
export function ReviewWorkspaceView({
  diff,
  focusTarget,
  hrefForThread,
  onOpenThread,
  onReadAgain,
  parsedDiff,
  presentation,
  scope,
  secondary,
  timeZone,
  workspace
}: ReviewWorkspaceViewProps): ReactElement {
  const diffId = useId()
  const joined = reviewWorkspaceThreads(workspace)
  const run = reviewRunReadingForWorkspace(workspace)
  const threadScope = JSON.stringify([scope, workspace.identity.subjectId, presentation])
  const findings = Result.isSuccess(joined)
    ? [...joined.success.primary, ...(secondary.open ? joined.success.secondary : [])]
    : []
  const placement =
    parsedDiff !== undefined && run._tag === "Current" && Result.isSuccess(joined)
      ? placeCurrentReviewFindings(run, parsedDiff.parsed)
      : null
  const placed = placement !== null && Result.isSuccess(placement) ? placement.success.placed : []
  const visibleFindings = new Set(findings.map((row) => row.thread))
  const placedThreads = new Set(placed.map((row) => row.row.thread))
  const conversations = Result.isSuccess(joined) ? joined.success.conversations : []
  // Joined rows retain both origins for display. Only a current run may lend its anchors to current lines.
  const currentConversations = [
    ...(run._tag === "Current" ? run.run.threads : []),
    ...(workspace.conversations._tag === "Ready" ? workspace.conversations.threads : [])
  ].filter((thread) => thread.finding === null)
  const conversationPlacement =
    parsedDiff !== undefined && Result.isSuccess(joined) && currentConversations.length > 0
      ? placeReviewConversations(workspace.identity, currentConversations, parsedDiff.parsed)
      : null
  const placedConversations =
    conversationPlacement !== null && Result.isSuccess(conversationPlacement) ? conversationPlacement.success : []
  const placedConversationThreads = new Set(placedConversations.map((entry) => entry.thread))
  const placementFailure =
    placement !== null && Result.isFailure(placement)
      ? placement.failure
      : conversationPlacement !== null && Result.isFailure(conversationPlacement)
        ? conversationPlacement.failure
        : null
  const discussion = Result.isSuccess(joined)
    ? [
        ...(workspace.run._tag === "Ready" ? workspace.run.run.threads : []),
        ...(workspace.conversations._tag === "Ready" ? workspace.conversations.threads : [])
      ].filter((thread) => thread.finding === null || thread.messages.length > 0)
    : []
  const unresolved = discussion.filter((thread) => !thread.resolved).length
  const card = (row: (typeof findings)[number]) => (
    <div className={styles.record} key={reviewThreadElementId(threadScope, row.thread)}>
      <ReviewFindingCard row={row} scope={threadScope} />
      <ReviewThreadMessagesView messages={row.thread.messages} timeZone={timeZone} />
    </div>
  )
  const conversationCard = (thread: ReviewThread) => (
    <ThreadCard
      key={reviewThreadElementId(threadScope, thread)}
      scope={threadScope}
      thread={thread}
      timeZone={timeZone}
    />
  )
  const retainedThreads = new Set(run._tag === "DifferentRevision" ? run.run.threads : [])
  const unplaced = findings.filter((row) => !placedThreads.has(row.thread))
  const retainedCards = unplaced.filter((row) => retainedThreads.has(row.thread)).map(card)
  const cards = unplaced.filter((row) => !retainedThreads.has(row.thread)).map(card)
  const commentsInIndex =
    presentation === "review" &&
    workspace.run._tag === "Ready" &&
    workspace.conversations._tag === "Unavailable" &&
    Result.isSuccess(joined) &&
    joined.success.primary.length + joined.success.secondary.length + joined.success.conversations.length > 0
  const notices = commentsInIndex ? null : (
    <ReviewWorkspaceNotices
      workspace={workspace}
      presentation={presentation}
      focusTarget={focusTarget}
      onReadAgain={onReadAgain}
    />
  )
  return (
    <div className={styles.workspace} data-review-presentation={presentation}>
      {presentation === "review" ? (
        <>
          <div className={styles.column}>
            {run._tag === "DifferentRevision" ? <ReviewDifferentRevisionView reading={run} /> : null}
            {run._tag === "Current" || run._tag === "DifferentRevision" ? (
              <ReviewSummaryView run={run.run} threads={joined} timeZone={timeZone} />
            ) : null}
            {notices}
            {Result.isSuccess(joined) ? (
              <ReviewFindingsIndexView
                notice={
                  commentsInIndex && workspace.conversations._tag === "Unavailable" ? (
                    <ReviewThreadsFallbackView
                      heading={false}
                      presentation="review"
                      problem={workspace.conversations}
                      focusTarget={focusTarget}
                      onReadAgain={onReadAgain}
                    />
                  ) : null
                }
                findings={joined.success}
                threads={joined.success}
                scope={threadScope}
                secondary={secondary}
                hrefForThread={(thread) => hrefForThread(thread, reviewThreadElementId(threadScope, thread))}
                onOpenThread={
                  onOpenThread === undefined
                    ? undefined
                    : (thread) => onOpenThread(thread, reviewThreadElementId(threadScope, thread))
                }
              />
            ) : null}
          </div>
          <div className={styles.column}>
            {retainedCards.length > 0 ? (
              <section className={styles.conversation} aria-label="Recorded findings">
                <h2 className={styles.heading}>Recorded findings</h2>
                <div className={styles.unplaced}>{retainedCards}</div>
              </section>
            ) : null}
            <section aria-label="Diff" className={styles.column} data-code-review-diff="">
              {diff}
              {placementFailure !== null ? parsedDiff?.renderFailure(placementFailure) : null}
              {parsedDiff?.parsed.files.map(({ file, index }, occurrence) => (
                <section className={styles.diffFile} key={`${index}-${occurrence}`}>
                  <h3 className={styles.fileHeading}>{file.path}</h3>
                  <PatchDiffView
                    file={file}
                    wrap
                    id={`${diffId}-${index}-${occurrence}`}
                    renderAnnotation={(side, line) => {
                      const annotations = [
                        ...placed
                          .filter(
                            (entry) =>
                              entry.fileIndex === index &&
                              entry.side === side &&
                              entry.line === line &&
                              visibleFindings.has(entry.row.thread)
                          )
                          .map((entry) => card(entry.row)),
                        ...placedConversations
                          .filter((entry) => entry.fileIndex === index && entry.side === side && entry.line === line)
                          .map((entry) => conversationCard(entry.thread))
                      ]
                      return annotations.length === 0 ? null : annotations
                    }}
                  />
                </section>
              ))}
            </section>
            {cards.length > 0 ? (
              <section className={styles.conversation} aria-label="Not tied to a line">
                <header className={styles.groupHeading}>
                  <h2 className={styles.heading}>Not tied to a line</h2>
                  <small data-finding-group-count="">{cards.length}</small>
                </header>
                <div className={styles.unplaced}>{cards}</div>
              </section>
            ) : null}
            {conversations.filter((thread) => !placedConversationThreads.has(thread)).map(conversationCard)}
          </div>
        </>
      ) : (
        <section aria-label="Conversation" className={styles.conversation}>
          {Result.isSuccess(joined) && workspace.conversations._tag === "Ready" ? (
            <header className={styles.feedHeading}>
              <h2 className={styles.heading}>Conversation</h2>
              {joined.success.total._tag === "Exact" && unresolved > 0 ? <small>Unresolved {unresolved}</small> : null}
            </header>
          ) : null}
          {notices}
          {Result.isSuccess(joined) && workspace.run._tag === "Ready" && workspace.run.run.summary.length > 0 ? (
            <AgentSummary run={workspace.run.run} timeZone={timeZone} />
          ) : null}
          {discussion.map((thread) => {
            const reviewId = reviewThreadElementId(
              JSON.stringify([scope, workspace.identity.subjectId, "review"]),
              thread
            )
            return (
              <ThreadCard
                key={reviewThreadElementId(threadScope, thread)}
                scope={threadScope}
                thread={thread}
                timeZone={timeZone}
                findingReference={
                  thread.finding === null
                    ? undefined
                    : {
                        href: hrefForThread(thread, reviewId),
                        onOpen: onOpenThread === undefined ? undefined : () => onOpenThread(thread, reviewId)
                      }
                }
              />
            )
          })}
        </section>
      )}
    </div>
  )
}
