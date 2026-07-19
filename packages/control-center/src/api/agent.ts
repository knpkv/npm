import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { EventCursor, JobId, ReleaseId } from "../domain/identifiers.js"
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
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_REPLY_LENGTH))
})

const ReleaseAgentProgressEvent = Schema.TaggedStruct("progress", {
  ...releaseAgentThreadEventFields,
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_REPLY_LENGTH))
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
  prompt: DurableAgentPrompt
}).annotate({ identifier: "EnqueueReleaseAgentJobRequest" })

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
    ServiceUnavailableApiError
  ]
}).middleware(SessionCookieAuth)

/** Authenticated release-aware synchronous and durable agent contract. */
export class AgentApiGroup extends HttpApiGroup.make("agent")
  .add(turn)
  .add(enqueueJob)
  .add(replayThread)
  .prefix("/api/v1/agent")
{}
