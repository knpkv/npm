/**
 * Provider-neutral, persistence-safe values exchanged with an agent adapter.
 * Provider-native session payloads stay behind the adapter implementation.
 *
 * @module
 */
import * as Schema from "effect/Schema"

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

/** Digest binding continuation state to its exact release context. */
export const AgentContextFingerprint = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("AgentContextFingerprint"))
export type AgentContextFingerprint = typeof AgentContextFingerprint.Type

const SafeContextIdentifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500)
)

/** Immutable context identity captured when a run is requested. */
export const AgentContextSnapshot = Schema.Struct({
  workspaceId: SafeContextIdentifier,
  releaseId: SafeContextIdentifier,
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
  sessionRef: Schema.NullOr(AgentSessionRef)
})

const AgentOutput = Schema.TaggedStruct("output", {
  channel: Schema.Literals(["assistant", "progress"]),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32_768))
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

/** A provider failed without exposing credentials or provider-native state. */
export class AgentProviderError extends Schema.TaggedErrorClass<AgentProviderError>()(
  "AgentProviderError",
  {
    providerId: AgentProviderId,
    phase: Schema.Literals(["configuration", "launch", "protocol", "execution", "timeout"]),
    message: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
    retryable: Schema.Boolean
  }
) {}

/** The adapter violated the shared event-stream contract. */
export class AgentRuntimeProtocolError extends Schema.TaggedErrorClass<AgentRuntimeProtocolError>()(
  "AgentRuntimeProtocolError",
  {
    reason: Schema.Literals([
      "missing-terminal-event",
      "duplicate-terminal-event",
      "event-after-terminal",
      "failure-after-terminal"
    ]),
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

/** A continuation was captured for a different immutable release context. */
export class AgentContextMismatchError extends Schema.TaggedErrorClass<AgentContextMismatchError>()(
  "AgentContextMismatchError",
  {}
) {}

export type AgentRuntimeError = AgentContextMismatchError | AgentProviderError | AgentRuntimeProtocolError
