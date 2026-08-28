import { AgentRuntimeMetadata, MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH } from "@knpkv/ai-runtime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { AgentProviderIdentifier } from "../domain/agentProviderIdentifier.js"
import { GovernedActionState } from "../domain/governedAction/index.js"
import {
  EntityId,
  EventCursor,
  GovernedActionId,
  JobId,
  PersonId,
  PrReviewSuggestionRevisionId,
  ReleaseId
} from "../domain/identifiers.js"
import { PluginProviderReceiptV1 } from "../domain/plugins/actions.js"
import {
  PrReviewDismissalReason,
  PrReviewOutcome,
  PrReviewReport,
  PrReviewSubject,
  PrReviewSuggestion,
  PrReviewSuggestionId
} from "../domain/prReview.js"
import {
  PrReviewSuggestionEdit,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionPage,
  PrReviewSuggestionRevisionPageSize,
  PrReviewSuggestionRevisionSequence
} from "../domain/prReviewRevision.js"
import { Revision } from "../domain/sourceRevision.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ConflictApiError,
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
const MAXIMUM_ORIGIN_PATH_LENGTH = 2_048
const MAXIMUM_DURABLE_PROMPT_LENGTH = 5_000
/** Maximum targeted request length retained in a pull-request review thread. */
export const MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH = 2_500
const MAXIMUM_AGENT_PROVIDERS = 32
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
export const DurableAgentProviderId = AgentProviderIdentifier.pipe(
  Schema.brand("DurableAgentProviderId")
)

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

/** Stable server-owned profile selected before an immutable review starts. */
export const ReviewAgentProfileId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
).pipe(Schema.brand("ReviewAgentProfileId"))

/** Decoded Review Agent Profile identity. */
export type ReviewAgentProfileId = typeof ReviewAgentProfileId.Type

/** Browser-safe Review Agent Profile metadata. */
export const ReviewAgentProfile = Schema.Struct({
  profileId: ReviewAgentProfileId,
  label: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  budgetMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_800_000 })),
  networkAccess: Schema.Literals(["blocked", "provider-enabled"]),
  sandbox: Schema.Literal("sbx")
})

/** Decoded browser-safe Review Agent Profile metadata. */
export type ReviewAgentProfile = typeof ReviewAgentProfile.Type

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
  displayName: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))
  ),
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
  health: AgentProviderHealth,
  reviewProfile: Schema.optionalKey(ReviewAgentProfile)
})

/** Decoded browser-safe provider catalog entry. */
export type AgentProviderCatalogEntry = typeof AgentProviderCatalogEntry.Type

