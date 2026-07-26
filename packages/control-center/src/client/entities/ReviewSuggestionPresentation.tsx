import { Button, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

import type { JobId } from "../../domain/identifiers.js"
import type { PrReviewNote, PrReviewSuggestion } from "../../domain/prReview.js"
import styles from "./WorkspacePullRequestDetails.module.css"

const anchorLabel = (suggestion: PrReviewSuggestion): string => {
  switch (suggestion.anchor._tag) {
    case "line":
      return `Line suggestion · ${suggestion.anchor.path}:${String(suggestion.anchor.line)}`
    case "file":
      return `File suggestion · ${suggestion.anchor.path}:${String(suggestion.anchor.line)}`
    case "changes":
      return "Whole-change suggestion"
  }
}

const replacementSides = (
  unifiedDiff: string
): {
  readonly after: string
  readonly before: string
} => {
  const content = unifiedDiff
    .split("\n")
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("@@ "))
  return {
    before: content
      .filter((line) => !line.startsWith("+"))
      .map((line) => line.slice(1))
      .join("\n"),
    after: content
      .filter((line) => !line.startsWith("-"))
      .map((line) => line.slice(1))
      .join("\n")
  }
}

/** Present one publishable, evidence-backed suggestion without owning its lifecycle. */
export const ReviewSuggestionCard = ({
  canPublish,
  isPreviewing,
  jobId,
  onPreviewPublication,
  suggestion
}: {
  readonly canPublish: boolean
  readonly isPreviewing: boolean
  readonly jobId: JobId
  readonly onPreviewPublication: (selection: {
    readonly jobId: JobId
    readonly suggestionId: PrReviewSuggestion["suggestionId"]
  }) => void
  readonly suggestion: PrReviewSuggestion
}): ReactElement => {
  const replacement = suggestion.replacement === undefined ? null : replacementSides(suggestion.replacement.unifiedDiff)

  return (
    <article className={styles.suggestionCard} data-severity={suggestion.severity}>
      <header className={styles.suggestionHeading}>
        <span className={styles.severity}>{suggestion.severity}</span>
        <span>
          <small>{anchorLabel(suggestion)}</small>
          <strong>{suggestion.title}</strong>
        </span>
        <span className={styles.confidence}>{suggestion.confidence.level} confidence</span>
      </header>

      <Text>{suggestion.problem}</Text>
      <dl className={styles.suggestionDetails}>
        <div>
          <dt>Impact</dt>
          <dd>{suggestion.impact}</dd>
        </div>
        <div>
          <dt>Recommendation</dt>
          <dd>{suggestion.recommendation}</dd>
        </div>
      </dl>
      <details>
        <summary>Evidence and confidence</summary>
        <code>
          {suggestion.evidence.path}:{String(suggestion.evidence.startLine)}
          {suggestion.evidence.endLine === suggestion.evidence.startLine
            ? ""
            : `–${String(suggestion.evidence.endLine)}`}
        </code>
        <pre>{suggestion.evidence.excerpt}</pre>
        <Text>{suggestion.confidence.reason}</Text>
      </details>

      {suggestion.relatedLocations.length === 0 ? null : (
        <section aria-label="Related locations" className={styles.relatedLocations}>
          <strong>Related locations</strong>
          <ul>
            {suggestion.relatedLocations.map((location) => (
              <li key={`${location.path}:${String(location.startLine)}:${String(location.endLine)}`}>
                <code>
                  {location.path}:{String(location.startLine)}
                  {location.endLine === location.startLine ? "" : `–${String(location.endLine)}`}
                </code>
                <span>{location.label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {replacement === null || suggestion.replacement === undefined ? null : (
        <section aria-label="Suggested replacement" className={styles.replacementPreview}>
          <header>
            <strong>Suggested replacement</strong>
            <span>Inert patch · {suggestion.replacement.reviewedHead.slice(0, 12)}</span>
          </header>
          <Text>{suggestion.replacement.explanation}</Text>
          <div>
            <figure>
              <figcaption>Before</figcaption>
              <pre>{replacement.before}</pre>
            </figure>
            <figure>
              <figcaption>After</figcaption>
              <pre>{replacement.after}</pre>
            </figure>
          </div>
        </section>
      )}

      {suggestion.prevention === undefined || suggestion.prevention.enforcement === "none" ? null : (
        <details className={styles.preventionProposal}>
          <summary>Prevention proposal · separate review required</summary>
          <Text>
            {suggestion.prevention.summary} · {suggestion.prevention.enforcement}
          </Text>
        </details>
      )}

      {canPublish && suggestion.anchor._tag === "line" && suggestion.state === "draft" ? (
        <Button
          disabled={isPreviewing}
          onClick={() =>
            onPreviewPublication({
              jobId,
              suggestionId: suggestion.suggestionId
            })
          }
        >
          {isPreviewing ? "Preparing preview…" : "Post comment"}
        </Button>
      ) : null}
    </article>
  )
}

/** Keep non-publishable observations visibly separate from actionable suggestions. */
export const ReviewNotes = ({ notes }: { readonly notes: ReadonlyArray<PrReviewNote> }): ReactElement | null =>
  notes.length === 0 ? null : (
    <section aria-labelledby="review-notes-title" className={styles.reviewNotes}>
      <header>
        <span>
          <small>Never publishable</small>
          <strong id="review-notes-title">Review Notes</strong>
        </span>
        <span>{notes.length}</span>
      </header>
      <ul>
        {notes.map((note) => (
          <li key={note.noteId}>
            <span>
              {note.reason === "pre-existing" ? "Pre-existing" : "Low confidence"} · {note.confidence.level}
            </span>
            <strong>{note.title}</strong>
            <Text>{note.observation}</Text>
            {note.location === undefined ? null : (
              <code>
                {note.location.path}:{String(note.location.startLine)}
                {note.location.endLine === note.location.startLine ? "" : `–${String(note.location.endLine)}`}
              </code>
            )}
            <small>{note.confidence.reason}</small>
          </li>
        ))}
      </ul>
    </section>
  )
