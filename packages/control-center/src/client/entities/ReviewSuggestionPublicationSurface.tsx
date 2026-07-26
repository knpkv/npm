import { Button, Dialog, Text } from "@knpkv/rly/primitives"
import { type ReactElement, useEffect, useRef, useState } from "react"

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
  const editorRef = useRef<HTMLTextAreaElement>(null)
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

  const publicationReceipt =
    publication._tag === "published" || publication._tag === "receipt-conflict"
      ? (() => {
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
        })()
      : null
  return (
    <>
      {publicationReceipt}
      {preview === null && publication._tag === "failed" ? (
        <span role="alert">The publication preview could not be prepared. The suggestion was not posted.</span>
      ) : null}
      <Dialog.Root
        onOpenChange={(open) => {
          if (!open && publication._tag !== "publishing") onCancel()
        }}
        open={dialogIsOpen}
      >
        {preview === null ? null : (
          <Dialog.Content
            className={styles.publicationDialog}
            description="Review the exact AWS identity, revision, anchor, and editable comment before publishing."
            initialFocusRef={editorRef}
            size="wide"
            title="Post review suggestion"
          >
            <div className={styles.publicationDialogBody}>
              <small className={styles.publicationEyebrow}>Human-confirmed provider action</small>
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
                  maxLength={preview.editableContentMaximumLength}
                  onChange={(event) => setContent(event.currentTarget.value)}
                  ref={editorRef}
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
                <Dialog.Close disabled={publication._tag === "publishing"}>Cancel</Dialog.Close>
                <Button
                  disabled={publication._tag === "publishing" || content.trim().length === 0}
                  onClick={() => onPublish(`${content}\n\n${preview.publicationFooter}`)}
                >
                  {publication._tag === "publishing" ? "Publishing…" : "Post to CodeCommit"}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        )}
      </Dialog.Root>
    </>
  )
}

export default ReviewSuggestionPublicationSurface
