import { Button, Dialog, Text } from "@knpkv/rly/primitives"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { type ReactElement, useEffect, useMemo, useState } from "react"

import { PrReviewSuggestion } from "../../domain/prReview.js"
import { PrReviewSuggestionEdit, type PrReviewSuggestionRevisionPage } from "../../domain/prReviewRevision.js"
import {
  ReviewSuggestionRevisionHistory,
  reviewSuggestionRevisionAuthorLabel,
  reviewSuggestionRevisionValidationLabel
} from "./ReviewSuggestionRevisionHistory.js"
import styles from "./WorkspacePullRequestDetails.module.css"

const AdvancedSuggestionFields = Schema.Struct({
  anchor: PrReviewSuggestion.fields.anchor,
  evidence: PrReviewSuggestion.fields.evidence,
  relatedLocations: PrReviewSuggestion.fields.relatedLocations,
  replacement: PrReviewSuggestion.fields.replacement,
  prevention: PrReviewSuggestion.fields.prevention
})
const AdvancedSuggestionFieldsJson = Schema.fromJsonString(AdvancedSuggestionFields)
const narrativeFields = [
  ["Problem", "problem"],
  ["Impact", "impact"],
  ["Recommendation", "recommendation"]
] satisfies ReadonlyArray<readonly [string, "impact" | "problem" | "recommendation"]>

const editableSuggestion = (suggestion: PrReviewSuggestion): PrReviewSuggestionEdit => ({
  title: suggestion.title,
  severity: suggestion.severity,
  problem: suggestion.problem,
  impact: suggestion.impact,
  evidence: suggestion.evidence,
  recommendation: suggestion.recommendation,
  confidence: suggestion.confidence,
  relatedLocations: suggestion.relatedLocations,
  ...(!(suggestion.prevention === undefined) && { prevention: suggestion.prevention }),
  ...(!(suggestion.replacement === undefined) && { replacement: suggestion.replacement }),
  anchor: suggestion.anchor
})

const advancedJson = (suggestion: PrReviewSuggestionEdit): string =>
  Schema.encodeSync(AdvancedSuggestionFieldsJson)({
    anchor: suggestion.anchor,
    evidence: suggestion.evidence,
    relatedLocations: suggestion.relatedLocations,
    ...(!(suggestion.prevention === undefined) && { prevention: suggestion.prevention }),
    ...(!(suggestion.replacement === undefined) && { replacement: suggestion.replacement })
  })

