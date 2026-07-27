import { Button, Dialog, Text } from "@knpkv/rly/primitives"
import { type KeyboardEvent, type ReactElement, lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"

import {
  MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH,
  type DurableAgentProviderId,
  type DurableAgentPrompt,
  type PullRequestReviewThreadEvent
} from "../../api/agent.js"
import type { PrReviewSuggestion } from "../../domain/prReview.js"
import { ReviewNotes } from "./ReviewSuggestionPresentation.js"
import { VersionedReviewSuggestionCard } from "./VersionedReviewSuggestionCard.js"
import type { ReviewSuggestionRevisionTransport } from "./useReviewSuggestionRevisions.js"
import type {
  PullRequestReviewControllerState,
  PullRequestReviewPublicationState,
  ReviewSuggestionPublicationTarget
} from "./usePullRequestReview.js"
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

const REVIEW_PROMPT_TEMPLATES: ReadonlyArray<{
  readonly label: string
  readonly prompt: string
}> = [
  {
    label: "Correctness",
    prompt: "Review correctness, regressions, error handling, and boundary conditions."
  },
  {
    label: "Security",
    prompt: "Review authorization, credential handling, unsafe input, and privilege boundaries."
  },
  {
    label: "Tests",
    prompt: "Review test coverage, failure paths, race conditions, and missing regression guardrails."
  }
]

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
    case "suggestion-revised":
      return event.suggestionState === "dismissed"
        ? `Suggestion revision ${String(event.sequence)} · dismissed by operator`
        : `Suggestion revision ${String(event.sequence)} · ${event.validationState === "validated" ? "validated" : "needs revalidation"}`
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
  onSuggestionRevisionAccepted,
  publication,
  revisionTransport,
  state,
  suggestions
}: {
  readonly canEnqueue: boolean
  readonly onCancelPublication: () => void
  readonly onLoadEarlier?: () => void
  readonly onPreviewPublication: (selection: ReviewSuggestionPublicationTarget) => void
  readonly onPublishSuggestion: (finalContent: string) => void
  readonly onRetry: () => void
  readonly onStart: (prompt?: DurableAgentPrompt, providerId?: DurableAgentProviderId) => void
  readonly onSuggestionRevisionAccepted?: (suggestion: PrReviewSuggestion) => void
  readonly publication: PullRequestReviewPublicationState
  readonly revisionTransport?: ReviewSuggestionRevisionTransport
  readonly state: PullRequestReviewControllerState
  readonly suggestions?: ReadonlyArray<PrReviewSuggestion>
}): ReactElement => {
  const [launchOpen, setLaunchOpen] = useState(false)
  const [request, setRequest] = useState("")
  const [submittedRequest, setSubmittedRequest] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<DurableAgentProviderId | null>(null)
  const providerPresets = useMemo(
    () => (state._tag === "ready" ? (state.providerPresets ?? (state.provider === null ? [] : [state.provider])) : []),
    [state]
  )
  const selectedProvider =
    providerPresets.find(({ providerId }) => providerId === selectedProviderId) ?? providerPresets[0] ?? null
  const requestScope =
    state._tag === "idle"
      ? null
      : `${state.entityId}:${state.baseRevision ?? ""}:${state.headRevision}:${state.sessionKey}`
  useEffect(() => {
    setLaunchOpen(false)
    setRequest("")
    setSubmittedRequest(null)
    setSelectedProviderId(null)
  }, [requestScope])
  useEffect(() => {
    if (providerPresets.length === 0) {
      setSelectedProviderId(null)
      return
    }
    if (!providerPresets.some(({ providerId }) => providerId === selectedProviderId)) {
      setSelectedProviderId(providerPresets[0]?.providerId ?? null)
    }
  }, [providerPresets, selectedProviderId])
  useEffect(() => {
    if (submittedRequest === null || state._tag !== "ready") return
    if (state.action === "failed") return
    if (state.action === "idle" && state.review._tag === "pending") {
      setRequest((current) => (current.trim() === submittedRequest ? "" : current))
      setSubmittedRequest(null)
    }
  }, [state, submittedRequest])
  const changeLaunchOpen = useCallback((open: boolean): void => {
    setLaunchOpen(open)
  }, [])
  const submitFullReview = useCallback((): void => {
    if (selectedProvider === null) return
    setSubmittedRequest(null)
    onStart(undefined, selectedProvider.providerId)
  }, [onStart, selectedProvider])
  const submitTargetedReview = useCallback((): void => {
    const prompt = request.trim()
    if (prompt.length === 0 || state._tag !== "ready" || state.action === "starting") return
    setSubmittedRequest(prompt)
    if (selectedProvider === null) return
    onStart(prompt, selectedProvider.providerId)
  }, [onStart, request, selectedProvider, state])
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    submitTargetedReview()
  }
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
      <div aria-live="polite" className={styles.reviewStatus} role="status">
        <strong>Loading review state</strong>
        <span>Checking durable review history for this exact head.</span>
        <span aria-hidden="true" className={styles.reviewRunway} />
      </div>
    )
  }
  if (state._tag === "failed") {
    return withPublication(
      <div className={styles.reviewStatus}>
        <strong>Review state unavailable</strong>
        <span>The current review could not be loaded. No human decision was changed.</span>
        <Button onClick={onRetry}>Retry</Button>
      </div>
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
  const completeThreadVisible = state.thread !== undefined && (state.thread.historyLoaded || !state.thread.hasEarlier)
  const visibleThreadEvents = completeThreadVisible ? presentedThreadEvents : presentedThreadEvents.slice(-12)
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
      ) : state.thread !== undefined ? (
        <Text tone="secondary" variant="meta">
          Beginning of review thread
        </Text>
      ) : null}
      {canEnqueue && state.provider !== null && review._tag !== "pending" && review._tag !== "unavailable" ? (
        <div className={styles.reviewThreadComposer}>
          <label htmlFor="review-thread-request">Ask Relay about this pull request</label>
          {providerPresets.length > 1 ? (
            <div aria-label="Targeted review agent presets" className={styles.reviewPresetList} role="radiogroup">
              {providerPresets.map((preset) => (
                <button
                  aria-checked={preset.providerId === selectedProvider?.providerId}
                  key={preset.providerId}
                  onClick={() => setSelectedProviderId(preset.providerId)}
                  role="radio"
                  type="button"
                >
                  <strong>
                    {preset.providerId === "codex"
                      ? "Codex review"
                      : preset.providerId === "claude"
                        ? "Claude review"
                        : preset.providerId}
                  </strong>
                  <span>{preset.model}</span>
                </button>
              ))}
            </div>
          ) : selectedProvider === null ? null : (
            <span className={styles.reviewSelectedPreset}>
              Review with {selectedProvider.providerId} · {selectedProvider.model}
            </span>
          )}
          <div aria-label="Review prompt templates" className={styles.reviewTemplateList}>
            {REVIEW_PROMPT_TEMPLATES.map((template) => (
              <Button key={template.label} onClick={() => setRequest(template.prompt)}>
                {template.label}
              </Button>
            ))}
          </div>
          <textarea
            aria-describedby="review-thread-request-help review-thread-request-count"
            id="review-thread-request"
            maxLength={MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH}
            onChange={(event) => setRequest(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Re-check the error handling in the connection flow…"
            rows={3}
            value={request}
          />
          <div className={styles.reviewThreadComposerFooter}>
            <span id="review-thread-request-help">Ctrl/⌘ + Enter to run</span>
            <span id="review-thread-request-count">
              {String(request.length)} / {String(MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH)}
            </span>
          </div>
          {state.action === "failed" && submittedRequest !== null ? (
            <span role="alert">
              Targeted review did not start. Your request is still here—check the provider and worker, then try again.
            </span>
          ) : null}
          <Button disabled={state.action === "starting" || request.trim().length === 0} onClick={submitTargetedReview}>
            {state.action === "starting" ? "Starting targeted review…" : "Start targeted review"}
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
  const reviewLaunch = (headRevision: string, triggerLabel: string): ReactElement | null =>
    selectedProvider === null ? null : (
      <Dialog.Root onOpenChange={changeLaunchOpen} open={launchOpen}>
        <Dialog.Trigger disabled={state.action === "starting"}>
          {state.action === "starting" ? "Starting review…" : triggerLabel}
        </Dialog.Trigger>
        <Dialog.Content
          className={styles.reviewLaunchDialog}
          description="Relay will inspect the immutable revision in an isolated sandbox. It cannot approve or change the pull request."
          title="Review this exact head"
        >
          <div className={styles.reviewLaunchBody}>
            <small className={styles.reviewLaunchEyebrow}>Read-only agent run</small>
            {providerPresets.length > 1 ? (
              <div aria-label="Review agent presets" className={styles.reviewPresetList} role="radiogroup">
                {providerPresets.map((preset) => (
                  <button
                    aria-checked={preset.providerId === selectedProvider.providerId}
                    key={preset.providerId}
                    onClick={() => setSelectedProviderId(preset.providerId)}
                    role="radio"
                    type="button"
                  >
                    <strong>
                      {preset.providerId === "codex"
                        ? "Codex review"
                        : preset.providerId === "claude"
                          ? "Claude review"
                          : preset.providerId}
                    </strong>
                    <span>{preset.model}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <dl className={styles.reviewLaunchFacts}>
              <div>
                <dt>Exact head</dt>
                <dd>
                  <code>{headRevision}</code>
                </dd>
              </div>
              <div>
                <dt>Review profile</dt>
                <dd>{selectedProvider.reviewProfile.label}</dd>
              </div>
              <div>
                <dt>Time budget</dt>
                <dd>{formatBudget(selectedProvider.reviewProfile.budgetMillis)}</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>
                  {selectedProvider.reviewProfile.networkAccess === "blocked"
                    ? "Network blocked · sbx"
                    : "Provider connection enabled · sbx"}
                </dd>
              </div>
            </dl>
            <div className={styles.reviewLaunchActions}>
              <Dialog.Close>Keep reading</Dialog.Close>
              <Dialog.Close onClick={submitFullReview}>Start full review</Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Root>
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
      <div aria-live="polite" className={styles.reviewStatus} role="status">
        <strong>{label}</strong>
        <span>
          Relay is using {review.providerId} · {review.model}. This page updates automatically.
        </span>
        <span>
          {review.reviewProfile.label} · {formatBudget(review.reviewProfile.budgetMillis)} ·{" "}
          {review.reviewProfile.networkAccess === "blocked"
            ? "network blocked · sbx"
            : "provider connection enabled · sbx"}
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
        <span aria-hidden="true" className={styles.reviewRunway} />
      </div>
    )
  }
  if (review._tag === "failed") {
    return withThread(
      <>
        <strong>{review.state === "cancelled" ? "Review cancelled" : "Review did not finish"}</strong>
        <span>The failed run did not change approval or publish a recommendation.</span>
        {canEnqueue && state.provider !== null ? (
          <>
            {state.action === "failed" && submittedRequest === null ? (
              <span role="alert">
                A new full review could not be started. Check the provider and worker, then try again.
              </span>
            ) : null}
            {reviewLaunch(review.subject.headRevision, "Try again")}
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
        {(suggestions ?? review.report.suggestions).length === 0 ? (
          <span>No validated suggestions were retained for this exact head.</span>
        ) : (
          <ol className={styles.reviewFindings}>
            {(suggestions ?? review.report.suggestions).map((suggestion) => (
              <li key={suggestion.suggestionId}>
                <VersionedReviewSuggestionCard
                  canEdit={canEnqueue}
                  entityId={state.entityId}
                  isPreviewing={
                    publication._tag === "previewing" && publication.selection.suggestionId === suggestion.suggestionId
                  }
                  jobId={review.jobId}
                  onPreviewPublication={onPreviewPublication}
                  {...(onSuggestionRevisionAccepted === undefined ? {} : { onSuggestionRevisionAccepted })}
                  {...(revisionTransport === undefined ? {} : { revisionTransport })}
                  sessionKey={state.sessionKey}
                  suggestion={suggestion}
                />
              </li>
            ))}
          </ol>
        )}
        <ReviewNotes notes={review.report.notes} />
        <span>Agent advice only. Approve a finding to post it to CodeCommit, or dismiss it locally.</span>
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
        <>{reviewLaunch(review.subject.headRevision, "Review exact head")}</>
      )}
      {state.action === "failed" ? (
        <span role="alert">The review could not be started. Check provider and worker configuration, then retry.</span>
      ) : null}
    </>
  )
}

export default PullRequestReviewPanel
