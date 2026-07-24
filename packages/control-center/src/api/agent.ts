import { MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH } from "@knpkv/ai-runtime"
import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { EntityId, EventCursor, JobId, ReleaseId } from "../domain/identifiers.js"
import { PrReviewReport, PrReviewSubject } from "../domain/prReview.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ForbiddenApiError,
  InvalidRequestApiError,
  NotFoundApiError,
  PayloadTooLargeApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { PortfolioReleaseSummary } from "./portfolio.js"
import { SessionCookieAuth, SessionMutationAuth } from "./session.js"
import { CanonicalNonNegativeIntegerFromString } from "./wire.js"

const MAXIMUM_PROMPT_LENGTH = 8_000
const MAXIMUM_HISTORY_MESSAGES = 12
const MAXIMUM_HISTORY_MESSAGE_LENGTH = 12_000
const MAXIMUM_HISTORY_CONTENT_LENGTH = 64_000
const MAXIMUM_REPLY_LENGTH = 32_000
const MAXIMUM_DURABLE_PROMPT_LENGTH = 5_000
const MAXIMUM_THREAD_EVENT_PAGE_SIZE = 128
const MAXIMUM_AGENT_MODELS_PER_PROVIDER = 32

/** Bounded current instruction sent to the release-aware model. */
export const AgentPrompt = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAXIMUM_PROMPT_LENGTH)
)

/** Decoded release-agent prompt. */
export type AgentPrompt = typeof AgentPrompt.Type

const BoundedHistoryContent = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAXIMUM_HISTORY_MESSAGE_LENGTH)
)

/** Supported local command-line model providers. */
export const AgentProvider = Schema.Literals(["codex", "claude"])

/** Decoded local command-line model provider. */
export type AgentProvider = typeof AgentProvider.Type

/** Provider-neutral configured runtime identity accepted by durable jobs. */
export const DurableAgentProviderId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
).pipe(Schema.brand("DurableAgentProviderId"))

/** Decoded provider-neutral durable runtime identity. */
export type DurableAgentProviderId = typeof DurableAgentProviderId.Type

/** Bounded browser-safe model identifier accepted by the provider registry. */
export const AgentModelId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
).pipe(Schema.brand("AgentModelId"))

/** Decoded browser-safe agent model identifier. */
export type AgentModelId = typeof AgentModelId.Type

/** Safe execution profile whose persisted representation is the existing read-only access mode. */
export const AgentSafeProfile = Schema.Literal("read-only")

/** Decoded safe execution profile. */
export type AgentSafeProfile = typeof AgentSafeProfile.Type

/** Redacted provider health; configuration and transport diagnostics remain server-only. */
export const AgentProviderHealth = Schema.Literals(["available", "not-configured"])

/** Decoded redacted provider health. */
export type AgentProviderHealth = typeof AgentProviderHealth.Type

/** Browser-safe task capabilities supported by one agent provider. */
export const AgentProviderCapability = Schema.Literals(["release-chat", "pr-review"])

/** Decoded browser-safe agent task capability. */
export type AgentProviderCapability = typeof AgentProviderCapability.Type

/** Browser-safe catalog entry for one server-owned agent provider. */
export const AgentProviderCatalogEntry = Schema.Struct({
  providerId: DurableAgentProviderId,
  models: Schema.Array(AgentModelId).check(
    Schema.makeFilter((models) => models.length <= MAXIMUM_AGENT_MODELS_PER_PROVIDER, {
      expected: `at most ${MAXIMUM_AGENT_MODELS_PER_PROVIDER} agent models`
    }),
    Schema.isUnique()
  ),
  capabilities: Schema.Array(AgentProviderCapability).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AgentProviderCapability.literals.length),
    Schema.isUnique()
  ),
  health: AgentProviderHealth
})

/** Decoded browser-safe provider catalog entry. */
export type AgentProviderCatalogEntry = typeof AgentProviderCatalogEntry.Type

/** Redacted catalog for the fixed server-side provider registry. */
export const AgentProviderCatalog = Schema.Struct({
  providers: Schema.Array(AgentProviderCatalogEntry).check(
    Schema.makeFilter((providers) => providers.length <= 3, {
      expected: "at most three agent providers"
    }),
    Schema.makeFilter(
      (providers) => new Set(providers.map(({ providerId }) => providerId)).size === providers.length,
      { expected: "unique agent provider identifiers" }
    )
  )
})

/** Decoded redacted provider catalog. */
export type AgentProviderCatalog = typeof AgentProviderCatalog.Type

/** Prompt guaranteed to fit the durable user-message event envelope. */
export const DurableAgentPrompt = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAXIMUM_DURABLE_PROMPT_LENGTH)
)

