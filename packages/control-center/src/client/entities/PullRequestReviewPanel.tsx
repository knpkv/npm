import { Button, Text } from "@knpkv/rly/primitives"
import { type ReactElement, lazy, Suspense, useEffect, useState } from "react"

import {
  MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH,
  type DurableAgentPrompt,
  type PullRequestReviewThreadEvent,
  type ReviewSuggestionPublicationSelection
} from "../../api/agent.js"
import { ReviewNotes, ReviewSuggestionCard } from "./ReviewSuggestionPresentation.js"
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

const threadEventSummary = (event: PullRequestReviewThreadEvent): string | null => {
  switch (event._tag) {
    case "operator-message":
      return `Local Operator · ${event.prompt}`
    case "run-queued":
      return `${event.reviewProfile.label} · head ${event.subject.headRevision.slice(0, 12)}`
    case "run-started":
      return event.runtimeMetadata === undefined
        ? "Review sandbox started"
        : `Review sandbox started · ${event.runtimeMetadata.implementation} ${event.runtimeMetadata.version ?? ""}`.trim()
    case "progress":
      return event.text
    case "review-report":
      return `${String(event.report.suggestions.length)} suggestions · ${String(event.report.notes.length)} notes`
    case "suggestion-published":
      return "Suggestion published to CodeCommit"
    case "run-completed":
      return `Run completed · ${event.outcome}`
    case "run-failed":
      return event.retryable ? "Run failed · retryable" : "Run failed"
    case "cancellation-requested":
      return "Cancellation requested"
    case "usage":
      return null
  }
}

/** Render durable agent advice without conflating it with human disposition. */
export const PullRequestReviewPanel = ({
  canEnqueue,
  onCancelPublication,
  onLoadEarlier = () => undefined,
  onPreviewPublication,
  onPublishSuggestion,
  onRetry,
  onStart,
  publication,
  state
}: {
  readonly canEnqueue: boolean
  readonly onCancelPublication: () => void
  readonly onLoadEarlier?: () => void
  readonly onPreviewPublication: (selection: ReviewSuggestionPublicationSelection) => void
  readonly onPublishSuggestion: (finalContent: string) => void
  readonly onRetry: () => void
  readonly onStart: (prompt?: DurableAgentPrompt) => void
  readonly publication: PullRequestReviewPublicationState
  readonly state: PullRequestReviewControllerState
}): ReactElement => {
  const [launchOpen, setLaunchOpen] = useState(false)
  const [request, setRequest] = useState("")
  const [submittedRequest, setSubmittedRequest] = useState<string | null>(null)
  const requestScope =
    state._tag === "idle"
      ? null
      : `${state.entityId}:${state.baseRevision ?? ""}:${state.headRevision}:${state.sessionKey}`
  useEffect(() => {
    setLaunchOpen(false)
    setRequest("")
    setSubmittedRequest(null)
  }, [requestScope])
  useEffect(() => {
    if (submittedRequest === null || state._tag !== "ready") return
    if (state.action === "failed") {
      setSubmittedRequest(null)
      return
    }
    if (state.action === "idle" && state.review._tag === "pending") {
      setRequest((current) => (current.trim() === submittedRequest ? "" : current))
      setSubmittedRequest(null)
    }
  }, [state, submittedRequest])
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
  const threadEvents = state.thread?.events ?? []
  const presentedThreadEvents = threadEvents
    .map((event) => ({ event, summary: threadEventSummary(event) }))
    .filter(
      (
        item
      ): item is {
        readonly event: PullRequestReviewThreadEvent
        readonly summary: string
      } => item.summary !== null
    )
  const visibleThreadEvents = state.thread?.historyLoaded ? presentedThreadEvents : presentedThreadEvents.slice(-12)
  const threadSurface = (
    <section aria-label="Review thread" className={styles.reviewThread}>
      <header>
        <strong>Review thread</strong>
        <span>{threadEvents.length === 0 ? "No runs yet" : "Durable across pull-request heads"}</span>
      </header>
      {visibleThreadEvents.length === 0 ? null : (
        <ol className={styles.reviewThreadEvents}>
          {visibleThreadEvents.map(({ event, summary }) => (
            <li key={event.eventSequence}>
              <span>{summary}</span>
            </li>
          ))}
        </ol>
      )}
      {state.thread?.hasEarlier ? (
        <Button loading={state.historyAction === "loading"} onClick={onLoadEarlier}>
          {state.historyAction === "loading"
            ? "Loading earlier activity…"
            : state.historyAction === "failed"
              ? "Retry earlier activity"
              : "Load earlier activity"}
        </Button>
      ) : state.thread?.historyLoaded ? (
        <Text tone="secondary" variant="meta">
          Beginning of review thread
        </Text>
      ) : null}
      {canEnqueue && state.provider !== null && review._tag !== "pending" && review._tag !== "unavailable" ? (
        <div className={styles.reviewThreadComposer}>
          <label htmlFor="review-thread-request">Ask Relay about this pull request</label>
          <textarea
            id="review-thread-request"
            maxLength={MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH}
            onChange={(event) => setRequest(event.currentTarget.value)}
            placeholder="Re-check the error handling in the connection flow…"
            rows={3}
            value={request}
          />
          <Button
            disabled={state.action === "starting" || request.trim().length === 0}
            onClick={() => {
              const prompt = request.trim()
              if (prompt.length === 0) return
              setSubmittedRequest(prompt)
              onStart(prompt)
            }}
          >
            {state.action === "starting" ? "Starting…" : "Start targeted review"}
          </Button>
        </div>
      ) : null}
    </section>
  )
  const withThread = (content: ReactElement): ReactElement =>
    withPublication(
      <>
        {content}
        {threadSurface}
      </>
    )
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
    return withThread(
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
    return withThread(
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
    return withThread(
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
    return withThread(
      <>
        <strong>{outcomeLabel(review.outcome)}</strong>
        {review.report.completion.status === "unable-to-conclude" ? (
          <Text>{review.report.completion.reason}</Text>
        ) : null}
        {review.report.suggestions.length === 0 ? (
          <span>No validated suggestions were retained for this exact head.</span>
        ) : (
          <ol className={styles.reviewFindings}>
            {review.report.suggestions.map((suggestion) => (
              <li key={suggestion.suggestionId}>
                <ReviewSuggestionCard
                  canPublish={canEnqueue}
                  isPreviewing={
                    publication._tag === "previewing" && publication.selection.suggestionId === suggestion.suggestionId
                  }
                  jobId={review.jobId}
                  onPreviewPublication={onPreviewPublication}
                  suggestion={suggestion}
                />
              </li>
            ))}
          </ol>
        )}
        <ReviewNotes notes={review.report.notes} />
        <span>Agent advice only. A person must still approve or request changes.</span>
      </>
    )
  }

  return withThread(
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