/** Redacted catalog for the fixed server-side provider registry. */
export const AgentProviderCatalog = Schema.Struct({
  providers: Schema.Array(AgentProviderCatalogEntry).check(
    Schema.makeFilter((providers) => providers.length <= MAXIMUM_AGENT_PROVIDERS, {
      expected: `at most ${MAXIMUM_AGENT_PROVIDERS} agent providers`
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

/** Provider destination that Relay may create or update after human confirmation. */
export const ReleasePublicationProvider = Schema.Literals(["jira", "confluence"])
export type ReleasePublicationProvider = typeof ReleasePublicationProvider.Type

export const SubmitReleasePublicationRequest = Schema.Struct({
  provider: ReleasePublicationProvider,
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  markdown: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200_000)),
  parentId: Schema.NullOr(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
  ),
  publicationActionId: Schema.optionalKey(GovernedActionId),
  /** Exact synchronized Confluence page selected before its first governed release update. */
  targetEntityId: Schema.optionalKey(EntityId),
  /** Revision displayed to the owner before an exact-page update is submitted. */
  targetRevision: Schema.optionalKey(Revision),
  /** Existing synchronized Confluence page copied into a new release-owned page. */
  templateEntityId: Schema.optionalKey(EntityId)
})
export type SubmitReleasePublicationRequest = typeof SubmitReleasePublicationRequest.Type

export const SubmitReleasePublicationResponse = Schema.Struct({
  actionId: GovernedActionId,
  state: GovernedActionState
})
export type SubmitReleasePublicationResponse = typeof SubmitReleasePublicationResponse.Type

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
  history: ReleaseAgentHistory,
  originPath: Schema.optionalKey(
    Schema.String.check(
      Schema.isTrimmed(),
      Schema.isPattern(/^\/(?![\\/])[^\\]*$/u, { expected: "a same-origin Control Center path" }),
      Schema.isMaxLength(MAXIMUM_ORIGIN_PATH_LENGTH)
    )
  )
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

const ReleaseAgentJobStartedEvent = Schema.TaggedStruct("job-started", {
  ...releaseAgentThreadEventFields,
  runtimeMetadata: Schema.optionalKey(AgentRuntimeMetadata)
})

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
  profile: AgentSafeProfile,
  reviewProfileId: ReviewAgentProfileId,
  prompt: Schema.optionalKey(
    DurableAgentPrompt.check(
      Schema.isTrimmed(),
      Schema.isMaxLength(MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH)
    )
  )
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
  reviewProfile: ReviewAgentProfile,
  activity: Schema.Struct({
    events: Schema.Array(
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH))
    ).check(Schema.isMaxLength(MAXIMUM_THREAD_EVENT_PAGE_SIZE)),
    truncated: Schema.Boolean
  }),
  budgetMillis: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 }))).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(1_200_000)),
    Schema.withConstructorDefault(Effect.succeed(1_200_000))
  ),
  budgetExtensionCount: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 }))).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(0)),
    Schema.withConstructorDefault(Effect.succeed(0))
  ),
  startedAt: Schema.optionalKey(Schema.NullOr(UtcTimestamp)).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null))
  ),
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

/** A prior review report exists, but its evidence is bound to an older head. */
export class PullRequestReviewStale extends Schema.TaggedClass<PullRequestReviewStale>()("stale", {
  ...pullRequestReviewIdentity,
  previousHead: PrReviewSubject.fields.headRevision,
  previousJobId: JobId,
  previousState: Schema.Literals([
    "queued",
    "running",
    "cancel-requested",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted"
  ]),
  previousReport: PrReviewReport
}) {}

/** One durable exact-head review is queued or running. */
export class PullRequestReviewPending extends Schema.TaggedClass<PullRequestReviewPending>()("pending", {
  ...pullRequestReviewJob,
  state: Schema.Literals(["queued", "running", "cancel-requested"])
}) {}

/** Sanitized exact-head findings completed without changing human disposition. */
export class PullRequestReviewCompleted extends Schema.TaggedClass<PullRequestReviewCompleted>()("completed", {
  ...pullRequestReviewJob,
  completedAt: UtcTimestamp,
  report: PrReviewReport,
  outcome: PrReviewOutcome
}) {}

/** Durable exact-head review stopped without publishing a recommendation. */
export class PullRequestReviewFailed extends Schema.TaggedClass<PullRequestReviewFailed>()("failed", {
  ...pullRequestReviewJob,
  completedAt: UtcTimestamp,
  state: Schema.Literals(["failed", "cancelled"]),
  report: Schema.optionalKey(Schema.NullOr(PrReviewReport)).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null))
  )
}) {}

/** Review interrupted by process restart; its partial evidence remains inspectable. */
export class PullRequestReviewInterrupted extends Schema.TaggedClass<PullRequestReviewInterrupted>()("interrupted", {
  ...pullRequestReviewJob,
  completedAt: UtcTimestamp,
  report: PrReviewReport
}) {}

