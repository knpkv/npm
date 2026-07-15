import * as Schema from "effect/Schema"

import { AgentActor, HumanActor } from "../actors.js"
import { DomainEventCorrelationId } from "../domainEvent.js"
import {
  DomainEventId,
  GovernedActionAttemptId,
  GovernedActionAuthorizationId,
  GovernedActionId,
  GovernedActionTransitionId,
  JobId,
  SessionId,
  WorkspaceId
} from "../identifiers.js"
import {
  PluginAcceptedProviderReceiptV1,
  PluginActionReconciliationKey,
  PluginProviderOperationId,
  PluginTerminalProviderReceiptV1
} from "../plugins/actions.js"
import { UtcTimestamp } from "../utcTimestamp.js"
import { GovernedActionEnvelopeDigest } from "./model.js"

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const SafeReason = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000))
const boundedIdentifier = (name: string, maximumLength: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[A-Za-z0-9._:/-]+$/u, { expected: "a bounded action identifier" })
  ).pipe(Schema.brand(name))

/** Complete persisted lifecycle states for a governed action. */
export const GovernedActionState = Schema.Literals([
  "proposed",
  "authorized",
  "denied",
  "expired",
  "cancelled",
  "started",
  "cancel-requested",
  "cancel-requested-unknown",
  "succeeded",
  "failed",
  "unknown"
])

/** Decoded governed-action lifecycle state. */
export type GovernedActionState = typeof GovernedActionState.Type

/** Stable identity supplied by a caller to deduplicate one lifecycle command. */
export const GovernedActionCommandId = boundedIdentifier("GovernedActionCommandId", 512)

/** Decoded governed-action command identity. */
export type GovernedActionCommandId = typeof GovernedActionCommandId.Type

/** Digest of one canonical transition command used to reject changed command retries. */
export const GovernedActionCommandDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("GovernedActionCommandDigest"))

/** Decoded governed-action command digest. */
export type GovernedActionCommandDigest = typeof GovernedActionCommandDigest.Type

/** Digest of every immutable field in one governed-action transition. */
export const GovernedActionTransitionDigest = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
).pipe(Schema.brand("GovernedActionTransitionDigest"))

/** Decoded governed-action transition digest. */
export type GovernedActionTransitionDigest = typeof GovernedActionTransitionDigest.Type

/** Closed reason why authorization or preflight failed without calling a provider. */
export const GovernedActionDenialReason = Schema.Literals([
  "revision-changed",
  "evidence-stale",
  "evidence-invalid",
  "policy-denied",
  "session-invalid",
  "capability-changed",
  "plugin-unavailable",
  "preflight-blocked"
])

/** Decoded governed-action denial reason. */
export type GovernedActionDenialReason = typeof GovernedActionDenialReason.Type

/** Unknown provider outcome that is either safely reconcilable or explicitly manual. */
export const GovernedActionUnknownOutcome = Schema.TaggedUnion({
  reconcilable: {
    reconciliationKey: PluginActionReconciliationKey,
    observedAt: UtcTimestamp,
    safeSummary: SafeReason
  },
  manual: {
    observedAt: UtcTimestamp,
    safeSummary: SafeReason,
    reason: Schema.Literals([
      "dispatch-deadline-exceeded",
      "interrupted-after-intent",
      "provider-defect-after-intent",
      "malformed-provider-result",
      "receipt-persistence-failed",
      "missing-reconciliation-locator"
    ])
  }
})

/** Decoded truthful unknown-outcome detail. */
export type GovernedActionUnknownOutcome = typeof GovernedActionUnknownOutcome.Type

const SucceededReceipt = PluginTerminalProviderReceiptV1.check(
  Schema.makeFilter(({ status }) => status === "succeeded", { expected: "a succeeded provider receipt" })
)
const FailedReceipt = PluginTerminalProviderReceiptV1.check(
  Schema.makeFilter(({ status }) => status === "failed", { expected: "a failed provider receipt" })
)
const CancelledReceipt = PluginTerminalProviderReceiptV1.check(
  Schema.makeFilter(({ status }) => status === "cancelled", { expected: "a cancelled provider receipt" })
)

