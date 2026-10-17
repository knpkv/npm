/** Read-only finding navigation. Severity grouping stays with the decoded thread projection. @module */
import { useCommitWords } from "@knpkv/review/react"
import { StateLabel } from "@knpkv/rly/primitives"
import type { ReviewFindingRow, ReviewWorkspaceThreads } from "@knpkv/review"
import { useEffect, useId, useState, type ReactElement, type ReactNode } from "react"
import { reviewThreadElementId, type ReviewThreadTarget } from "../review-thread-target.js"
import {
  fixedCommit,
  reviewConfidenceWords,
  reviewDispositionText,
  reviewDispositionTones
} from "./review-finding-words.js"
import styles from "./review-findings-index-view.module.css"

export interface ReviewFindingsIndexViewProps {
  /** Read-only comments notice after the filters, before available rows; its host still owns retry. */
  readonly notice?: ReactNode
  readonly findings: Pick<ReviewWorkspaceThreads, "primary" | "secondary">
  /** Include recorded discussions and complete-set counts. Absent preserves the findings-only index. */
  readonly threads?: Pick<ReviewWorkspaceThreads, "total" | "conversations"> | undefined
  /** Same unique workspace/presentation scope as the target cards. */
  readonly scope: string
  /**
   * The host owns expansion, including history/fragment navigation to a secondary finding. Set
   * open before focusing its card; changing this pair never replaces the focused toggle.
   */
  readonly secondary: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }
  /**
   * Return the host-owned card href using reviewThreadElementId(scope, thread). If a direct or
   * history href selects a secondary card, the host opens secondary before focusing that target.
   * Keep modified clicks and native link navigation intact.
   */
  readonly hrefForThread: (thread: ReviewThreadTarget) => string
  /** Deliberate selection belongs to the host. Modified clicks retain the supplied href. */
  readonly onOpenThread?: ((thread: ReviewThreadTarget) => void) | undefined
}