/** Decoded durable release-agent prompt. */
export type DurableAgentPrompt = typeof DurableAgentPrompt.Type

/** Release-agent provider alias retained for discoverability beside the turn schemas. */
export const ReleaseAgentProvider = AgentProvider

/** Decoded release-agent provider. */
export type ReleaseAgentProvider = AgentProvider

/** One bounded prior turn supplied to preserve release-thread context. */
export const AgentHistoryMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: BoundedHistoryContent
}).annotate({ identifier: "ReleaseAgentHistoryMessage" })

/** Decoded prior release-agent turn. */
export type AgentHistoryMessage = typeof AgentHistoryMessage.Type

/** History-message alias retained for discoverability beside the turn schemas. */
export const ReleaseAgentHistoryMessage = AgentHistoryMessage

/** Decoded prior release-agent turn. */
export type ReleaseAgentHistoryMessage = AgentHistoryMessage

const ReleaseAgentHistory = Schema.Array(AgentHistoryMessage).check(
  Schema.makeFilter((history) => history.length <= MAXIMUM_HISTORY_MESSAGES, {
    expected: `at most ${MAXIMUM_HISTORY_MESSAGES} release-agent history messages`
  }),
  Schema.makeFilter(
    (history) =>
      history.reduce((length, message) => length + message.content.length, 0) <= MAXIMUM_HISTORY_CONTENT_LENGTH,
    { expected: `at most ${MAXIMUM_HISTORY_CONTENT_LENGTH} release-agent history characters` }
  )
)

/** Bounded browser request for one release-aware model turn. */
export const ReleaseAgentTurnRequest = Schema.Struct({
  provider: AgentProvider,
  prompt: AgentPrompt,
  history: ReleaseAgentHistory
}).annotate({ identifier: "ReleaseAgentTurnRequest" })

/** Decoded release-aware model request. */
export type ReleaseAgentTurnRequest = typeof ReleaseAgentTurnRequest.Type

/** Model reply plus the authoritative release projection used for the turn. */
export const ReleaseAgentTurnResponse = Schema.Struct({
  releaseId: ReleaseId,
  provider: AgentProvider,
  reply: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_REPLY_LENGTH)),
  release: PortfolioReleaseSummary,
  eventCursor: EventCursor
}).check(
  Schema.makeFilter(({ release, releaseId }) => release.releaseId === releaseId, {
    expected: "release-agent response identity to match its release projection"
  })
).annotate({ identifier: "ReleaseAgentTurnResponse" })

/** Decoded release-aware model response. */
export type ReleaseAgentTurnResponse = typeof ReleaseAgentTurnResponse.Type

/** Cursor of the last durable release-thread event observed by a client. */
export const ReleaseAgentThreadCursor = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
).pipe(Schema.brand("ReleaseAgentThreadCursor"))

/** Decoded durable release-thread cursor. */
export type ReleaseAgentThreadCursor = typeof ReleaseAgentThreadCursor.Type

/** Canonical query-string representation of a durable release-thread cursor. */
export const ReleaseAgentThreadCursorFromString = CanonicalNonNegativeIntegerFromString.pipe(
  Schema.decodeTo(ReleaseAgentThreadCursor)
)

/** Bounded caller-selected page size for durable release-thread replay. */
export const ReleaseAgentThreadEventLimitFromString = CanonicalNonNegativeIntegerFromString.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(MAXIMUM_THREAD_EVENT_PAGE_SIZE)
  )
)

const releaseAgentThreadEventFields = {
  eventSequence: ReleaseAgentThreadCursor.check(Schema.isGreaterThan(0)),
  jobId: JobId,
  occurredAt: UtcTimestamp
}

const ReleaseAgentUserMessageEvent = Schema.TaggedStruct("user-message", {
  ...releaseAgentThreadEventFields,
  prompt: DurableAgentPrompt
})

const ReleaseAgentJobQueuedEvent = Schema.TaggedStruct("job-queued", {
  ...releaseAgentThreadEventFields,
  providerId: DurableAgentProviderId
})

const ReleaseAgentJobStartedEvent = Schema.TaggedStruct("job-started", releaseAgentThreadEventFields)

const ReleaseAgentAssistantOutputEvent = Schema.TaggedStruct("assistant-output", {
  ...releaseAgentThreadEventFields,
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH))
})

const ReleaseAgentProgressEvent = Schema.TaggedStruct("progress", {
  ...releaseAgentThreadEventFields,
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH))
})

