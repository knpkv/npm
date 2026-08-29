import { Button, Dialog, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import {
  type KeyboardEvent,
  type ReactElement,
  type UIEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"

import {
  MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH,
  type DurableAgentProviderId,
  type DurableAgentPrompt,
  type PullRequestReviewFailure,
  type PullRequestReviewThreadEvent
} from "../../api/agent.js"
import type { PrReviewOrientation, PrReviewSuggestion } from "../../domain/prReview.js"
import { ReviewNotes, ReviewSuggestionCard } from "./ReviewSuggestionPresentation.js"
import { VersionedReviewSuggestionCard } from "./VersionedReviewSuggestionCard.js"
import type { ReviewSuggestionRevisionTransport } from "./useReviewSuggestionRevisions.js"
import type {
  PullRequestReviewControllerState,
  PullRequestReviewPublicationState,
  ReviewSuggestionPublicationTarget,
  ReviewSuggestionTarget
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

const providerIdName = (providerId: DurableAgentProviderId): string => {
  switch (providerId) {
    case "codex":
      return "Codex"
    case "claude":
      return "Claude"
    case "relay-gateway":
      return "Relay Gateway"
    default:
      return providerId
  }
}

const providerName = (
  provider: NonNullable<Extract<PullRequestReviewControllerState, { readonly _tag: "ready" }>["provider"]>
): string => provider.displayName ?? providerIdName(provider.providerId)

const providerReviewLabel = (provider: Parameters<typeof providerName>[0]): string => `${providerName(provider)} review`

const modelName = (providerId: DurableAgentProviderId, model: string): string =>
  model === "configured-default" || (providerId === "claude" && model === "default") ? "CLI default" : model

const networkAccessLabel = (networkAccess: "blocked" | "provider-enabled", provider: string): string =>
  networkAccess === "blocked" ? "Network blocked" : `${provider} access enabled`

const failureHeading = (stage: PullRequestReviewFailure["stage"]): string => {
  switch (stage) {
    case "source-checkout":
      return "Source checkout failed"
    case "review-setup":
      return "Review setup is incomplete"
    case "sandbox-start":
      return "Review sandbox failed to start"
    case "agent-run":
      return "Agent review failed"
    case "cleanup":
      return "Review cleanup did not finish"
    case "result-validation":
      return "Review result was invalid"
    case "control-center":
      return "Control Center could not save the review"
  }
}

const failureCause = (cause: PullRequestReviewFailure["cause"]): string | null => {
  switch (cause) {
    case undefined:
      return null
    case "invalid-configuration":
      return "The Review Sandbox configuration is invalid."
    case "invalid-request":
      return "Control Center rejected the generated review command."
    case "source-rejected":
      return "The source exceeded review safety limits or failed validation."
    case "source-unavailable":
      return "CodeCommit source could not be materialized."
    case "sandbox-unavailable":
      return "sbx could not create or reach the review sandbox."
    case "sandbox-timeout":
      return "The review sandbox did not become ready in time."
    case "command-timeout":
      return "The review command exceeded its time budget."
    case "provider-authentication":
      return "The agent provider rejected its credentials or required API access is missing."
    case "provider-rate-limited":
      return "The agent provider rate-limited this review."
    case "provider-unavailable":
      return "The agent provider could not be reached."
    case "agent-command-failed":
      return "The agent command exited before producing a review."
    case "output-rejected":
      return "The review command returned output outside the safe limits."
    case "artifact-unavailable":
      return "The retained review output could not be read."
    case "session-closed":
      return "The review sandbox closed before the command finished."
    case "cleanup-failed":
      return "The run ended, but sbx cleanup did not complete."
  }
}

const failureGuidance = ({ retryable, stage }: PullRequestReviewFailure): string => {
  if (retryable && stage !== "cleanup") return "The failure may be temporary. Retry this exact-head review."
  switch (stage) {
    case "source-checkout":
      return "Check the CodeCommit connection, AWS credentials, region, and repository access."
    case "review-setup":
      return "Check the workspace review policy and selected runner."
    case "sandbox-start":
      return "Check the sbx installation and Review sandbox configuration."
    case "agent-run":
      return "Check the selected review runner and its authentication."
    case "cleanup":
      return "Check sbx status and reconcile the orphaned review sandbox before retrying."
    case "result-validation":
      return "The runner returned a result Control Center could not safely accept. Check its version and configuration."
    case "control-center":
      return "Check Control Center storage and worker health before starting a new review."
  }
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

const ReviewPresetChoices = ({
  accessibleName,
  groupName,
  onSelect,
  presets,
  selectedProviderId
}: {
  readonly accessibleName: string
  readonly groupName: string
  readonly onSelect: (providerId: DurableAgentProviderId) => void
  readonly presets: ReadonlyArray<Parameters<typeof providerName>[0]>
  readonly selectedProviderId: DurableAgentProviderId
}): ReactElement => (
  <fieldset aria-label={accessibleName} className={styles.reviewPresetList}>
    {presets.map((preset) => (
      <label key={preset.providerId}>
        <input
          checked={preset.providerId === selectedProviderId}
          name={groupName}
          onChange={() => onSelect(preset.providerId)}
          type="radio"
          value={preset.providerId}
        />
        <span>
          <strong>{providerReviewLabel(preset)}</strong>
          <small>{modelName(preset.providerId, preset.model)}</small>
        </span>
      </label>
    ))}
  </fieldset>
)

type PresentedThreadEvent = {
  readonly event: PullRequestReviewThreadEvent
  readonly summary: string
}

const THREAD_END_THRESHOLD = 24

const ReviewThreadTranscript = ({
  events,
  hasEarlier,
  historyAction,
  historyLoaded,
  onLoadEarlier
}: {
  readonly events: ReadonlyArray<PresentedThreadEvent>
  readonly hasEarlier: boolean
  readonly historyAction: "idle" | "loading" | "failed"
  readonly historyLoaded: boolean
  readonly onLoadEarlier: () => void
}): ReactElement => {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const followsLatestRef = useRef(true)
  const previousRef = useRef<{
    readonly first: number | null
    readonly firstOffsetTop: number
    readonly last: number | null
  }>({ first: null, firstOffsetTop: 0, last: null })
  const [hasNewActivity, setHasNewActivity] = useState(false)
  const first = events[0]?.event.eventSequence ?? null
  const last = events.at(-1)?.event.eventSequence ?? null

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    const previous = previousRef.current
    const prepended = previous.first !== null && first !== null && first < previous.first
    const appended = previous.last !== null && last !== null && last > previous.last
    const previousFirstElement = [...scroller.querySelectorAll<HTMLElement>("[data-review-event-sequence]")].find(
      (element) => element.dataset.reviewEventSequence === String(previous.first)
    )
    if (prepended && previousFirstElement !== undefined) {
      scroller.scrollTop += previousFirstElement.offsetTop - previous.firstOffsetTop
      const followsLatest = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= THREAD_END_THRESHOLD
      followsLatestRef.current = followsLatest
      setHasNewActivity(appended && !followsLatest)
    } else if (followsLatestRef.current) {
      scroller.scrollTop = scroller.scrollHeight
      setHasNewActivity(false)
    } else if (appended) {
      setHasNewActivity(true)
    }
    const firstElement = scroller.querySelector<HTMLElement>("[data-review-event-sequence]")
    previousRef.current = { first, firstOffsetTop: firstElement?.offsetTop ?? 0, last }
  }, [first, last])

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    const scroller = event.currentTarget
    const followsLatest = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= THREAD_END_THRESHOLD
    followsLatestRef.current = followsLatest
    if (followsLatest) setHasNewActivity(false)
  }
  const jumpToLatest = (): void => {
    const scroller = scrollerRef.current
    if (scroller === null) return
    followsLatestRef.current = true
    scroller.scrollTop = scroller.scrollHeight
    setHasNewActivity(false)
    scroller.focus({ preventScroll: true })
  }

  return (
    <>
      <div
        aria-label="Review activity"
        aria-live="polite"
        aria-relevant="additions text"
        className={styles.reviewThreadTranscript}
        onScroll={handleScroll}
        ref={scrollerRef}
        role="log"
        tabIndex={0}
      >
        {hasEarlier ? (
          <Button loading={historyAction === "loading"} onClick={onLoadEarlier}>
            {historyAction === "loading"
              ? "Loading earlier activity…"
              : historyAction === "failed"
                ? "Retry earlier activity"
                : "Load earlier activity"}
          </Button>
        ) : historyLoaded ? (
          <Text tone="secondary" variant="meta">
            Beginning of review thread
          </Text>
        ) : null}
        {events.length === 0 ? null : (
          <ol className={styles.reviewThreadEvents}>
            {events.map(({ event, summary }) => (
              <li data-review-event-sequence={event.eventSequence} key={event.eventSequence}>
                <span>{summary}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {hasNewActivity ? <Button onClick={jumpToLatest}>New activity · Jump to latest</Button> : null}
    </>
  )
}

const ReviewSuggestionPublicationSurface = lazy(() => import("./ReviewSuggestionPublicationSurface.js"))

const ReviewOrientationSurface = ({
  orientation
}: {
  readonly orientation: PrReviewOrientation | undefined
}): ReactElement | null =>
  orientation === undefined ? null : (
    <section aria-label="Pull request orientation" className={styles.reviewOrientation}>
      <header>
        <strong>What this PR changes</strong>
        <Text tone="secondary" variant="body">
          {orientation.summary}
        </Text>
      </header>
      {orientation.cohorts.map((cohort, cohortIndex) => (
        <article key={`${String(cohortIndex)}:${cohort.title}`}>
          <h3>{cohort.title}</h3>
          <p>{cohort.summary}</p>
          <ol>
            {cohort.layers.map((layer, layerIndex) => (
              <li key={`${String(layerIndex)}:${layer.title}`}>
                <strong>{`${layer.kind} · ${layer.title}`}</strong>
                <span>{layer.summary}</span>
                <small>
                  {layer.ranges
                    .map(
                      ({ endLine, label, path, startLine }) =>
                        `${label} · ${path}:${String(startLine)}${endLine === startLine ? "" : `–${String(endLine)}`}`
                    )
                    .join(" · ")}
                </small>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  )

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
      return `${failureHeading(event.stage)}${event.cause === undefined ? "" : ` · ${failureCause(event.cause)}`}${
        event.retryable ? " · retryable" : ""
      }`
    case "run-interrupted":
      return "Run interrupted · Control Center restarted"
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
  onCancelReview = () => undefined,
  onExtendReviewBudget = () => undefined,
  onLoadEarlier = () => undefined,
  onPreviewPublication,
  onPublishSuggestion,
  onRetry,
  onStart,
  onSuggestionRevisionAccepted,
  onTargetSuggestion = () => undefined,
  publication,
  revisionTransport,
  state,
  suggestions
}: {
  readonly canEnqueue: boolean
  readonly onCancelReview?: () => void
  readonly onCancelPublication: () => void
  readonly onExtendReviewBudget?: () => void
  readonly onLoadEarlier?: () => void
  readonly onPreviewPublication: (selection: ReviewSuggestionPublicationTarget) => void
  readonly onPublishSuggestion: (finalContent: string) => void
  readonly onTargetSuggestion?: (target: ReviewSuggestionTarget) => void
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
  const [requestedSelection, setRequestedSelection] = useState<number | null>(null)
  const [submittedRequest, setSubmittedRequest] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<DurableAgentProviderId | null>(null)
  const requestRef = useRef<HTMLTextAreaElement>(null)
  const targetedSubmissionInFlightRef = useRef(false)
  const providerPresets = useMemo(
    () => (state._tag === "ready" ? (state.providerPresets ?? (state.provider === null ? [] : [state.provider])) : []),
    [state]
  )
  const selectedProvider =
    providerPresets.find(({ providerId }) => providerId === selectedProviderId) ?? providerPresets[0] ?? null
  const durableProviderName = (providerId: DurableAgentProviderId): string => {
    const preset = providerPresets.find((candidate) => candidate.providerId === providerId)
    return preset === undefined ? providerIdName(providerId) : providerName(preset)
  }
  const requestScope =
    state._tag === "idle"
      ? null
      : `${state.entityId}:${state.baseRevision ?? ""}:${state.headRevision}:${state.sessionKey}`
  useEffect(() => {
    setLaunchOpen(false)
    setRequest("")
    setRequestedSelection(null)
    setSubmittedRequest(null)
    setSelectedProviderId(null)
    targetedSubmissionInFlightRef.current = false
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
  useLayoutEffect(() => {
    if (requestedSelection === null) return
    const textarea = requestRef.current
    if (textarea === null) return
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(requestedSelection, requestedSelection)
    setRequestedSelection(null)
  }, [request, requestedSelection])
  useEffect(() => {
    if (submittedRequest === null || state._tag !== "ready") return
    if (state.action === "failed") {
      targetedSubmissionInFlightRef.current = false
      return
    }
    if (state.action === "idle" && state.review._tag === "pending") {
      targetedSubmissionInFlightRef.current = false
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
    if (
      prompt.length === 0 ||
      selectedProvider === null ||
      targetedSubmissionInFlightRef.current ||
      state._tag !== "ready" ||
      state.action === "starting" ||
      state.review._tag === "pending"
    )
      return
    targetedSubmissionInFlightRef.current = true
    setSubmittedRequest(prompt)
    onStart(prompt, selectedProvider.providerId)
  }, [onStart, request, selectedProvider, state])
  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    submitTargetedReview()
  }
  const insertPromptTemplate = (prompt: string): void => {
    const textarea = requestRef.current
    const selectionStart = textarea?.selectionStart ?? request.length
    const selectionEnd = textarea?.selectionEnd ?? selectionStart
    const before = request.slice(0, selectionStart)
    const after = request.slice(selectionEnd)
    const leadingBreak = before.length > 0 && !/\s$/u.test(before) ? "\n" : ""
    const trailingBreak = after.length > 0 && !/^\s/u.test(after) ? "\n" : ""
    const availableInsertionLength = Math.max(0, MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH - before.length - after.length)
    const insertion = `${leadingBreak}${prompt}${trailingBreak}`.slice(0, availableInsertionLength)
    const nextRequest = `${before}${insertion}${after}`
    setRequest(nextRequest)
    setRequestedSelection(before.length + insertion.length)
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
  const usageJobId =
    review._tag === "stale"
      ? review.previousJobId
      : review._tag === "pending" ||
          review._tag === "completed" ||
          review._tag === "failed" ||
          review._tag === "interrupted"
        ? review.jobId
        : null
  const usageEvents =
    usageJobId === null
      ? []
      : threadEvents.filter(
          (event): event is Extract<PullRequestReviewThreadEvent, { readonly _tag: "usage" }> =>
            event._tag === "usage" && event.jobId === usageJobId
        )
  const usage = usageEvents.reduce(
    (total, event) => ({
      inputTokens: total.inputTokens + event.inputTokens,
      outputTokens: total.outputTokens + event.outputTokens
    }),
    { inputTokens: 0, outputTokens: 0 }
  )
  const usageRun =
    usageJobId === null
      ? null
      : threadEvents.find(
          (event): event is Extract<PullRequestReviewThreadEvent, { readonly _tag: "run-queued" }> =>
            event._tag === "run-queued" && event.jobId === usageJobId
        )
  const completeUsageVisible =
    state.thread !== undefined && (!state.thread.hasEarlier || (usageRun !== null && usageRun !== undefined))
  const missingUsageLabel = completeUsageVisible ? "Not reported" : "Load earlier history"
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
  const reviewRunning = review._tag === "pending"
  const composerDisabled = state.action === "starting" || reviewRunning
  const threadSurface = (
    <section aria-label="Review thread" className={styles.reviewThread}>
      <header>
        <strong>Review thread</strong>
        <span>{threadEvents.length === 0 ? "No runs yet" : "Durable across pull-request heads"}</span>
      </header>
      {usageJobId === null ? null : (
        <dl aria-label="Review run usage" className={styles.reviewUsage}>
          <div>
            <dt>Agent</dt>
            <dd>
              {usageRun === null || usageRun === undefined
                ? missingUsageLabel
                : `${durableProviderName(usageRun.providerId)} · ${
                    usageRun.model === null ? "model not reported" : modelName(usageRun.providerId, usageRun.model)
                  }`}
            </dd>
          </div>
          <div>
            <dt>Input tokens</dt>
            <dd>
              {!completeUsageVisible || usageEvents.length === 0
                ? missingUsageLabel
                : usage.inputTokens.toLocaleString("en-US")}
            </dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>
              {!completeUsageVisible || usageEvents.length === 0
                ? missingUsageLabel
                : usage.outputTokens.toLocaleString("en-US")}
            </dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>Not reported</dd>
          </div>
        </dl>
      )}
      <ReviewThreadTranscript
        events={visibleThreadEvents}
        hasEarlier={state.thread?.hasEarlier ?? false}
        historyAction={state.historyAction}
        historyLoaded={state.thread !== undefined}
        key={requestScope}
        onLoadEarlier={onLoadEarlier}
      />
      {canEnqueue && state.provider !== null && review._tag !== "unavailable" ? (
        <div className={styles.reviewThreadComposer}>
          <label htmlFor="review-thread-request">
            {reviewRunning ? "Draft the next review request" : "Ask Relay about this pull request"}
          </label>
          {providerPresets.length > 1 ? (
            selectedProvider === null ? null : (
              <ReviewPresetChoices
                accessibleName="Targeted review agent presets"
                groupName="targeted-review-agent"
                onSelect={setSelectedProviderId}
                presets={providerPresets}
                selectedProviderId={selectedProvider.providerId}
              />
            )
          ) : selectedProvider === null ? null : (
            <span className={styles.reviewSelectedPreset}>
              Review with {providerName(selectedProvider)} ·{" "}
              {modelName(selectedProvider.providerId, selectedProvider.model)}
            </span>
          )}
          <div aria-label="Review prompt templates" className={styles.reviewTemplateList}>
            {REVIEW_PROMPT_TEMPLATES.map((template) => (
              <Button key={template.label} onClick={() => insertPromptTemplate(template.prompt)}>
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
            ref={requestRef}
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
          <Button disabled={composerDisabled || request.trim().length === 0} onClick={submitTargetedReview}>
            {state.action === "starting"
              ? "Starting targeted review…"
              : reviewRunning
                ? "Review in progress"
                : "Start targeted review"}
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
  const reviewLaunch = (headRevision: string, triggerLabel: string, repeat = false): ReactElement | null =>
    selectedProvider === null ? null : (
      <Dialog.Root onOpenChange={changeLaunchOpen} open={launchOpen}>
        <Dialog.Trigger disabled={state.action === "starting"}>
          {state.action === "starting" ? "Starting review…" : triggerLabel}
        </Dialog.Trigger>
        <Dialog.Content
          className={styles.reviewLaunchDialog}
          description={`${providerName(selectedProvider)} can inspect and temporarily edit the disposable checkout. It cannot approve, comment on, or change this CodeCommit pull request.`}
          title={repeat ? "Review this exact head again" : "Review this exact head"}
        >
          <div className={styles.reviewLaunchBody}>
            <small className={styles.reviewLaunchEyebrow}>No CodeCommit writes</small>
            {providerPresets.length > 1 ? (
              <ReviewPresetChoices
                accessibleName="Review agent presets"
                groupName="full-review-agent"
                onSelect={setSelectedProviderId}
                presets={providerPresets}
                selectedProviderId={selectedProvider.providerId}
              />
            ) : null}
            <dl className={styles.reviewLaunchFacts}>
              <div>
                <dt>Exact head</dt>
                <dd>
                  <code>{headRevision}</code>
                </dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{providerName(selectedProvider)}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{modelName(selectedProvider.providerId, selectedProvider.model)}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>Full project</dd>
              </div>
              <div>
                <dt>Budget</dt>
                <dd>{formatBudget(selectedProvider.reviewProfile.budgetMillis)}</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>
                  {networkAccessLabel(selectedProvider.reviewProfile.networkAccess, providerName(selectedProvider))}
                </dd>
              </div>
              <div>
                <dt>Isolation</dt>
                <dd>Disposable sbx sandbox</dd>
              </div>
            </dl>
            <div className={styles.reviewLaunchActions}>
              <Dialog.Close>Cancel</Dialog.Close>
              <Dialog.Close onClick={submitFullReview}>Start full-project review</Dialog.Close>
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
    const startedAt = review.startedAt ?? null
    const budgetMillis = review.budgetMillis ?? review.reviewProfile.budgetMillis
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
          {durableProviderName(review.providerId)} · {modelName(review.providerId, review.model)}. This page updates
          automatically.
        </span>
        <span>
          {networkAccessLabel(review.reviewProfile.networkAccess, durableProviderName(review.providerId))} · Disposable
          sbx sandbox
        </span>
        <dl>
          <div>
            <dt>Elapsed</dt>
            <dd>
              {startedAt === null
                ? "Waiting for worker"
                : formatBudget(
                    Math.max(0, DateTime.toEpochMillis(DateTime.nowUnsafe()) - DateTime.toEpochMillis(startedAt))
                  )}
            </dd>
          </div>
          <div>
            <dt>Remaining budget</dt>
            <dd>
              {startedAt === null
                ? formatBudget(budgetMillis)
                : formatBudget(
                    Math.max(
                      0,
                      budgetMillis - (DateTime.toEpochMillis(DateTime.nowUnsafe()) - DateTime.toEpochMillis(startedAt))
                    )
                  )}
            </dd>
          </div>
          <div>
            <dt>Current step</dt>
            <dd>{review.activity.events.at(-1) ?? "Fetching exact source and starting the sandbox…"}</dd>
          </div>
        </dl>
        {review.activity.events.length === 0 ? null : (
          <ol aria-label="Live review activity">
            {review.activity.events.map((event, index) => (
              <li key={`${String(index)}:${event}`}>{event}</li>
            ))}
          </ol>
        )}
        {review.activity.truncated ? <span>Earlier review activity is not shown.</span> : null}
        {canEnqueue ? (
          <div>
            {review.budgetExtensionCount === 0 ? (
              <Button onClick={onExtendReviewBudget}>{`Add ${formatBudget(review.reviewProfile.budgetMillis)}`}</Button>
            ) : (
              <span>One budget extension used.</span>
            )}
            <Button onClick={onCancelReview}>Cancel review</Button>
          </div>
        ) : null}
        <code className={styles.reviewHead}>{review.subject.headRevision}</code>
        <span aria-hidden="true" className={styles.reviewRunway} />
      </div>
    )
  }
  if (review._tag === "stale") {
    const previousReviewCompleted = review.previousState === "succeeded"
    return (
      <>
        <div aria-live="polite" className={styles.reviewStatus} role="status">
          <strong>New head available</strong>
          {previousReviewCompleted ? (
            <span>
              The last completed review belongs to an older immutable revision. Its findings cannot be published against
              the current head.
            </span>
          ) : (
            <span>
              The previous review did not finish and belongs to an older immutable revision. Its retained findings are
              incomplete and cannot be published against the current head.
            </span>
          )}
          <dl>
            <div>
              <dt>Last reviewed</dt>
              <dd>
                <code>{review.previousHead}</code>
              </dd>
            </div>
            <div>
              <dt>Current head</dt>
              <dd>
                <code>{review.subject.headRevision}</code>
              </dd>
            </div>
          </dl>
          <ReviewOrientationSurface orientation={review.previousReport.orientation} />
          {review.previousReport.suggestions.length === 0 ? (
            <span>The previous review retained no validated suggestions.</span>
          ) : (
            <ol aria-label="Previous review findings" className={styles.reviewFindings}>
              {review.previousReport.suggestions.map((suggestion) => (
                <li key={suggestion.suggestionId}>
                  <ReviewSuggestionCard
                    canPublish={false}
                    isPreviewing={false}
                    jobId={review.previousJobId}
                    onPreviewPublication={() => undefined}
                    suggestion={suggestion}
                  />
                </li>
              ))}
            </ol>
          )}
          <ReviewNotes notes={review.previousReport.notes} />
          <span>Previous-head findings are read-only. Start a current-head review before publishing anything.</span>
          {!canEnqueue ? (
            <span>Only a workspace owner can start the new review.</span>
          ) : state.provider === null ? (
            <span>Configure an sbx Review Agent Profile to review the new head.</span>
          ) : (
            <>
              {reviewLaunch(review.subject.headRevision, "Review current head")}
              {state.action === "failed" ? (
                <span role="alert">
                  The current-head review could not be started. Check the provider and worker, then try again.
                </span>
              ) : null}
            </>
          )}
        </div>
        {threadSurface}
      </>
    )
  }
  if (review._tag === "failed") {
    const report = review.report
    const failure = review.failure ?? null
    return withThread(
      <>
        <strong>
          {review.state === "cancelled"
            ? "Review cancelled"
            : failure === null
              ? "Review did not finish"
              : failureHeading(failure.stage)}
        </strong>
        {review.state === "failed" && failure !== null ? <span>{failureGuidance(failure)}</span> : null}
        {review.state === "failed" && failure !== null && failureCause(failure.cause) !== null ? (
          <span>Cause: {failureCause(failure.cause)}</span>
        ) : null}
        {report == null ? (
          <span>The failed run did not change approval or publish a recommendation.</span>
        ) : (
          <>
            <Text>
              This review is incomplete. The retained findings were validated before the run stopped; unreviewed areas
              remain.
            </Text>
            <ReviewOrientationSurface orientation={report.orientation} />
            {report.suggestions.length === 0 ? (
              <span>No validated suggestions were retained before the run stopped.</span>
            ) : (
              <ol className={styles.reviewFindings}>
                {report.suggestions.map((suggestion) => (
                  <li key={suggestion.suggestionId}>
                    <VersionedReviewSuggestionCard
                      canEdit={canEnqueue}
                      entityId={state.entityId}
                      isPreviewing={
                        publication._tag === "previewing" &&
                        publication.selection.suggestionId === suggestion.suggestionId
                      }
                      jobId={review.jobId}
                      onPreviewPublication={onPreviewPublication}
                      onTargetSuggestion={onTargetSuggestion}
                      {...(onSuggestionRevisionAccepted === undefined ? {} : { onSuggestionRevisionAccepted })}
                      {...(revisionTransport === undefined ? {} : { revisionTransport })}
                      sessionKey={state.sessionKey}
                      suggestion={suggestion}
                    />
                  </li>
                ))}
              </ol>
            )}
            <ReviewNotes notes={report.notes} />
            <span>Retained findings remain advice only and may be published after confirmation.</span>
          </>
        )}
        {canEnqueue && state.provider !== null ? (
          <>
            {state.action === "failed" && submittedRequest === null ? (
              <span role="alert">
                A new full review could not be started. Check the provider and worker, then try again.
              </span>
            ) : null}
            {reviewLaunch(
              review.subject.headRevision,
              failure?.retryable === false ? "Review again" : "Retry review",
              true
            )}
          </>
        ) : null}
      </>
    )
  }
  if (review._tag === "interrupted") {
    return withThread(
      <>
        <strong>Review interrupted by restart</strong>
        <Text>
          Control Center restarted before this run finished. The retained findings were validated before the run
          stopped; unreviewed areas remain.
        </Text>
        <ReviewOrientationSurface orientation={review.report.orientation} />
        {review.report.suggestions.length === 0 ? (
          <span>No validated suggestions were retained before the run stopped.</span>
        ) : (
          <ol className={styles.reviewFindings}>
            {review.report.suggestions.map((suggestion) => (
              <li key={suggestion.suggestionId}>
                <VersionedReviewSuggestionCard
                  canEdit={canEnqueue}
                  entityId={state.entityId}
                  isPreviewing={
                    publication._tag === "previewing" && publication.selection.suggestionId === suggestion.suggestionId
                  }
                  jobId={review.jobId}
                  onPreviewPublication={onPreviewPublication}
                  onTargetSuggestion={onTargetSuggestion}
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
        <span>Retained findings remain advice only and may be published after confirmation.</span>
        {canEnqueue && state.provider !== null ? (
          <>
            {state.action === "failed" && submittedRequest === null ? (
              <span role="alert">
                A new full review could not be started. Check the provider and worker, then try again.
              </span>
            ) : null}
            {reviewLaunch(review.subject.headRevision, "Start a new review")}
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
        <ReviewOrientationSurface orientation={review.report.orientation} />
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
                  onTargetSuggestion={onTargetSuggestion}
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
        <span>Agent advice only. Preview and confirm a finding to post it to CodeCommit, or dismiss it locally.</span>
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
        <span>
          PR review is not configured. Enable Codex, Claude, or an Effect AI review runner on the Control Center server.
          The workspace must allow that provider with Review sandbox and Isolated profile.
        </span>
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
