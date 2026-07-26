import { Button, Text } from "@knpkv/rly/primitives"
import { type ReactElement, lazy, Suspense, useState } from "react"

import type { ReviewSuggestionPublicationSelection } from "../../api/agent.js"
import type { PullRequestReviewControllerState, PullRequestReviewPublicationState } from "./usePullRequestReview.js"
import styles from "./WorkspacePullRequestDetails.module.css"

const unavailableMessage = (
  reason: Extract<PullRequestReviewControllerState, { readonly _tag: "ready" }>["review"] extends infer Review
    ? Review extends { readonly _tag: "unavailable"; readonly reason: infer Reason }
      ? Reason
      : never
    : never
): string => {
  switch (reason) {
    case "not-codecommit":
    case "not-pull-request":
      return "Agent review is available only for synchronized CodeCommit pull requests."
    case "source-stale":
      return "Synchronize this pull request before reviewing its immutable head."
    case "release-unavailable":
      return "Connect this pull request to a release before asking Relay to review it."
    case "base-revision-unavailable":
      return "The base revision has not been synchronized, so an exact review cannot start."
  }
}

const outcomeLabel = (
  outcome: "changes-required" | "non-blocking-suggestions" | "no-issues-found" | "unable-to-conclude"
) => {
  switch (outcome) {
    case "changes-required":
      return "Changes Required"
    case "non-blocking-suggestions":
      return "Non-blocking Suggestions"
    case "no-issues-found":
      return "No Issues Found"
    case "unable-to-conclude":
      return "Unable to Conclude"
  }
}