/** Browser-safe current review state for one canonical pull-request entity. */
export const PullRequestReviewState = Schema.Union([
  PullRequestReviewUnavailable,
  PullRequestReviewNotStarted,
  PullRequestReviewStale,
  PullRequestReviewPending,
  PullRequestReviewCompleted,
  PullRequestReviewFailed,
  PullRequestReviewInterrupted
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded current pull-request review state. */
export type PullRequestReviewState = typeof PullRequestReviewState.Type

const pullRequestReviewThreadEventFields = {
  eventSequence: ReleaseAgentThreadCursor.check(Schema.isGreaterThan(0)),
  jobId: JobId,
  occurredAt: UtcTimestamp
}

const PullRequestReviewOperatorMessageEvent = Schema.TaggedStruct("operator-message", {
  ...pullRequestReviewThreadEventFields,
  prompt: DurableAgentPrompt.check(
    Schema.isMaxLength(MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH)
  )
})

const PullRequestReviewRunQueuedEvent = Schema.TaggedStruct("run-queued", {
  ...pullRequestReviewThreadEventFields,
  providerId: DurableAgentProviderId,
  model: Schema.NullOr(AgentModelId),
  reviewProfile: ReviewAgentProfile,
  subject: PrReviewSubject
})

const PullRequestReviewRunStartedEvent = Schema.TaggedStruct(
  "run-started",
  {
    ...pullRequestReviewThreadEventFields,
    runtimeMetadata: Schema.optionalKey(AgentRuntimeMetadata)
  }
)

const PullRequestReviewProgressEvent = Schema.TaggedStruct("progress", {
  ...pullRequestReviewThreadEventFields,
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH)
  )
})

const PullRequestReviewUsageEvent = Schema.TaggedStruct("usage", {
  ...pullRequestReviewThreadEventFields,
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const PullRequestReviewReportEvent = Schema.TaggedStruct("review-report", {
  ...pullRequestReviewThreadEventFields,
  report: PrReviewReport
})

const PullRequestReviewSuggestionRevisedEvent = Schema.TaggedStruct(
  "suggestion-revised",
  {
    ...pullRequestReviewThreadEventFields,
    suggestionId: PrReviewSuggestionId,
    revisionId: PrReviewSuggestionRevisionId,
    sequence: PrReviewSuggestionRevisionSequence,
    authorKind: Schema.Literals(["operator", "agent"]),
    validationState: Schema.Literals(["validated", "requires-revalidation"]),
    suggestionState: Schema.optionalKey(PrReviewSuggestion.fields.state)
  }
)

const PullRequestReviewSuggestionPublishedEvent = Schema.TaggedStruct(
  "suggestion-published",
  {
    ...pullRequestReviewThreadEventFields,
    suggestionId: PrReviewSuggestionId,
    revisionId: PrReviewSuggestionRevisionId
  }
)

const PullRequestReviewRunCompletedEvent = Schema.TaggedStruct("run-completed", {
  ...pullRequestReviewThreadEventFields,
  outcome: Schema.Literals(["success", "cancelled", "max-steps"])
})

const PullRequestReviewRunFailedEvent = Schema.TaggedStruct("run-failed", {
  ...pullRequestReviewThreadEventFields,
  retryable: Schema.Boolean
})

const PullRequestReviewRunInterruptedEvent = Schema.TaggedStruct("run-interrupted", {
  ...pullRequestReviewThreadEventFields
})

const PullRequestReviewCancellationRequestedEvent = Schema.TaggedStruct(
  "cancellation-requested",
  {
    ...pullRequestReviewThreadEventFields,
    requestedAt: UtcTimestamp
  }
)

/** Browser-safe immutable activity in one stable pull-request review thread. */
export const PullRequestReviewThreadEvent = Schema.Union([
  PullRequestReviewOperatorMessageEvent,
  PullRequestReviewRunQueuedEvent,
  PullRequestReviewRunStartedEvent,
  PullRequestReviewProgressEvent,
  PullRequestReviewUsageEvent,
  PullRequestReviewReportEvent,
  PullRequestReviewSuggestionRevisedEvent,
  PullRequestReviewSuggestionPublishedEvent,
  PullRequestReviewRunCompletedEvent,
  PullRequestReviewRunFailedEvent,
  PullRequestReviewRunInterruptedEvent,
  PullRequestReviewCancellationRequestedEvent
]).pipe(Schema.toTaggedUnion("_tag"))
export type PullRequestReviewThreadEvent = typeof PullRequestReviewThreadEvent.Type

/**
 * One explicit cursor page from the stable pull-request review thread.
 * `hasMore` follows the requested cursor direction; `hasEarlier` reports a truncated tail.
 */
export const PullRequestReviewThreadPage = Schema.Struct({
  events: Schema.Array(PullRequestReviewThreadEvent).check(
    Schema.isMaxLength(MAXIMUM_THREAD_EVENT_PAGE_SIZE)
  ),
  hasEarlier: Schema.Boolean.pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false))
  ),
  hasMore: Schema.Boolean,
  nextCursor: ReleaseAgentThreadCursor
})
export type PullRequestReviewThreadPage = typeof PullRequestReviewThreadPage.Type