/** Whether a terminal receipt came directly from dispatch or from keyed reconciliation. */
export const GovernedActionOutcomeSource = Schema.TaggedUnion({
  direct: {},
  providerOperation: { providerOperationId: PluginProviderOperationId },
  reconciliation: { reconciliationKey: PluginActionReconciliationKey }
})

/** Decoded terminal provider-outcome source. */
export type GovernedActionOutcomeSource = typeof GovernedActionOutcomeSource.Type

/** Closed commands that may append one governed-action lifecycle transition. */
export const GovernedActionTransitionCommand = Schema.TaggedUnion({
  propose: {},
  authorize: { authorizationId: GovernedActionAuthorizationId },
  deny: {
    reason: GovernedActionDenialReason,
    safeSummary: SafeReason
  },
  expire: {
    reason: Schema.Literals(["proposal-expired", "authorization-expired"])
  },
  cancel: { safeSummary: SafeReason },
  start: { attemptId: GovernedActionAttemptId },
  requestCancellation: { safeSummary: SafeReason },
  recordAccepted: { receipt: PluginAcceptedProviderReceiptV1 },
  recordSucceeded: { receipt: SucceededReceipt, source: GovernedActionOutcomeSource },
  recordFailed: { receipt: FailedReceipt, source: GovernedActionOutcomeSource },
  recordUnknown: { outcome: GovernedActionUnknownOutcome },
  recordCancelled: { receipt: CancelledReceipt, source: GovernedActionOutcomeSource },
  reconciliationPending: { checkedAt: UtcTimestamp, reconciliationKey: PluginActionReconciliationKey }
})

/** Decoded governed-action lifecycle command. */
export type GovernedActionTransitionCommand = typeof GovernedActionTransitionCommand.Type

/** Attributable human, agent, or internal component responsible for a transition. */
export const GovernedActionTransitionCause = Schema.TaggedUnion({
  human: {
    actor: HumanActor,
    sessionId: SessionId
  },
  agent: {
    actor: AgentActor,
    jobId: JobId
  },
  system: {
    component: boundedIdentifier("GovernedActionSystemComponent", 200)
  }
})

/** Decoded governed-action transition attribution. */
export type GovernedActionTransitionCause = typeof GovernedActionTransitionCause.Type

const canRecordTerminalOutcome = (
  currentState: GovernedActionState | null,
  source: GovernedActionOutcomeSource
): boolean =>
  currentState === "started" ||
  currentState === "cancel-requested" ||
  ((currentState === "unknown" || currentState === "cancel-requested-unknown") &&
    source._tag === "reconciliation")

/**
 * Resolve a lifecycle command without side effects.
 * A null result means the command is not legal from the supplied state.
 */
export const reduceGovernedActionState = (
  currentState: GovernedActionState | null,
  command: GovernedActionTransitionCommand
): GovernedActionState | null => {
  switch (command._tag) {
    case "propose":
      return currentState === null ? "proposed" : null
    case "authorize":
      return currentState === "proposed" ? "authorized" : null
    case "deny":
      return currentState === "proposed" || currentState === "authorized" ? "denied" : null
    case "expire":
      return currentState === "proposed" || currentState === "authorized" ? "expired" : null
    case "cancel":
      return currentState === "proposed" || currentState === "authorized" ? "cancelled" : null
    case "start":
      return currentState === "authorized" ? "started" : null
    case "requestCancellation":
      return currentState === "started"
        ? "cancel-requested"
        : currentState === "unknown"
        ? "cancel-requested-unknown"
        : null
    case "recordAccepted":
      return currentState === "started" || currentState === "cancel-requested" ? currentState : null
    case "recordUnknown":
      return currentState === "started"
        ? "unknown"
        : currentState === "cancel-requested"
        ? "cancel-requested-unknown"
        : null
    case "recordSucceeded":
      return canRecordTerminalOutcome(currentState, command.source) ? "succeeded" : null
    case "recordFailed":
      return canRecordTerminalOutcome(currentState, command.source) ? "failed" : null
    case "recordCancelled":
      return canRecordTerminalOutcome(currentState, command.source) ? "cancelled" : null
    case "reconciliationPending":
      return currentState === "started" ||
          currentState === "cancel-requested" ||
          currentState === "unknown" ||
          currentState === "cancel-requested-unknown"
        ? currentState
        : null
  }
}

