import { Button, Text } from "@knpkv/rly/primitives"
import { type ReactElement, useEffect, useState } from "react"

import type { PullRequestReviewPublicationState } from "./usePullRequestReview.js"
import styles from "./WorkspacePullRequestDetails.module.css"

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
  const preview =
    publication._tag === "preview" || publication._tag === "publishing" || publication._tag === "published"
      ? publication.preview
      : publication._tag === "failed"
        ? publication.preview
        : null
  useEffect(() => {
    if (preview !== null) setContent(preview.finalContent)
  }, [preview])

  if (publication._tag === "published") {
    return (
      <div className={styles.publishedComment} role="status">
        <small>Published Review Comment</small>
        <strong>
          {publication.publication.anchor.path}:{publication.publication.anchor.line}
        </strong>
        <Text>{publication.publication.receipt.safeSummary}</Text>
        <code>{publication.publication.receipt.providerOperationId}</code>
        <span>
          {publication.publication.proposingAgent.label} · operator {publication.publication.publishingOperator}
        </span>
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
        className={styles.publicationDialog}
        role="dialog"
      >
        <header>
          <small>Human-confirmed provider action</small>
          <strong id="review-publication-title">Post line suggestion</strong>
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
            <dd>
              {preview.anchor.path}:{preview.anchor.line} · AFTER
            </dd>
          </div>
        </dl>
        <label className={styles.publicationEditor}>
          <span>Comment and replacement suggestion</span>
          <textarea autoFocus onChange={(event) => setContent(event.currentTarget.value)} rows={12} value={content} />
        </label>
        <div className={styles.publicationFooter}>
          <small>Required publication footer</small>
          <code>
            — {preview.proposingAgent.label} · head {preview.suggestionRevision.reviewedHead.slice(0, 12)} · operator{" "}
            {preview.publishingOperator}
          </code>
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
            onClick={() => onPublish(content)}
          >
            {publication._tag === "publishing" ? "Publishing…" : "Post to CodeCommit"}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ReviewSuggestionPublicationSurface