/** Accepted durable review job, including idempotent recovery of active work. */
export const EnqueuePullRequestReviewResponse = PullRequestReviewPending

/** Decoded accepted durable review job. */
export type EnqueuePullRequestReviewResponse = typeof EnqueuePullRequestReviewResponse.Type

/** Complete compare-and-append payload for one manually edited suggestion. */
export const EditReviewSuggestionRequest = Schema.Struct({
  expectedRevisionId: PrReviewSuggestionRevisionId,
  expectedSequence: PrReviewSuggestionRevisionSequence,
  edit: PrReviewSuggestionEdit
})

/** Decoded manual suggestion edit. */
export type EditReviewSuggestionRequest = typeof EditReviewSuggestionRequest.Type

/** Durable targeted agent operation over one optimistic suggestion revision. */
export const TargetReviewSuggestionRequest = Schema.Struct({
  providerId: DurableAgentProviderId,
  model: AgentModelId,
  profile: AgentSafeProfile,
  reviewProfileId: ReviewAgentProfileId,
  intent: Schema.Literals(["suggestion-edit", "suggestion-revalidation"]),
  expectedRevisionId: PrReviewSuggestionRevisionId,
  expectedSequence: PrReviewSuggestionRevisionSequence,
  prompt: Schema.optionalKey(
    DurableAgentPrompt.check(Schema.isTrimmed(), Schema.isMaxLength(MAXIMUM_REVIEW_THREAD_PROMPT_LENGTH))
  )
})

/** Decoded targeted agent operation request. */
export type TargetReviewSuggestionRequest = typeof TargetReviewSuggestionRequest.Type

/** Accepted targeted review job. */
export const TargetReviewSuggestionResponse = PullRequestReviewPending

/** Decoded targeted review job response. */
export type TargetReviewSuggestionResponse = typeof TargetReviewSuggestionResponse.Type

/** Browser-safe immutable suggestion revision returned after an edit. */
export const EditReviewSuggestionResponse = PrReviewSuggestionRevision

/** Decoded manual suggestion-edit result. */
export type EditReviewSuggestionResponse = typeof EditReviewSuggestionResponse.Type

/** Optimistic concurrency boundary for one explicit human dismissal. */
export const DismissReviewSuggestionRequest = Schema.Struct({
  expectedRevisionId: PrReviewSuggestionRevisionId,
  expectedSequence: PrReviewSuggestionRevisionSequence,
  reason: PrReviewDismissalReason
})

/** Decoded human dismissal request. */
export type DismissReviewSuggestionRequest = typeof DismissReviewSuggestionRequest.Type

/** Durable human-authored revision carrying the dismissed lifecycle state. */
export const DismissReviewSuggestionResponse = PrReviewSuggestionRevision

/** Decoded durable dismissal result. */
export type DismissReviewSuggestionResponse = typeof DismissReviewSuggestionResponse.Type

/** Canonical positive revision cursor decoded from an HTTP query string. */
export const ReviewSuggestionRevisionSequenceFromString = CanonicalNonNegativeIntegerFromString.pipe(
  Schema.decodeTo(PrReviewSuggestionRevisionSequence)
)