/** Whether a governed action has reached a state that cannot execute more provider work. */
export const isGovernedActionTerminalState = (state: GovernedActionState): boolean =>
  state === "denied" ||
  state === "expired" ||
  state === "cancelled" ||
  state === "succeeded" ||
  state === "failed"

const commandCauseIsAllowed = (
  command: GovernedActionTransitionCommand,
  cause: GovernedActionTransitionCause
): boolean => {
  switch (cause._tag) {
    case "agent":
      return command._tag === "propose"
    case "human":
      return command._tag === "propose" ||
        command._tag === "authorize" ||
        command._tag === "deny" ||
        command._tag === "cancel" ||
        command._tag === "requestCancellation"
    case "system":
      return command._tag === "deny" ||
        command._tag === "expire" ||
        command._tag === "cancel" ||
        command._tag === "start" ||
        command._tag === "requestCancellation" ||
        command._tag === "recordAccepted" ||
        command._tag === "recordSucceeded" ||
        command._tag === "recordFailed" ||
        command._tag === "recordUnknown" ||
        command._tag === "recordCancelled" ||
        command._tag === "reconciliationPending"
  }
}

const governedActionTransitionMaterialFields = {
  schemaVersion: Schema.Literal(1),
  transitionId: GovernedActionTransitionId,
  previousTransitionId: Schema.NullOr(GovernedActionTransitionId),
  commandId: GovernedActionCommandId,
  actionId: GovernedActionId,
  workspaceId: WorkspaceId,
  sequence: PositiveInteger,
  fromState: Schema.NullOr(GovernedActionState),
  toState: GovernedActionState,
  actionEnvelopeDigest: GovernedActionEnvelopeDigest,
  command: GovernedActionTransitionCommand,
  cause: GovernedActionTransitionCause,
  occurredAt: UtcTimestamp,
  causationId: Schema.NullOr(DomainEventId),
  correlationId: Schema.NullOr(DomainEventCorrelationId)
}

/** Digest-free transition fields used only by the trusted transition constructor. */
export const GovernedActionTransitionMaterialV1 = Schema.Struct(
  governedActionTransitionMaterialFields
).check(
  Schema.makeFilter(
    ({ command, fromState, toState }) => reduceGovernedActionState(fromState, command) === toState,
    { expected: "a legal governed-action state transition" }
  ),
  Schema.makeFilter(
    ({ cause, command }) => commandCauseIsAllowed(command, cause),
    { expected: "transition cause to have authority for the command" }
  ),
  Schema.makeFilter(
    ({ fromState, previousTransitionId, sequence }) =>
      sequence === 1
        ? fromState === null && previousTransitionId === null
        : fromState !== null && previousTransitionId !== null,
    { expected: "the first transition to be the only transition without a predecessor" }
  )
)

/** Decoded digest-free governed-action transition material. */
export type GovernedActionTransitionMaterialV1 = typeof GovernedActionTransitionMaterialV1.Type

/** Immutable append-only audit record for one legal lifecycle command. */
export const GovernedActionTransitionV1 = Schema.Struct({
  ...governedActionTransitionMaterialFields,
  commandDigest: GovernedActionCommandDigest
}).check(
  Schema.makeFilter(
    ({ command, fromState, toState }) => reduceGovernedActionState(fromState, command) === toState,
    { expected: "a legal governed-action state transition" }
  ),
  Schema.makeFilter(
    ({ cause, command }) => commandCauseIsAllowed(command, cause),
    { expected: "transition cause to have authority for the command" }
  ),
  Schema.makeFilter(
    ({ fromState, previousTransitionId, sequence }) =>
      sequence === 1
        ? fromState === null && previousTransitionId === null
        : fromState !== null && previousTransitionId !== null,
    { expected: "the first transition to be the only transition without a predecessor" }
  )
)

/** Decoded immutable governed-action transition. */
export type GovernedActionTransitionV1 = typeof GovernedActionTransitionV1.Type
