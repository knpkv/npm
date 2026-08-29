/**
 * Provider-neutral, persistence-safe values exchanged with an agent adapter.
 * Provider-native session payloads stay behind the adapter implementation.
 *
 * @module
 */
import * as Schema from "effect/Schema"
import { AgentRuntimeMetadata } from "./cliMetadata.js"

const boundedIdentifier = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(200)
  ).pipe(Schema.brand(brand))

/** Stable identifier for one configured agent provider. */
export const AgentProviderId = boundedIdentifier("AgentProviderId")
export type AgentProviderId = typeof AgentProviderId.Type

/** Stable identifier for a durable agent run. */
export const AgentRunId = boundedIdentifier("AgentRunId")
export type AgentRunId = typeof AgentRunId.Type

/** Opaque reference to provider continuation state held by the server. */
export const AgentSessionRef = boundedIdentifier("AgentSessionRef")
export type AgentSessionRef = typeof AgentSessionRef.Type

/** Digest binding continuation state to its exact immutable context. */
export const AgentContextFingerprint = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("AgentContextFingerprint"))
export type AgentContextFingerprint = typeof AgentContextFingerprint.Type

const SafeContextIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500)
)

/** Immutable context identity; pull-request reviews may have no release. */
export const AgentContextSnapshot = Schema.Struct({
  workspaceId: SafeContextIdentifier,
  releaseId: Schema.NullOr(SafeContextIdentifier),
  subjectRevision: SafeContextIdentifier,
  fingerprint: AgentContextFingerprint
})
export type AgentContextSnapshot = typeof AgentContextSnapshot.Type

/** A new conversation or a validated continuation of server-held state. */
export const AgentContinuation = Schema.Union([
  Schema.TaggedStruct("fresh", {}),
  Schema.TaggedStruct("resume", {
    sessionRef: AgentSessionRef,
    contextFingerprint: AgentContextFingerprint
  })
]).pipe(Schema.toTaggedUnion("_tag"))
export type AgentContinuation = typeof AgentContinuation.Type

/** One bounded, provider-neutral request to an agent adapter. */
export const AgentRunRequest = Schema.Struct({
  runId: AgentRunId,
  providerId: AgentProviderId,
  model: Schema.NullOr(SafeContextIdentifier),
  access: Schema.Literals(["read-only", "workspace-write"]),
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(131_072)),
  context: AgentContextSnapshot,
  continuation: AgentContinuation
})
export type AgentRunRequest = typeof AgentRunRequest.Type

const SafeProviderReference = Schema.NullOr(
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000))
)

const AgentStarted = Schema.TaggedStruct("started", {
  providerRunRef: SafeProviderReference,
  sessionRef: Schema.NullOr(AgentSessionRef),
  runtimeMetadata: Schema.optionalKey(AgentRuntimeMetadata)
})

/** Maximum text characters emitted by one provider-neutral output event. */
export const MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH = 32_768

/** Maximum encoded UTF-8 bytes in one durable runtime event payload. */
export const MAXIMUM_AGENT_RUNTIME_EVENT_BYTES = 32_768

const AgentOutput = Schema.TaggedStruct("output", {
  channel: Schema.Literals(["assistant", "progress"]),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH))
})

const AgentUsage = Schema.TaggedStruct("usage", {
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

const AgentCompleted = Schema.TaggedStruct("completed", {
  outcome: Schema.Literals(["success", "cancelled", "max-steps"]),
  sessionRef: Schema.NullOr(AgentSessionRef)
})

/** Ordered event emitted by any local agent implementation. */
export const AgentRuntimeEvent = Schema.Union([
  AgentStarted,
  AgentOutput,
  AgentUsage,
  AgentCompleted
]).pipe(Schema.toTaggedUnion("_tag"))
export type AgentRuntimeEvent = typeof AgentRuntimeEvent.Type

/** Attach safe runtime identity only to the start event of one agent run. */
export const attachAgentRuntimeMetadata = (
  event: AgentRuntimeEvent,
  runtimeMetadata: AgentRuntimeMetadata | undefined
): AgentRuntimeEvent =>
  event._tag === "started" && runtimeMetadata !== undefined
    ? { ...event, runtimeMetadata }
    : event

/** Stable redacted cause for one pull-request review failure. */
export const AgentReviewFailureCause = Schema.Literals([
  "invalid-configuration",
  "invalid-request",
  "source-rejected",
  "source-unavailable",
  "sandbox-unavailable",
  "sandbox-timeout",
  "command-timeout",
  "provider-authentication",
  "provider-rate-limited",
  "provider-unavailable",
  "agent-command-failed",
  "output-rejected",
  "artifact-unavailable",
  "session-closed",
  "cleanup-failed"
])
export type AgentReviewFailureCause = typeof AgentReviewFailureCause.Type

/** A provider failed without exposing credentials or provider-native state. */
export class AgentProviderError extends Schema.TaggedError<AgentProviderError>()(
  "AgentProviderError",
  {
    providerId: AgentProviderId,
    phase: Schema.Literals(["configuration", "launch", "protocol", "execution", "timeout"]),
    reviewStage: Schema.optionalKey(
      Schema.Literals([
        "source-checkout",
        "review-setup",
        "sandbox-start",
        "agent-run",
        "cleanup",
        "result-validation",
        "control-center"
      ])
    ),
    reviewCause: Schema.optionalKey(AgentReviewFailureCause),
    message: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
    retryable: Schema.Boolean
  }
) {}

/** The adapter violated the shared event-stream contract. */
export class AgentRuntimeProtocolError extends Schema.TaggedError<AgentRuntimeProtocolError>()(
  "AgentRuntimeProtocolError",
  {
    reason: Schema.Literals([
      "invalid-event",
      "missing-terminal-event",
      "duplicate-terminal-event",
      "event-after-terminal",
      "failure-after-terminal"
    ]),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

/** A continuation was captured for a different immutable run context. */
export class AgentContextMismatchError extends Schema.TaggedError<AgentContextMismatchError>()(
  "AgentContextMismatchError",
  {}
) {}

export type AgentRuntimeError = AgentContextMismatchError | AgentProviderError | AgentRuntimeProtocolError