function FindingLink({
  href,
  onOpenThread,
  row: { finding, thread }
}: {
  readonly href: string
  readonly onOpenThread: ReviewFindingsIndexViewProps["onOpenThread"]
  readonly row: ReviewFindingRow
}): ReactElement {
  const anchor = thread.anchor
  const disposition = reviewDispositionText(finding.disposition, useCommitWords(fixedCommit(finding.disposition)))
  return (
    <a
      className={styles.row}
      href={href}
      onClick={(event) => {
        if (
          onOpenThread === undefined ||
          event.button !== 0 ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return
        event.preventDefault()
        onOpenThread(thread)
      }}
    >
      <span className={styles.severity} data-severity={finding.severity}>
        {finding.severity}
      </span>
      <span className={styles.body}>
        {finding.axis !== null ? (
          <span className={styles.tags}>
            <span className={styles.axis}>{finding.axis}</span>
          </span>
        ) : null}
        <span className={styles.claim}>{finding.claim}</span>
        <span className={styles.meta}>
          {anchor._tag === "Unanchored" ? (
            "Whole pull request"
          ) : (
            <code>
              {anchor.path}
              {anchor._tag === "Line" ? `:${anchor.line}` : ""}
            </code>
          )}
          {anchor._tag === "Line" && anchor.side === "before" ? <span>Before change</span> : null}
          {anchor._tag !== "Unanchored" && anchor.outdated ? <span>Outdated</span> : null}
          {finding.confidence !== null ? <span>{reviewConfidenceWords[finding.confidence]}</span> : null}
        </span>
        {disposition !== null ? (
          <span className={styles.status}>
            <StateLabel
              label={disposition}
              size="compact"
              {...(finding.disposition._tag === "Dismissed" ? { icon: "minus" } : {})}
              tone={reviewDispositionTones[finding.disposition._tag]}
            />
          </span>
        ) : null}
        {thread.resolved && finding.disposition._tag !== "Resolved" ? (
          <span className={styles.status}>
            <StateLabel label="Thread resolved" size="compact" tone="positive" />
          </span>
        ) : null}
      </span>
    </a>
  )
}

/** Findings-only by default; optional discussions add filters and complete-set totals, never inferred open counts. */
export function ReviewFindingsIndexView({
  findings,
  hrefForThread,
  notice,
  onOpenThread,
  scope,
  secondary,
  threads
}: ReviewFindingsIndexViewProps): ReactElement | null {
  const heading = useId()
  const group = useId()
  const [filter, setFilter] = useState<{ readonly scope: string; readonly value: "all" | "findings" | "comments" }>({
    scope,
    value: "all"
  })
  useEffect(() => setFilter((previous) => (previous.scope === scope ? previous : { scope, value: "all" })), [scope])
  const selected = filter.scope === scope ? filter.value : "all"
  const comments = threads?.conversations ?? []
  const showFindings = threads === undefined || selected !== "comments"
  const showComments = threads !== undefined && selected !== "findings"
  if (findings.primary.length === 0 && findings.secondary.length === 0 && comments.length === 0) return null
  const rows = (values: ReadonlyArray<ReviewFindingRow>) =>
    values.map((row) => (
      <li key={reviewThreadElementId(scope, row.thread)}>
        <FindingLink href={hrefForThread(row.thread)} row={row} onOpenThread={onOpenThread} />
      </li>
    ))
  return (
    <section aria-labelledby={heading} className={styles.index}>
      <header className={styles.header}>
        <h2 className={styles.heading} id={heading}>
          {threads === undefined ? "Findings" : "Threads"}
        </h2>
        {threads?.total._tag === "Exact" ? (
          <small>
            {threads.total.n} {threads.total.n === 1 ? "thread" : "threads"}
          </small>
        ) : null}
      </header>
      {threads === undefined ? null : (
        <div className={styles.filters} role="group" aria-label="Thread list filters">
          {(
            [
              ["all", "All", findings.primary.length + findings.secondary.length + comments.length],
              ["findings", "Findings", findings.primary.length + findings.secondary.length],
              ["comments", "Comments", comments.length]
            ] satisfies ReadonlyArray<readonly ["all" | "findings" | "comments", string, number]>
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={selected === value}
              onClick={() => setFilter({ scope, value })}
            >
              {label}
              {threads.total._tag === "Exact" ? (
                <>
                  {" "}
                  <span>{count}</span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      )}
      {notice}
      {showFindings && findings.primary.length > 0 ? <ul className={styles.rows}>{rows(findings.primary)}</ul> : null}
      {showComments && comments.length > 0 ? (
        <ul className={styles.rows}>
          {comments.map((thread) => {
            const first = thread.messages[0]
            const initial = Array.from(first?.author.trim() ?? "")[0]?.toUpperCase() ?? ""
            const replies = Math.max(0, thread.messages.length - 1)
            const anchor = thread.anchor
            return (
              <li key={reviewThreadElementId(scope, thread)}>
                <a
                  className={`${styles.row} ${styles.commentRow}`}
                  data-initial={initial.length > 0 ? "" : undefined}
                  href={hrefForThread(thread)}
                  onClick={(event) => {
                    if (
                      onOpenThread === undefined ||
                      event.button !== 0 ||
                      event.ctrlKey ||
                      event.metaKey ||
                      event.altKey ||
                      event.shiftKey
                    )
                      return
                    event.preventDefault()
                    onOpenThread(thread)
                  }}
                >
                  {initial.length > 0 ? (
                    <span className={styles.initial} data-comment-initial="" aria-hidden="true">
                      {initial}
                    </span>
                  ) : null}
                  <span className={styles.body}>
                    <span className={styles.labels} data-comment-status="">
                      <span>Comment</span>
                      {anchor._tag !== "Unanchored" && anchor.outdated ? <span>Outdated</span> : null}
                    </span>
                    {first === undefined ? null : (
                      <span className={styles.claim}>{first.deleted ? "Comment deleted" : first.text}</span>
                    )}
                    <span className={styles.meta}>
                      {anchor._tag === "Unanchored" ? (
                        "Whole pull request"
                      ) : (
                        <code>
                          {anchor.path}
                          {anchor._tag === "Line" ? `:${anchor.line}` : ""}
                        </code>
                      )}
                      {first === undefined ? null : <span>{first.author}</span>}
                      {thread.resolved ? <span>Thread resolved</span> : null}
                      {replies > 0 ? (
                        <span data-comment-replies="">
                          {replies} {replies === 1 ? "reply" : "replies"}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </a>
              </li>
            )
          })}
        </ul>
      ) : null}
      {showFindings && findings.secondary.length > 0 ? (
        <>
          <button
            aria-controls={group}
            aria-expanded={secondary.open}
            className={styles.toggle}
            onClick={() => secondary.onOpenChange(!secondary.open)}
            type="button"
          >
            <svg
              aria-hidden="true"
              className={styles.toggleIcon}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              focusable="false"
            >
              <path d="m9 5 7 7-7 7" />
            </svg>
            P2 and below ({findings.secondary.length})
          </button>
          <div className={styles.secondary} hidden={!secondary.open} id={group}>
            <ul className={styles.rows}>{rows(findings.secondary)}</ul>
          </div>
        </>
      ) : null}
    </section>
  )
}