/** Canonical bounded revision page size decoded from an HTTP query string. */
export const ReviewSuggestionRevisionPageSizeFromString = CanonicalNonNegativeIntegerFromString.pipe(
  Schema.decodeTo(PrReviewSuggestionRevisionPageSize)
)

/** Browser-safe bounded revision history. */
export const ReviewSuggestionRevisionPage = PrReviewSuggestionRevisionPage

/** Decoded bounded revision history. */
export type ReviewSuggestionRevisionPage = typeof ReviewSuggestionRevisionPage.Type

/** Editable CodeCommit comment content bounded by the provider contract. */
export const MAXIMUM_REVIEW_SUGGESTION_PUBLICATION_CONTENT_LENGTH = 10_100

export const ReviewSuggestionPublicationContent = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAXIMUM_REVIEW_SUGGESTION_PUBLICATION_CONTENT_LENGTH)
)

/** Decoded final review-comment content. */
export type ReviewSuggestionPublicationContent = typeof ReviewSuggestionPublicationContent.Type

/** Provider comment mutation selected by an explicit local publication preview. */
export const ReviewSuggestionPublicationOperation = Schema.Literals(["create", "update", "reply"])

/** Decoded provider comment mutation. */
export type ReviewSuggestionPublicationOperation = typeof ReviewSuggestionPublicationOperation.Type

/** Exact completed review suggestion selected for publication. */
export const ReviewSuggestionPublicationSelection = Schema.Struct({
  jobId: JobId,
  suggestionId: PrReviewSuggestionId,
  revisionId: PrReviewSuggestionRevisionId
})

/** Decoded review-suggestion publication selection. */
export type ReviewSuggestionPublicationSelection = typeof ReviewSuggestionPublicationSelection.Type

/** Connected AWS principal that will author the CodeCommit comment. */
export const AwsReviewPublicationIdentity = Schema.Struct({
  accountId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  arn: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_048))
})

/** Decoded browser-safe AWS publication identity. */
export type AwsReviewPublicationIdentity = typeof AwsReviewPublicationIdentity.Type

/** Opaque digest binding operator confirmation to one exact provider runtime generation. */
export const ReviewSuggestionPublicationAuthorityBinding = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, {
    expected: "a lowercase SHA-256 runtime authority digest"
  })
).pipe(Schema.brand("ReviewSuggestionPublicationAuthorityBinding"))

/** Decoded immutable provider-generation binding. */
export type ReviewSuggestionPublicationAuthorityBinding = typeof ReviewSuggestionPublicationAuthorityBinding.Type

/** Read-only preview shown before the operator grants publication authority. */
export class ReviewSuggestionPublicationPreview
  extends Schema.Class<ReviewSuggestionPublicationPreview>("ReviewSuggestionPublicationPreview")({
    ...ReviewSuggestionPublicationSelection.fields,
    operation: Schema.optionalKey(ReviewSuggestionPublicationOperation),
    commentId: Schema.optionalKey(
      Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
    ),
    subject: PrReviewSubject,
    suggestionRevision: Schema.Struct({
      jobId: JobId,
      suggestionId: PrReviewSuggestionId,
      revisionId: PrReviewSuggestionRevisionId,
      sequence: PrReviewSuggestionRevisionSequence,
      reviewedHead: PrReviewSubject.fields.headRevision
    }),
    anchor: PrReviewSuggestion.fields.anchor,
    editableContent: ReviewSuggestionPublicationContent,
    editableContentMaximumLength: Schema.Int.check(Schema.isGreaterThan(0)),
    finalContent: ReviewSuggestionPublicationContent,
    publicationFooter: Schema.String.check(
      Schema.isTrimmed(),
      Schema.isNonEmpty(),
      Schema.isMaxLength(4_096)
    ),
    replacement: Schema.NullOr(
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_000))
    ),
    connectedIdentity: AwsReviewPublicationIdentity,
    authorityBinding: ReviewSuggestionPublicationAuthorityBinding,
    proposingAgent: ReviewAgentProfile,
    publishingOperator: PersonId
  })
{}