const formatBudget = (budgetMillis: number): string => {
  const minutes = Math.round(budgetMillis / 60_000)
  return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`
}

const ReviewSuggestionPublicationSurface = lazy(() => import("./ReviewSuggestionPublicationSurface.js"))

/** Render durable agent advice without conflating it with human disposition. */
export const PullRequestReviewPanel = ({
  canEnqueue,
  onCancelPublication,
  onPreviewPublication,
  onPublishSuggestion,
  onRetry,
  onStart,
  publication,
  state
}: {
  readonly canEnqueue: boolean
  readonly onCancelPublication: () => void
  readonly onPreviewPublication: (selection: ReviewSuggestionPublicationSelection) => void
  readonly onPublishSuggestion: (finalContent: string) => void
  readonly onRetry: () => void
  readonly onStart: () => void
  readonly publication: PullRequestReviewPublicationState
  readonly state: PullRequestReviewControllerState
}): ReactElement => {
  const [launchOpen, setLaunchOpen] = useState(false)
  const publicationSurface =
    publication._tag === "idle" || publication._tag === "previewing" ? null : (
      <Suspense fallback={<span>Preparing publication surface…</span>}>
        <ReviewSuggestionPublicationSurface
          onCancel={onCancelPublication}
          onPublish={onPublishSuggestion}
          publication={publication}
        />
      </Suspense>
    )
  const withPublication = (content: ReactElement): ReactElement => (
    <>
      {content}
      {publicationSurface}
    </>
  )

  if (state._tag === "idle" || state._tag === "loading") {
    return withPublication(
      <>
        <strong>Loading review state</strong>
        <span>Checking durable review history for this exact head.</span>
      </>
    )
  }
  if (state._tag === "failed") {
    return withPublication(
      <>
        <strong>Review state unavailable</strong>
        <span>The current review could not be loaded. No human decision was changed.</span>
        <Button onClick={onRetry}>Retry</Button>
      </>
    )
  }

  const review = state.review
  const launchDialog = (headRevision: string): ReactElement | null =>
    !launchOpen || state.provider === null ? null : (
      <div aria-labelledby="review-launch-title" role="dialog">
        <strong id="review-launch-title">Launch full-project review</strong>
        <dl>
          <div>
            <dt>Exact head</dt>
            <dd>
              <code>{headRevision}</code>
            </dd>
          </div>
          <div>
            <dt>Review Agent Profile</dt>
            <dd>{state.provider.reviewProfile.label}</dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>{formatBudget(state.provider.reviewProfile.budgetMillis)}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>Blocked</dd>
          </div>
          <div>
            <dt>Sandbox</dt>
            <dd>sbx</dd>
          </div>
        </dl>
        <Button onClick={() => setLaunchOpen(false)}>Cancel</Button>
        <Button
          onClick={() => {
            setLaunchOpen(false)
            onStart()
          }}
        >
          Start review
        </Button>
      </div>
    )
  if (review._tag === "unavailable") {
    return withPublication(
      <>
        <strong>Review unavailable</strong>
        <span>{unavailableMessage(review.reason)}</span>
      </>
    )
  }
  if (review._tag === "pending") {
    const label =
      review.state === "queued"
        ? "Review queued"
        : review.state === "running"
          ? "Reviewing exact head"
          : "Cancellation requested"
    return withPublication(
      <>
        <strong>{label}</strong>
        <span>
          Relay is using {review.providerId} · {review.model}. This page updates automatically.
        </span>
        <span>
          {review.reviewProfile.label} · {formatBudget(review.reviewProfile.budgetMillis)} · network blocked · sbx
        </span>
        {review.activity.events.length === 0 ? null : (
          <ol aria-label="Live review activity">
            {review.activity.events.map((event, index) => (
              <li key={`${String(index)}:${event}`}>{event}</li>
            ))}
          </ol>
        )}
        {review.activity.truncated ? <span>Earlier review activity is not shown.</span> : null}
        <code className={styles.reviewHead}>{review.subject.headRevision}</code>
      </>
    )
  }
  if (review._tag === "failed") {
    return withPublication(
      <>
        <strong>{review.state === "cancelled" ? "Review cancelled" : "Review did not finish"}</strong>
        <span>The failed run did not change approval or publish a recommendation.</span>
        {canEnqueue && state.provider !== null ? (
          <>
            <Button disabled={state.action === "starting"} onClick={() => setLaunchOpen(true)}>
              {state.action === "starting" ? "Starting…" : "Try again"}
            </Button>
            {launchDialog(review.subject.headRevision)}
          </>
        ) : null}
      </>
    )
  }
  if (review._tag === "completed") {
    return withPublication(
      <>
        <strong>{outcomeLabel(review.outcome)}</strong>
        {review.report.completion.status === "unable-to-conclude" ? (
          <Text>{review.report.completion.reason}</Text>
        ) : null}
        {review.report.suggestions.length === 0 ? (
          <span>No validated line suggestions were retained for this exact head.</span>
        ) : (
          <ol className={styles.reviewFindings}>
            {review.report.suggestions.map((suggestion) => (
              <li data-severity={suggestion.severity} key={suggestion.suggestionId}>
                <div className={styles.findingHeading}>
                  <span>{suggestion.severity}</span>
                  <strong>{suggestion.problem}</strong>
                </div>
                <code>
                  {suggestion.evidence.path}:{suggestion.evidence.startLine}
                  {suggestion.evidence.endLine === suggestion.evidence.startLine
                    ? ""
                    : `–${String(suggestion.evidence.endLine)}`}
                </code>
                <Text>{suggestion.impact}</Text>
                <Text>{suggestion.recommendation}</Text>
                <small>
                  {suggestion.confidence.level} confidence · {suggestion.confidence.reason}
                </small>
                {suggestion.prevention === undefined ? null : (
                  <div className={styles.preventionProposal}>
                    <small>Prevention proposal · separate review required</small>
                    <span>
                      {suggestion.prevention.summary} · {suggestion.prevention.enforcement}
                    </span>
                  </div>
                )}
                {canEnqueue ? (
                  <Button
                    disabled={
                      publication._tag === "previewing" &&
                      publication.selection.suggestionId === suggestion.suggestionId
                    }
                    onClick={() =>
                      onPreviewPublication({
                        jobId: review.jobId,
                        suggestionId: suggestion.suggestionId
                      })
                    }
                  >
                    {publication._tag === "previewing" && publication.selection.suggestionId === suggestion.suggestionId
                      ? "Preparing preview…"
                      : "Post comment"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <span>Agent advice only. A person must still approve or request changes.</span>
      </>
    )
  }

  return withPublication(
    <>
      <strong>Agent review not run</strong>
      <span>An immutable-head review produces advice, never a human approval.</span>
      {!canEnqueue ? (
        <span>Only a workspace owner can start a review.</span>
      ) : state.provider === null ? (
        <span>Configure an sbx Review Agent Profile with an Effect AI provider to enable review.</span>
      ) : (
        <>
          <Button disabled={state.action === "starting"} onClick={() => setLaunchOpen(true)}>
            {state.action === "starting" ? "Starting review…" : "Review exact head"}
          </Button>
          {launchDialog(review.subject.headRevision)}
        </>
      )}
      {state.action === "failed" ? (
        <span role="alert">The review could not be started. Check provider and worker configuration, then retry.</span>
      ) : null}
    </>
  )
}

export default PullRequestReviewPanel
