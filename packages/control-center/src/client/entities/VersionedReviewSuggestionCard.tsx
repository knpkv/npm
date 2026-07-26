import { Button } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import { type ReactElement, useMemo, useState } from "react"

import type { EntityId, JobId } from "../../domain/identifiers.js"
import type { PrReviewSuggestion } from "../../domain/prReview.js"
import type { PrReviewSuggestionRevisionAuthor } from "../../domain/prReviewRevision.js"
import { ReviewSuggestionCard } from "./ReviewSuggestionPresentation.js"
import { ReviewSuggestionRevisionDialog } from "./ReviewSuggestionRevisionDialog.js"
import {
  browserReviewSuggestionRevisionTransport,
  useReviewSuggestionRevisions,
  type ReviewSuggestionRevisionScope,
  type ReviewSuggestionRevisionTransport
} from "./useReviewSuggestionRevisions.js"
import type { ReviewSuggestionPublicationTarget } from "./usePullRequestReview.js"
import styles from "./WorkspacePullRequestDetails.module.css"

const authorLabel = (author: PrReviewSuggestionRevisionAuthor): string =>
  author._tag === "operator" ? "You" : author.providerId

/** Enrich one immediate review-report card with its durable current revision. */
export const VersionedReviewSuggestionCard = ({
  canEdit,
  entityId,
  isPreviewing,
  jobId,
  onPreviewPublication,
  revisionTransport = browserReviewSuggestionRevisionTransport,
  sessionKey,
  suggestion
}: {
  readonly canEdit: boolean
  readonly entityId: EntityId
  readonly isPreviewing: boolean
  readonly jobId: JobId
  readonly onPreviewPublication: (selection: ReviewSuggestionPublicationTarget) => void
  readonly revisionTransport?: ReviewSuggestionRevisionTransport
  readonly sessionKey: string
  readonly suggestion: PrReviewSuggestion
}): ReactElement => {
  const scope: ReviewSuggestionRevisionScope = useMemo(
    () => ({
      entityId,
      jobId,
      sessionKey,
      suggestionId: suggestion.suggestionId
    }),
    [entityId, jobId, sessionKey, suggestion.suggestionId]
  )
  const controller = useReviewSuggestionRevisions(scope, revisionTransport)
  const [dialogMode, setDialogMode] = useState<"edit" | "history">("history")
  const [dialogOpen, setDialogOpen] = useState(false)
  const available =
    controller.state._tag === "ready" || controller.state._tag === "saving" || controller.state._tag === "conflict"
  const page = available ? controller.state.page : null
  const current = page?.current
  const presentedSuggestion = current?.suggestion ?? suggestion
  const validationBlocked = current?.validation._tag === "requires-revalidation"
  const publicationBlockedReason =
    controller.state._tag === "loading"
      ? "Loading the exact revision before publication."
      : controller.state._tag === "failed"
        ? "Revision history is unavailable. Retry before publishing."
        : validationBlocked
          ? "This technical edit needs agent revalidation before it can be posted."
          : undefined
  const openDialog = (mode: "edit" | "history"): void => {
    setDialogMode(mode)
    setDialogOpen(true)
  }

  return (
    <>
      <ReviewSuggestionCard
        canPublish={canEdit}
        extraActions={
          <>
            <Button disabled={page === null} onClick={() => openDialog("history")} variant="quiet">
              History
            </Button>
            {canEdit ? (
              <Button disabled={page === null} onClick={() => openDialog("edit")} variant="quiet">
                Edit
              </Button>
            ) : null}
            {controller.state._tag === "failed" ? (
              <Button onClick={controller.retry} variant="quiet">
                Retry revision
              </Button>
            ) : null}
          </>
        }
        isPreviewing={isPreviewing}
        jobId={jobId}
        metadata={
          current === undefined ? null : (
            <div className={styles.suggestionRevisionMeta} data-validation={current.validation._tag}>
              <strong>Revision {String(current.sequence)}</strong>
              <span>{current.validation._tag === "validated" ? "Validated" : "Needs revalidation"}</span>
              <span>{authorLabel(current.author)}</span>
              <time dateTime={DateTime.formatIso(current.createdAt)}>
                {DateTime.formatLocal(current.createdAt, {
                  dateStyle: "medium",
                  timeStyle: "short"
                })}
              </time>
            </div>
          )
        }
        onPreviewPublication={onPreviewPublication}
        {...(publicationBlockedReason === undefined ? {} : { publicationBlockedReason })}
        suggestion={presentedSuggestion}
      />
      {page === null ? null : (
        <ReviewSuggestionRevisionDialog
          canEdit={canEdit}
          conflict={controller.state._tag === "conflict"}
          loadEarlier={controller.loadEarlier}
          mode={dialogMode}
          onOpenChange={setDialogOpen}
          onSave={controller.save}
          open={dialogOpen}
          page={page}
          saving={controller.state._tag === "saving"}
        />
      )}
    </>
  )
}