/** Explicit operator confirmation containing the final editable snapshot. */
export const PublishReviewSuggestionRequest = Schema.Struct({
  ...ReviewSuggestionPublicationSelection.fields,
  operation: Schema.optionalKey(ReviewSuggestionPublicationOperation),
  commentId: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))),
  finalContent: ReviewSuggestionPublicationContent,
  authorityBinding: ReviewSuggestionPublicationAuthorityBinding
})

/** Decoded explicit review-suggestion publication confirmation. */
export type PublishReviewSuggestionRequest = typeof PublishReviewSuggestionRequest.Type

/** Durable local snapshot of one successfully published CodeCommit comment. */
export class PublishedReviewComment extends Schema.Class<PublishedReviewComment>("PublishedReviewComment")({
  publicationId: GovernedActionId,
  /** Provider comment targeted by a lifecycle operation, when available. */
  commentId: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
  ),
  ...ReviewSuggestionPublicationSelection.fields,
  subject: PrReviewSubject,
  suggestionRevision: ReviewSuggestionPublicationPreview.fields.suggestionRevision,
  anchor: ReviewSuggestionPublicationPreview.fields.anchor,
  content: ReviewSuggestionPublicationContent,
  connectedIdentity: AwsReviewPublicationIdentity,
  proposingAgent: ReviewAgentProfile,
  publishingOperator: PersonId,
  receipt: PluginProviderReceiptV1,
  publishedAt: UtcTimestamp
}) {}

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
    ConflictApiError,
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

const PullRequestReviewThreadQuery = Schema.Struct({
  after: Schema.optionalKey(ReleaseAgentThreadCursorFromString),
  before: Schema.optionalKey(ReleaseAgentThreadCursorFromString),
  limit: Schema.optionalKey(ReleaseAgentThreadEventLimitFromString)
})

