import { Button, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import type { ReactElement } from "react"

import type { PrReviewSuggestionRevision, PrReviewSuggestionRevisionPage } from "../../domain/prReviewRevision.js"
import styles from "./WorkspacePullRequestDetails.module.css"

export const reviewSuggestionRevisionAuthorLabel = (revision: PrReviewSuggestionRevision): string =>
  revision.author._tag === "operator"
    ? "Operator"
    : `${revision.author.providerId}${revision.author.model === null ? "" : ` · ${revision.author.model}`}`

export const reviewSuggestionRevisionValidationLabel = (revision: PrReviewSuggestionRevision): string =>
  revision.validation._tag === "validated" ? "Validated" : "Needs revalidation"

/** Inspect complete immutable suggestion history without leaving the diff. */
export const ReviewSuggestionRevisionHistory = ({
  loadEarlier,
  page
}: {
  readonly loadEarlier: () => void
  readonly page: PrReviewSuggestionRevisionPage
}): ReactElement => {
  const revisions = [page.current, ...page.revisions.filter(({ revisionId }) => revisionId !== page.current.revisionId)]
  return (
    <div className={styles.revisionHistory}>
      <ol>
        {revisions.map((revision) => (
          <li key={revision.revisionId}>
            <header>
              <strong>Revision {String(revision.sequence)}</strong>
              <span>
                {reviewSuggestionRevisionValidationLabel(revision)} · {reviewSuggestionRevisionAuthorLabel(revision)}
              </span>
            </header>
            <time dateTime={DateTime.formatIso(revision.createdAt)}>
              {DateTime.formatLocal(revision.createdAt, {
                dateStyle: "medium",
                timeStyle: "short"
              })}
            </time>
            <details>
              <summary>{revision.suggestion.title}</summary>
              <Text>{revision.suggestion.problem}</Text>
              <dl>
                <dt>Impact</dt>
                <dd>{revision.suggestion.impact}</dd>
                <dt>Recommendation</dt>
                <dd>{revision.suggestion.recommendation}</dd>
                <dt>Severity</dt>
                <dd>{revision.suggestion.severity}</dd>
                <dt>Confidence</dt>
                <dd>
                  {revision.suggestion.confidence.level} · {revision.suggestion.confidence.reason}
                </dd>
                <dt>Evidence</dt>
                <dd>
                  <code>
                    {revision.suggestion.evidence.path}:{String(revision.suggestion.evidence.startLine)}
                  </code>
                  <pre>{revision.suggestion.evidence.excerpt}</pre>
                </dd>
                <dt>Anchor</dt>
                <dd>
                  <code>{JSON.stringify(revision.suggestion.anchor)}</code>
                </dd>
                <dt>Related locations</dt>
                <dd>
                  {revision.suggestion.relatedLocations.length === 0 ? (
                    "None"
                  ) : (
                    <pre>{JSON.stringify(revision.suggestion.relatedLocations, null, 2)}</pre>
                  )}
                </dd>
                <dt>Replacement</dt>
                <dd>
                  {revision.suggestion.replacement === undefined ? (
                    "None"
                  ) : (
                    <>
                      <Text>{revision.suggestion.replacement.explanation}</Text>
                      <pre>{revision.suggestion.replacement.unifiedDiff}</pre>
                    </>
                  )}
                </dd>
                <dt>Prevention</dt>
                <dd>
                  {revision.suggestion.prevention === undefined ? (
                    "None"
                  ) : (
                    <pre>{JSON.stringify(revision.suggestion.prevention, null, 2)}</pre>
                  )}
                </dd>
              </dl>
            </details>
          </li>
        ))}
      </ol>
      {page.hasMore ? <Button onClick={loadEarlier}>Load earlier revisions</Button> : null}
    </div>
  )
}
