/** Read-only finding prose from export 66. Recommendation is never treated as an executable patch. @module */
import { CommitLabel, useCommitWords } from "@knpkv/review/react"
import { StateLabel } from "@knpkv/rly/primitives"
import type { ReviewFindingRow } from "@knpkv/review"
import { useId, type ReactElement } from "react"
import { reviewThreadElementId } from "../review-thread-target.js"
import {
  fixedCommit,
  reviewConfidenceWords,
  reviewDispositionText,
  reviewDispositionTones
} from "./review-finding-words.js"
import styles from "./review-finding-card.module.css"

export interface ReviewFindingCardProps {
  readonly row: ReviewFindingRow
  /** Same unique workspace/presentation scope used by the finding index. */
  readonly scope: string
}

/** Preserve recorded evidence and optional fields; omit every write action in this read-only view. */
export function ReviewFindingCard({ row: { finding, thread }, scope }: ReviewFindingCardProps): ReactElement {
  const heading = useId()
  const anchor = thread.anchor
  const note =
    finding.disposition._tag === "Dismissed" && finding.disposition.note !== null && finding.disposition.note.length > 0
      ? finding.disposition.note
      : null
  const disposition = reviewDispositionText(
    finding.disposition._tag === "Dismissed" ? { ...finding.disposition, note: null } : finding.disposition,
    useCommitWords(fixedCommit(finding.disposition))
  )
  const why = [
    ...new Set([finding.summary, finding.why].filter((text) => text !== null).filter((text) => text.length > 0))
  ]
  const fields = [
    { label: "Why", paragraphs: why },
    { label: "Recommendation", paragraphs: finding.recommendation.length > 0 ? [finding.recommendation] : [] },
    { label: "How to verify", paragraphs: finding.verification.length > 0 ? [finding.verification] : [] },
    { label: "Requirement", paragraphs: finding.requirement === null ? [] : [finding.requirement] }
  ]
  return (
    <article aria-labelledby={heading} className={styles.card} id={reviewThreadElementId(scope, thread)} tabIndex={-1}>
      <header className={styles.anchor}>
        <span className={styles.severity} data-severity={finding.severity}>
          {finding.severity}
        </span>
        {finding.axis !== null ? <span className={styles.tag}>{finding.axis}</span> : null}
        <small className={styles.reference}>
          {anchor._tag === "Unanchored" ? (
            <span>Whole pull request</span>
          ) : (
            <code>
              {anchor.path}
              {anchor._tag === "Line" ? `:${anchor.line}` : ""}
            </code>
          )}
          {finding.confidence !== null ? (
            <>
              {", "}
              {reviewConfidenceWords[finding.confidence]}
            </>
          ) : null}
        </small>
        {anchor._tag === "Line" && anchor.side === "before" ? <span>Before change</span> : null}
        {anchor._tag !== "Unanchored" && anchor.outdated ? <span className={styles.tag}>Outdated</span> : null}
      </header>
      {disposition !== null || (thread.resolved && finding.disposition._tag !== "Resolved") ? (
        <div className={styles.prose}>
          {disposition !== null ? (
            <p className={styles.disposition} data-review-disposition={finding.disposition._tag}>
              <StateLabel
                label={`${disposition}${note === null ? "" : ","}`}
                size="compact"
                {...(finding.disposition._tag === "Dismissed" ? { icon: "minus" } : {})}
                tone={reviewDispositionTones[finding.disposition._tag]}
              />
              {note === null ? null : (
                <span className={styles.dispositionNote}>
                  {" ‘"}
                  {note}’
                </span>
              )}
            </p>
          ) : null}
          {thread.resolved && finding.disposition._tag !== "Resolved" ? (
            <p className={styles.disposition}>
              <StateLabel label="Thread resolved" size="compact" tone="positive" />
            </p>
          ) : null}
        </div>
      ) : null}
      <h3 className={styles.claim} id={heading}>
        {finding.claim}
      </h3>
      {fields
        .filter(({ paragraphs }) => paragraphs.length > 0)
        .map(({ label, paragraphs }) => (
          <div className={styles.prose} key={label}>
            <h4>{label}</h4>
            {paragraphs.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </div>
        ))}
      {finding.patch !== null ? (
        <div className={styles.prose}>
          <h4>Suggested patch</h4>
          <small>
            {finding.patch.path}, head <CommitLabel commit={finding.patch.headRevision} />
          </small>
          <pre className={styles.patch}>
            <code>{finding.patch.text}</code>
          </pre>
        </div>
      ) : null}
    </article>
  )
}