/** Edit or inspect one immutable suggestion revision without leaving the diff. */
export const ReviewSuggestionRevisionDialog = ({
  canEdit,
  conflict,
  loadEarlier,
  loadingEarlier,
  mode,
  onOpenChange,
  onResolveConflict,
  onSave,
  open,
  page,
  preservedDraft,
  saving
}: {
  readonly canEdit: boolean
  readonly conflict: boolean
  readonly loadEarlier: () => void
  readonly loadingEarlier: boolean
  readonly mode: "edit" | "history"
  readonly onOpenChange: (open: boolean) => void
  readonly onResolveConflict: () => void
  readonly onSave: (edit: PrReviewSuggestionEdit) => void
  readonly open: boolean
  readonly page: PrReviewSuggestionRevisionPage
  readonly preservedDraft: PrReviewSuggestionEdit | null
  readonly saving: boolean
}): ReactElement => {
  const current = page.current
  const [draft, setDraft] = useState(() => editableSuggestion(current.suggestion))
  const [advanced, setAdvanced] = useState(() => advancedJson(current.suggestion))
  const [advancedError, setAdvancedError] = useState(false)
  useEffect(() => {
    if (!open) return
    const nextDraft = preservedDraft ?? editableSuggestion(current.suggestion)
    setDraft(nextDraft)
    setAdvanced(advancedJson(nextDraft))
    setAdvancedError(false)
  }, [current.revisionId, current.suggestion, open, preservedDraft])
  const description = useMemo(
    () =>
      `Revision ${String(current.sequence)} · ${reviewSuggestionRevisionValidationLabel(
        current
      )} · ${reviewSuggestionRevisionAuthorLabel(current)}`,
    [current]
  )
  const save = (): void => {
    const decoded = Schema.decodeUnknownResult(AdvancedSuggestionFieldsJson)(advanced)
    if (Result.isFailure(decoded)) {
      setAdvancedError(true)
      return
    }
    setAdvancedError(false)
    const edit = Schema.decodeUnknownResult(PrReviewSuggestionEdit)({
      title: draft.title,
      severity: draft.severity,
      problem: draft.problem,
      impact: draft.impact,
      recommendation: draft.recommendation,
      confidence: draft.confidence,
      ...decoded.success
    })
    if (Result.isFailure(edit)) {
      setAdvancedError(true)
      return
    }
    onSave(edit.success)
  }

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Content
        className={styles.revisionDialog}
        description={description}
        size="wide"
        title={mode === "edit" ? "Edit review suggestion" : "Revision history"}
      >
        {mode === "history" ? (
          <ReviewSuggestionRevisionHistory loadEarlier={loadEarlier} loadingEarlier={loadingEarlier} page={page} />
        ) : (
          <form
            className={styles.revisionEditor}
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <div className={styles.revisionEditorLead}>
              <label>
                <span>Title</span>
                <input
                  maxLength={500}
                  onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
                  required
                  value={draft.title}
                />
              </label>
              <label>
                <span>Severity</span>
                <select
                  onChange={(event) => {
                    const severity = Schema.decodeUnknownResult(PrReviewSuggestion.fields.severity)(
                      event.currentTarget.value
                    )
                    if (Result.isFailure(severity)) return
                    setDraft({ ...draft, severity: severity.success })
                  }}
                  value={draft.severity}
                >
                  <option value="P1">P1</option>
                  <option value="P2">P2</option>
                  <option value="P3">P3</option>
                  <option value="P4">P4</option>
                </select>
              </label>
              <label>
                <span>Confidence</span>
                <select
                  onChange={(event) => {
                    const level = Schema.decodeUnknownResult(PrReviewSuggestion.fields.confidence.fields.level)(
                      event.currentTarget.value
                    )
                    if (Result.isFailure(level)) return
                    setDraft({
                      ...draft,
                      confidence: {
                        ...draft.confidence,
                        level: level.success
                      }
                    })
                  }}
                  value={draft.confidence.level}
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                </select>
              </label>
            </div>
            {narrativeFields.map(([label, field]) => (
              <label key={field}>
                <span>{label}</span>
                <textarea
                  maxLength={4_000}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      [field]: event.currentTarget.value
                    })
                  }
                  required
                  rows={4}
                  value={draft[field]}
                />
              </label>
            ))}
            <label>
              <span>Confidence reason</span>
              <textarea
                maxLength={2_000}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    confidence: {
                      ...draft.confidence,
                      reason: event.currentTarget.value
                    }
                  })
                }
                required
                rows={3}
                value={draft.confidence.reason}
              />
            </label>
            <details className={styles.revisionAdvanced}>
              <summary>Advanced evidence, anchor, replacement and prevention</summary>
              <Text tone="secondary">
                Complete schema-checked JSON. Invalid or incoherent evidence cannot be saved.
              </Text>
              <textarea
                aria-describedby={advancedError ? "revision-advanced-error" : undefined}
                aria-invalid={advancedError}
                aria-label="Advanced evidence, anchor, replacement and prevention JSON"
                onChange={(event) => setAdvanced(event.currentTarget.value)}
                rows={14}
                spellCheck={false}
                value={advanced}
              />
              {advancedError ? (
                <span id="revision-advanced-error" role="alert">
                  Advanced fields are not a valid complete suggestion.
                </span>
              ) : null}
            </details>
            {conflict ? (
              <div role="alert">
                <span>A newer revision won. Your draft is preserved, but cannot be saved over the winner.</span>
                <Button onClick={onResolveConflict} type="button" variant="quiet">
                  Use latest revision
                </Button>
              </div>
            ) : current.validation._tag === "requires-revalidation" ? (
              <span role="status">Technical changes remain blocked from publication until revalidated.</span>
            ) : null}
            <div className={styles.revisionDialogActions}>
              <Dialog.Close disabled={saving}>Cancel</Dialog.Close>
              <Button disabled={!canEdit || saving} loading={saving} type="submit">
                {saving ? "Saving revision…" : "Save revision"}
              </Button>
            </div>
          </form>
        )}
      </Dialog.Content>
    </Dialog.Root>
  )
}