const ReleaseAgentUsageEvent = Schema.TaggedStruct("usage", {
  ...releaseAgentThreadEventFields,
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const ReleaseAgentJobCompletedEvent = Schema.TaggedStruct("job-completed", {
  ...releaseAgentThreadEventFields,
  outcome: Schema.Literals(["success", "cancelled", "max-steps"])
})

const ReleaseAgentJobFailedEvent = Schema.TaggedStruct("job-failed", {
  ...releaseAgentThreadEventFields,
  retryable: Schema.Boolean
})

const ReleaseAgentCancellationRequestedEvent = Schema.TaggedStruct("cancel-requested", {
  ...releaseAgentThreadEventFields,
  requestedAt: UtcTimestamp
})

/** One browser-safe event from the durable release thread. */
export const ReleaseAgentThreadEvent = Schema.Union([
  ReleaseAgentUserMessageEvent,
  ReleaseAgentJobQueuedEvent,
  ReleaseAgentJobStartedEvent,
  ReleaseAgentAssistantOutputEvent,
  ReleaseAgentProgressEvent,
  ReleaseAgentUsageEvent,
  ReleaseAgentJobCompletedEvent,
  ReleaseAgentJobFailedEvent,
  ReleaseAgentCancellationRequestedEvent
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded browser-safe durable release-thread event. */
export type ReleaseAgentThreadEvent = typeof ReleaseAgentThreadEvent.Type

/** Bounded request to enqueue one durable read-only release-agent job. */
export const EnqueueReleaseAgentJobRequest = Schema.Struct({
  providerId: DurableAgentProviderId,
  model: AgentModelId,
  profile: AgentSafeProfile,
  prompt: DurableAgentPrompt.check(Schema.isMaxLength(2_500))
})

/** Decoded durable release-agent enqueue request. */
export type EnqueueReleaseAgentJobRequest = typeof EnqueueReleaseAgentJobRequest.Type

/** Durable identity returned after the job and its initial events commit. */
export const EnqueueReleaseAgentJobResponse = Schema.Struct({
  releaseId: ReleaseId,
  jobId: JobId,
  state: Schema.Literal("queued")
}).annotate({ identifier: "EnqueueReleaseAgentJobResponse" })

/** Decoded durable release-agent enqueue response. */
export type EnqueueReleaseAgentJobResponse = typeof EnqueueReleaseAgentJobResponse.Type

/** Bounded request to enqueue one immutable read-only pull-request review. */
export const EnqueuePullRequestReviewRequest = Schema.Struct({
  providerId: DurableAgentProviderId,
  model: AgentModelId,
  profile: AgentSafeProfile
})

/** Decoded immutable pull-request review enqueue request. */
export type EnqueuePullRequestReviewRequest = typeof EnqueuePullRequestReviewRequest.Type

const pullRequestReviewIdentity = {
  subject: PrReviewSubject
}

const pullRequestReviewJob = {
  ...pullRequestReviewIdentity,
  jobId: JobId,
  providerId: DurableAgentProviderId,
  model: AgentModelId,
  requestedAt: UtcTimestamp
}

/** Review cannot run for the canonical entity in its current state. */
export class PullRequestReviewUnavailable extends Schema.TaggedClass<PullRequestReviewUnavailable>()("unavailable", {
  reason: Schema.Literals([
    "not-codecommit",
    "not-pull-request",
    "source-stale",
    "release-unavailable",
    "base-revision-unavailable"
  ])
}) {}

/** No durable review exists yet for this exact immutable subject. */
export class PullRequestReviewNotStarted
  extends Schema.TaggedClass<PullRequestReviewNotStarted>()("not-started", pullRequestReviewIdentity)
{}

/** One durable exact-head review is queued or running. */
export class PullRequestReviewPending extends Schema.TaggedClass<PullRequestReviewPending>()("pending", {
  ...pullRequestReviewJob,
  state: Schema.Literals(["queued", "running", "cancel-requested"])
}) {}

/** Sanitized exact-head findings completed without changing human disposition. */
export class PullRequestReviewCompleted extends Schema.TaggedClass<PullRequestReviewCompleted>()("completed", {
  ...pullRequestReviewJob,
  completedAt: UtcTimestamp,
  report: PrReviewReport
}) {}

/** Durable exact-head review stopped without publishing a recommendation. */
export class PullRequestReviewFailed extends Schema.TaggedClass<PullRequestReviewFailed>()("failed", {
  ...pullRequestReviewJob,
  completedAt: UtcTimestamp,
  state: Schema.Literals(["failed", "cancelled"])
}) {}

/** Browser-safe current review state for one canonical pull-request entity. */
export const PullRequestReviewState = Schema.Union([
  PullRequestReviewUnavailable,
  PullRequestReviewNotStarted,
  PullRequestReviewPending,
  PullRequestReviewCompleted,
  PullRequestReviewFailed
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded current pull-request review state. */
export type PullRequestReviewState = typeof PullRequestReviewState.Type

/** Accepted durable review job, including idempotent recovery of active work. */
export const EnqueuePullRequestReviewResponse = PullRequestReviewPending

/** Decoded accepted durable review job. */
export type EnqueuePullRequestReviewResponse = typeof EnqueuePullRequestReviewResponse.Type

/** Ordered, bounded release-thread replay page. */
export const ReleaseAgentThreadPage = Schema.Struct({
  releaseId: ReleaseId,
  events: Schema.Array(ReleaseAgentThreadEvent).check(
    Schema.makeFilter((events) => events.length <= MAXIMUM_THREAD_EVENT_PAGE_SIZE, {
      expected: `at most ${MAXIMUM_THREAD_EVENT_PAGE_SIZE} release-agent thread events`
    })
  ),
  nextCursor: ReleaseAgentThreadCursor
}).annotate({ identifier: "ReleaseAgentThreadPage" })

/** Decoded ordered durable release-thread replay page. */
export type ReleaseAgentThreadPage = typeof ReleaseAgentThreadPage.Type

const turn = HttpApiEndpoint.post("turn", "/releases/:releaseId/turns", {
  params: Schema.Struct({ releaseId: ReleaseId }),
  payload: ReleaseAgentTurnRequest,
  success: ReleaseAgentTurnResponse,
  error: [
    InvalidRequestApiError,
    UnauthorizedApiError,
    ForbiddenApiError,
    NotFoundApiError,
    RequestTimedOutApiError,
    RateLimitedApiError,
    PayloadTooLargeApiError,
    ServiceUnavailableApiError
  ]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const enqueueJob = HttpApiEndpoint.post("enqueueJob", "/releases/:releaseId/jobs", {
  params: Schema.Struct({ releaseId: ReleaseId }),
  payload: EnqueueReleaseAgentJobRequest,
  success: EnqueueReleaseAgentJobResponse.pipe(HttpApiSchema.status(202)),
  error: [
    InvalidRequestApiError,
    UnauthorizedApiError,
    ForbiddenApiError,
    NotFoundApiError,
    RequestTimedOutApiError,
    PayloadTooLargeApiError,
    RateLimitedApiError,
    ServiceUnavailableApiError
  ]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const replayThread = HttpApiEndpoint.get("replayThread", "/releases/:releaseId/thread/events", {
  params: Schema.Struct({ releaseId: ReleaseId }),
  query: Schema.Struct({
    after: Schema.optionalKey(ReleaseAgentThreadCursorFromString),
    limit: Schema.optionalKey(ReleaseAgentThreadEventLimitFromString)
  }),
  success: ReleaseAgentThreadPage,
  error: [
    InvalidRequestApiError,
    UnauthorizedApiError,
    ForbiddenApiError,
    NotFoundApiError,
    RequestTimedOutApiError,
    RateLimitedApiError,
    ServiceUnavailableApiError
  ]
}).middleware(SessionCookieAuth)

const providers = HttpApiEndpoint.get("providers", "/providers", {
  success: AgentProviderCatalog,
  error: [
    UnauthorizedApiError,
    ForbiddenApiError,
    RequestTimedOutApiError,
    RateLimitedApiError,
    ServiceUnavailableApiError
  ]
}).middleware(SessionCookieAuth)

const pullRequestReview = HttpApiEndpoint.get(
  "pullRequestReview",
  "/pull-requests/:entityId/review",
  {
    params: Schema.Struct({ entityId: EntityId }),
    success: PullRequestReviewState,
    error: [
      UnauthorizedApiError,
      ForbiddenApiError,
      NotFoundApiError,
      RequestTimedOutApiError,
      RateLimitedApiError,
      ServiceUnavailableApiError
    ]
  }
).middleware(SessionCookieAuth)

const enqueuePullRequestReview = HttpApiEndpoint.post(
  "enqueuePullRequestReview",
  "/pull-requests/:entityId/reviews",
  {
    params: Schema.Struct({ entityId: EntityId }),
    payload: EnqueuePullRequestReviewRequest,
    success: EnqueuePullRequestReviewResponse.pipe(HttpApiSchema.status(202)),
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      NotFoundApiError,
      RequestTimedOutApiError,
      PayloadTooLargeApiError,
      RateLimitedApiError,
      ServiceUnavailableApiError
    ]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

/** Authenticated release-aware synchronous and durable agent contract. */
export class AgentApiGroup extends HttpApiGroup.make("agent")
  .add(providers)
  .add(turn)
  .add(enqueueJob)
  .add(replayThread)
  .add(pullRequestReview)
  .add(enqueuePullRequestReview)
  .prefix("/api/v1/agent")
{}
