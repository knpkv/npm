import { Button, Text } from "@knpkv/rly/primitives"
import { type KeyboardEvent, type ReactElement, useEffect, useRef, useState } from "react"

import type { ReviewSuggestionPublicationPreview } from "../../api/agent.js"
import type { PullRequestReviewPublicationState } from "./usePullRequestReview.js"
import styles from "./WorkspacePullRequestDetails.module.css"

const anchorLabel = (anchor: ReviewSuggestionPublicationPreview["anchor"]): string =>
  anchor._tag === "changes"
    ? "Whole pull request"
    : `${anchor.path}:${String(anchor.line)} · ${anchor.relativeFileVersion}`

/** Render the on-demand operator confirmation and durable publication receipt. */
export const ReviewSuggestionPublicationSurface = ({
  onCancel,
  onPublish,
  publication
}: {
  readonly onCancel: () => void
  readonly onPublish: (finalContent: string) => void
  readonly publication: PullRequestReviewPublicationState
}): ReactElement | null => {
  const [content, setContent] = useState("")
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef(document.activeElement)
  const preview =
    publication._tag === "preview" || publication._tag === "publishing" || publication._tag === "published"
      ? publication.preview
      : publication._tag === "failed"
        ? publication.preview
        : null
  const dialogIsOpen = preview !== null && publication._tag !== "published"
  useEffect(() => {
    if (preview !== null) setContent(preview.editableContent)
  }, [preview])
  useEffect(() => {
    if (!dialogIsOpen) return
    return () => {
      const returnFocus = returnFocusRef.current
      if (returnFocus !== null && "focus" in returnFocus && typeof returnFocus.focus === "function") {
        returnFocus.focus()
      }
    }
  }, [dialogIsOpen])

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && publication._tag !== "publishing") {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== "Tab") return
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )
    if (focusable === undefined || focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (first === undefined || last === undefined) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (publication._tag === "published" || publication._tag === "receipt-conflict") {
    const receiptConflict = publication._tag === "receipt-conflict"
    return (
      <div className={styles.publishedComment} role="status">
        <small>
          {receiptConflict ? "Published comment · receipt verification conflict" : "Published Review Comment"}
        </small>
        <strong>{anchorLabel(publication.publication.anchor)}</strong>
        <Text>{publication.publication.receipt.safeSummary}</Text>
        <code>{publication.publication.receipt.providerOperationId}</code>
        <span>
          {publication.publication.proposingAgent.label} · operator {publication.publication.publishingOperator}
        </span>
        {receiptConflict ? (
          <span role="alert">
            The provider receipt did not match the confirmed review revision. Do not retry automatically.
          </span>
        ) : publication.headSuperseded ? (
          <span>The comment was published against a head that is no longer current.</span>
        ) : null}
      </div>
    )
  }
  if (preview === null) {
    return publication._tag === "failed" ? (
      <span role="alert">The publication preview could not be prepared. The suggestion was not posted.</span>
    ) : null
  }
  return (
    <div className={styles.publicationBackdrop}>
      <div
        aria-describedby="review-publication-context"
        aria-labelledby="review-publication-title"
        aria-modal="true"
        className={styles.publicationDialog}
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <small>Human-confirmed provider action</small>
          <strong id="review-publication-title">Post review suggestion</strong>
          <Text id="review-publication-context" tone="secondary">
            Review the exact AWS identity, revision, anchor, and editable comment before publishing.
          </Text>
        </header>
        <dl className={styles.publicationFacts}>
          <div>
            <dt>AWS identity</dt>
            <dd>{preview.connectedIdentity.arn}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{preview.connectedIdentity.accountId}</dd>
          </div>
          <div>
            <dt>Exact head</dt>
            <dd>{preview.suggestionRevision.reviewedHead}</dd>
          </div>
          <div>
            <dt>Anchor</dt>
            <dd>{anchorLabel(preview.anchor)}</dd>
          </div>
        </dl>
        <label className={styles.publicationEditor}>
          <span>Comment and replacement suggestion</span>
          <textarea
            autoFocus
            maxLength={preview.editableContentMaximumLength}
            onChange={(event) => setContent(event.currentTarget.value)}
            rows={12}
            value={content}
          />
        </label>
        <div className={styles.publicationFooter}>
          <small>Required publication footer</small>
          <code>{preview.publicationFooter}</code>
        </div>
        {publication._tag === "failed" ? (
          <span role="alert">
            Publication did not complete. Nothing is marked published; verify the connection and retry.
          </span>
        ) : null}
        <div className={styles.publicationActions}>
          <Button disabled={publication._tag === "publishing"} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={publication._tag === "publishing" || content.trim().length === 0}
            onClick={() => onPublish(`${content}\n\n${preview.publicationFooter}`)}
          >
            {publication._tag === "publishing" ? "Publishing…" : "Post to CodeCommit"}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ReviewSuggestionPublicationSurface