const pullRequestReviewThread = HttpApiEndpoint.get(
  "pullRequestReviewThread",
  "/pull-requests/:entityId/review-thread/events",
  {
    params: Schema.Struct({ entityId: EntityId }),
    query: PullRequestReviewThreadQuery,
    success: PullRequestReviewThreadPage,
    error: [
      InvalidRequestApiError,
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

const cancelPullRequestReview = HttpApiEndpoint.post(
  "cancelPullRequestReview",
  "/pull-requests/:entityId/reviews/:jobId/cancellation",
  {
    params: Schema.Struct({ entityId: EntityId, jobId: JobId }),
    payload: Schema.Struct({}),
    success: PullRequestReviewState,
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      NotFoundApiError,
      RequestTimedOutApiError,
      RateLimitedApiError,
      ServiceUnavailableApiError
    ]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const extendPullRequestReviewBudget = HttpApiEndpoint.post(
  "extendPullRequestReviewBudget",
  "/pull-requests/:entityId/reviews/:jobId/budget-extension",
  {
    params: Schema.Struct({ entityId: EntityId, jobId: JobId }),
    payload: Schema.Struct({}),
    success: PullRequestReviewState,
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      NotFoundApiError,
      RequestTimedOutApiError,
      RateLimitedApiError,
      ServiceUnavailableApiError
    ]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const reviewSuggestionRevisions = HttpApiEndpoint.get(
  "reviewSuggestionRevisions",
  "/pull-requests/:entityId/reviews/:jobId/suggestions/:suggestionId/revisions",
  {
    params: Schema.Struct({
      entityId: EntityId,
      jobId: JobId,
      suggestionId: PrReviewSuggestionId
    }),
    query: Schema.Struct({
      before: Schema.optionalKey(ReviewSuggestionRevisionSequenceFromString),
      limit: Schema.optionalKey(ReviewSuggestionRevisionPageSizeFromString)
    }),
    success: ReviewSuggestionRevisionPage,
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      NotFoundApiError,
      RequestTimedOutApiError,
      RateLimitedApiError,
      ServiceUnavailableApiError
    ]
  }
).middleware(SessionCookieAuth)

const editReviewSuggestion = HttpApiEndpoint.post(
  "editReviewSuggestion",
  "/pull-requests/:entityId/reviews/:jobId/suggestions/:suggestionId/revisions",
  {
    params: Schema.Struct({
      entityId: EntityId,
      jobId: JobId,
      suggestionId: PrReviewSuggestionId
    }),
    payload: EditReviewSuggestionRequest,
    success: EditReviewSuggestionResponse,
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      ConflictApiError,
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

const targetReviewSuggestion = HttpApiEndpoint.post(
  "targetReviewSuggestion",
  "/pull-requests/:entityId/reviews/:jobId/suggestions/:suggestionId/agent",
  {
    params: Schema.Struct({
      entityId: EntityId,
      jobId: JobId,
      suggestionId: PrReviewSuggestionId
    }),
    payload: TargetReviewSuggestionRequest,
    success: TargetReviewSuggestionResponse.pipe(HttpApiSchema.status(202)),
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      ConflictApiError,
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

const dismissReviewSuggestion = HttpApiEndpoint.post(
  "dismissReviewSuggestion",
  "/pull-requests/:entityId/reviews/:jobId/suggestions/:suggestionId/dismissal",
  {
    params: Schema.Struct({
      entityId: EntityId,
      jobId: JobId,
      suggestionId: PrReviewSuggestionId
    }),
    payload: DismissReviewSuggestionRequest,
    success: DismissReviewSuggestionResponse,
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      ConflictApiError,
      NotFoundApiError,
      RequestTimedOutApiError,
      RateLimitedApiError,
      ServiceUnavailableApiError
    ]
  }
)
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

const previewReviewSuggestionPublication = HttpApiEndpoint.get(
  "previewReviewSuggestionPublication",
  "/pull-requests/:entityId/reviews/:jobId/suggestions/:suggestionId/publication-preview",
  {
    params: Schema.Struct({
      entityId: EntityId,
      jobId: JobId,
      suggestionId: PrReviewSuggestionId
    }),
    query: Schema.Struct({
      revisionId: PrReviewSuggestionRevisionId,
      operation: Schema.optionalKey(ReviewSuggestionPublicationOperation),
      commentId: Schema.optionalKey(
        Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
      )
    }),
    success: ReviewSuggestionPublicationPreview,
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      NotFoundApiError,
      RequestTimedOutApiError,
      RateLimitedApiError,
      ServiceUnavailableApiError
    ]
  }
).middleware(SessionCookieAuth)

const publishReviewSuggestion = HttpApiEndpoint.post(
  "publishReviewSuggestion",
  "/pull-requests/:entityId/review-comments",
  {
    params: Schema.Struct({ entityId: EntityId }),
    payload: PublishReviewSuggestionRequest,
    success: PublishedReviewComment,
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

const submitReleasePublication = HttpApiEndpoint.post(
  "submitReleasePublication",
  "/releases/:releaseId/publications",
  {
    params: { releaseId: ReleaseId },
    payload: SubmitReleasePublicationRequest,
    success: SubmitReleasePublicationResponse,
    error: [
      InvalidRequestApiError,
      UnauthorizedApiError,
      ForbiddenApiError,
      ConflictApiError,
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
  .add(pullRequestReviewThread)
  .add(enqueuePullRequestReview)
  .add(cancelPullRequestReview)
  .add(extendPullRequestReviewBudget)
  .add(reviewSuggestionRevisions)
  .add(editReviewSuggestion)
  .add(targetReviewSuggestion)
  .add(dismissReviewSuggestion)
  .add(previewReviewSuggestionPublication)
  .add(publishReviewSuggestion)
  .add(submitReleasePublication)
  .prefix("/api/v1/agent")
{}
