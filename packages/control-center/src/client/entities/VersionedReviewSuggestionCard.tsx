import { Button, Dialog, Text } from "@knpkv/rly/primitives"
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
  author._tag === "operator" ? "Operator" : author.providerId

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
  const [dismissOpen, setDismissOpen] = useState(false)
  const page =
    controller.state._tag === "ready" ||
    controller.state._tag === "dismissing" ||
    controller.state._tag === "saving" ||
    controller.state._tag === "conflict"
      ? controller.state.page
      : controller.state._tag === "failed"
        ? controller.state.page
        : null
  const preservedDraft =
    controller.state._tag === "saving" || controller.state._tag === "conflict" || controller.state._tag === "failed"
      ? controller.state.draft
      : null
  const current = page?.current
  const presentedSuggestion: PrReviewSuggestion =
    current === undefined
      ? suggestion
      : {
          ...current.suggestion,
          state: suggestion.state === "published" ? "published" : current.suggestion.state
        }
  const suggestionCanMutate = canEdit && presentedSuggestion.state === "draft" && controller.state._tag !== "dismissing"
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
        canPublish={suggestionCanMutate}
        extraActions={
          <>
            <Button disabled={page === null} onClick={() => openDialog("history")} variant="quiet">
              History
            </Button>
            {suggestionCanMutate ? (
              <Button disabled={page === null} onClick={() => openDialog("edit")} variant="quiet">
                Edit
              </Button>
            ) : null}
            {suggestionCanMutate ? (
              <Button disabled={page === null} onClick={() => setDismissOpen(true)} variant="quiet">
                Dismiss
              </Button>
            ) : null}
            {controller.state._tag === "dismissing" ? (
              <Button disabled variant="quiet">
                Dismissing…
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
        onPreviewPublication={(selection) => {
          if (current === undefined) return
          onPreviewPublication({
            ...selection,
            revisionId: current.revisionId
          })
        }}
        {...(publicationBlockedReason === undefined ? {} : { publicationBlockedReason })}
        suggestion={presentedSuggestion}
      />
      {page === null ? null : (
        <ReviewSuggestionRevisionDialog
          canEdit={suggestionCanMutate}
          conflict={controller.state._tag === "conflict"}
          loadEarlier={controller.loadEarlier}
          loadingEarlier={controller.loadingEarlier}
          mode={dialogMode}
          onOpenChange={setDialogOpen}
          onResolveConflict={controller.resolveConflict}
          onSave={controller.save}
          open={dialogOpen}
          page={page}
          preservedDraft={preservedDraft}
          saving={controller.state._tag === "saving"}
        />
      )}
      <Dialog.Root onOpenChange={setDismissOpen} open={dismissOpen}>
        <Dialog.Content
          description="Dismiss this finding for the reviewed head. It will remain in revision history and will not be posted to CodeCommit."
          size="default"
          title="Dismiss finding?"
        >
          <Text>This records your decision without changing the pull request or publishing a comment.</Text>
          <div className={styles.publicationActions}>
            <Dialog.Close>Keep finding</Dialog.Close>
            <Button
              onClick={() => {
                setDismissOpen(false)
                controller.dismiss()
              }}
            >
              Dismiss finding
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Root>
    </>
  )
}
