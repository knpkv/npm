import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { EventCursor, ReleaseId } from "../domain/identifiers.js"
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

const MAXIMUM_PROMPT_LENGTH = 8_000
const MAXIMUM_HISTORY_MESSAGES = 12
const MAXIMUM_HISTORY_MESSAGE_LENGTH = 12_000
const MAXIMUM_HISTORY_CONTENT_LENGTH = 64_000
const MAXIMUM_REPLY_LENGTH = 32_000

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

/** Authenticated release-aware agent-turn contract. */
export class AgentApiGroup extends HttpApiGroup.make("agent").add(turn).prefix("/api/v1/agent") {}
