import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  GovernedActionLifecycleHeadV1,
  GovernedActionProviderLineage,
  type GovernedActionProviderLineage as GovernedActionLineage
} from "../../../../domain/governedAction/lifecycle.js"
import {
  GovernedActionAttemptV1,
  type GovernedActionAttemptV1 as GovernedActionAttempt,
  GovernedActionAuthorizationV1,
  type GovernedActionAuthorizationV1 as GovernedActionAuthorization,
  GovernedActionEnvelopeV1,
  type GovernedActionEnvelopeV1 as GovernedActionEnvelope,
  GovernedActionPolicyEvaluationV1,
  type GovernedActionPolicyEvaluationV1 as GovernedActionPolicyEvaluation
} from "../../../../domain/governedAction/model.js"
import {
  GovernedActionTransitionCause,
  GovernedActionTransitionCommand,
  GovernedActionTransitionV1,
  type GovernedActionTransitionV1 as GovernedActionTransition
} from "../../../../domain/governedAction/stateMachine.js"
import type {
  AgentId,
  GovernedActionAttemptId,
  GovernedActionAuthorizationId,
  GovernedActionTransitionId,
  JobId,
  PersonId,
  SessionId
} from "../../../../domain/identifiers.js"
import type { PluginActionReconciliationKey, PluginProviderOperationId } from "../../../../domain/plugins/actions.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import {
  digestGovernedActionAttempt,
  digestGovernedActionAuthorization,
  digestGovernedActionPolicyEvaluation,
  digestGovernedActionTransition,
  verifyGovernedActionEnvelope,
  verifyGovernedActionTransition
} from "../../../governance/governedActionDigests.js"
import { PersistedRecordError, PersistenceOperationError } from "../../errors.js"
import {
  encodePersistedGovernedActionReconciliationLocator,
  type PersistedGovernedActionReconciliationLocator
} from "../../governedActionReconciliationLocator.js"
import type { QuarantineReasonCode, QuarantineRecordKind } from "../models.js"
import type {
  GovernedActionAttemptRow,
  GovernedActionAuditEventRow,
  GovernedActionAuthorizationRow,
  GovernedActionPolicyEvaluationRow,
  GovernedActionRow,
  GovernedActionTransitionRow
} from "./rows.js"

const envelopeJson = Schema.fromJsonString(GovernedActionEnvelopeV1)
const policyEvaluationJson = Schema.fromJsonString(GovernedActionPolicyEvaluationV1)
const authorizationJson = Schema.fromJsonString(GovernedActionAuthorizationV1)
const attemptJson = Schema.fromJsonString(GovernedActionAttemptV1)
const transitionJson = Schema.fromJsonString(GovernedActionTransitionV1)
const lineageJson = Schema.fromJsonString(GovernedActionProviderLineage)
const commandJson = Schema.fromJsonString(GovernedActionTransitionCommand)
const causeJson = Schema.fromJsonString(GovernedActionTransitionCause)

/** Canonical JSON codecs shared by governed-action reads and writes. */
export {
  attemptJson as GovernedActionAttemptJson,
  authorizationJson as GovernedActionAuthorizationJson,
  causeJson as GovernedActionCauseJson,
  commandJson as GovernedActionCommandJson,
  envelopeJson as GovernedActionEnvelopeJson,
  lineageJson as GovernedActionLineageJson,
  policyEvaluationJson as GovernedActionPolicyEvaluationJson,
  transitionJson as GovernedActionTransitionJson
}

const encodeEnvelopeJson = Schema.encodeEffect(envelopeJson)
const encodePolicyEvaluationJson = Schema.encodeEffect(policyEvaluationJson)
const encodeAuthorizationJson = Schema.encodeEffect(authorizationJson)
const encodeAttemptJson = Schema.encodeEffect(attemptJson)
const encodeTransitionJson = Schema.encodeEffect(transitionJson)
const encodeLineageJson = Schema.encodeEffect(lineageJson)
const decodeEnvelopeJson = Schema.decodeUnknownEffect(envelopeJson)
const decodePolicyEvaluationJson = Schema.decodeUnknownEffect(policyEvaluationJson)
const decodeAuthorizationJson = Schema.decodeUnknownEffect(authorizationJson)
const decodeAttemptJson = Schema.decodeUnknownEffect(attemptJson)
const decodeTransitionJson = Schema.decodeUnknownEffect(transitionJson)
const decodeLineageJson = Schema.decodeUnknownEffect(lineageJson)
const decodeTimestamp = Schema.decodeUnknownEffect(UtcTimestamp)
const encodeTimestamp = Schema.encodeSync(UtcTimestamp)

/** Closed quarantine kinds emitted by the governed-action integrity codec. */
export type GovernedActionQuarantineRecordKind = Extract<
  QuarantineRecordKind,
  | "governed-action"
  | "governed-action-policy-evaluation"
  | "governed-action-authorization"
  | "governed-action-attempt"
  | "governed-action-transition"
  | "governed-action-audit"
>

/** Closed diagnostics emitted by the governed-action integrity codec. */
export type GovernedActionQuarantineReasonCode = Extract<
  QuarantineReasonCode,
  | "governed-action-schema-invalid"
  | "governed-action-digest-mismatch"
  | "governed-action-identity-mismatch"
  | "governed-action-chain-invalid"
  | "governed-action-head-mismatch"
  | "governed-action-companion-invalid"
  | "governed-action-transition-schema-invalid"
  | "governed-action-transition-digest-mismatch"
  | "governed-action-audit-mismatch"
>

interface GovernedActionRecordErrorOptions {
  readonly workspaceId: typeof GovernedActionRow.Type["workspaceId"]
  readonly recordKind: GovernedActionQuarantineRecordKind
  readonly recordKey: string
  readonly diagnosticCode: GovernedActionQuarantineReasonCode
}

/** Construct a bounded corruption diagnostic without retaining raw governed-action material. */
export const governedActionRecordError = (
  options: GovernedActionRecordErrorOptions
): PersistedRecordError => new PersistedRecordError(options)

const encodeFailure = (operation: string): PersistenceOperationError => new PersistenceOperationError({ operation })

/** Denormalized provider-lineage columns shared by action heads and transitions. */
export interface GovernedActionLineageProjection {
  readonly lineageKind: GovernedActionLineage["_tag"]
  readonly providerOperationId: PluginProviderOperationId | null
  readonly reconciliationKey: PluginActionReconciliationKey | null
  readonly terminalStatus: "succeeded" | "failed" | "cancelled" | null
}

/** Denormalized replay and provider-identity columns for one transition command. */
export interface GovernedActionCommandProjection {
  readonly commandTag: GovernedActionTransitionCommand["_tag"]
  readonly authorizationId: GovernedActionAuthorizationId | null
  readonly attemptId: GovernedActionAttemptId | null
  readonly outcomeSourceKind: "direct" | "providerOperation" | "reconciliation" | null
  readonly commandProviderOperationId: PluginProviderOperationId | null
  readonly commandReconciliationKey: PersistedGovernedActionReconciliationLocator | null
  readonly commandTerminalStatus: "succeeded" | "failed" | "cancelled" | null
  readonly commandUnknownKind: "reconcilable" | "manual" | null
}

/** Denormalized human, agent, or system attribution columns for one transition. */
export interface GovernedActionCauseProjection {
  readonly causeKind: GovernedActionTransitionCause["_tag"]
  readonly causeActorId: PersonId | AgentId | null
  readonly causeSessionId: SessionId | null
  readonly causeJobId: JobId | null
  readonly causeSystemComponent: string | null
}

/** Verified materialized action-head metadata reconstructed from the persisted lineage. */
export interface GovernedActionHeadRecord {
  readonly transitionId: GovernedActionTransitionId
  readonly sequence: number
  readonly lifecycle: typeof GovernedActionLifecycleHeadV1.Type
  readonly updatedAt: typeof UtcTimestamp.Type
}

/** Verified action envelope and its nullable transaction-local materialized head. */
export interface DecodedGovernedActionRow {
  readonly envelope: GovernedActionEnvelope
  readonly head: GovernedActionHeadRecord | null
  readonly createdAt: typeof UtcTimestamp.Type
}

/** Verified transition and the independently persisted lifecycle projection it produced. */
export interface DecodedGovernedActionTransitionRow {
  readonly transition: GovernedActionTransition
  readonly transitionDigest: typeof GovernedActionTransitionRow.Type["transitionDigest"]
  readonly resultHead: typeof GovernedActionLifecycleHeadV1.Type
}

/** Project provider lineage into the independently constrained SQL columns. */
export const projectGovernedActionLineage = (
  lineage: GovernedActionLineage
): GovernedActionLineageProjection => {
  switch (lineage._tag) {
    case "none":
      return {
        lineageKind: "none",
        providerOperationId: null,
        reconciliationKey: null,
        terminalStatus: null
      }
    case "accepted":
      return {
        lineageKind: "accepted",
        providerOperationId: lineage.receipt.providerOperationId,
        reconciliationKey: lineage.receipt.reconciliationKey,
        terminalStatus: null
      }
    case "reconcilable":
      return {
        lineageKind: "reconcilable",
        providerOperationId: lineage.providerOperationId,
        reconciliationKey: lineage.reconciliationKey,
        terminalStatus: null
      }
    case "manual":
      return {
        lineageKind: "manual",
        providerOperationId: lineage.providerOperationId,
        reconciliationKey: null,
        terminalStatus: null
      }
    case "terminal":
      return {
        lineageKind: "terminal",
        providerOperationId: lineage.receipt.providerOperationId,
        reconciliationKey: null,
        terminalStatus: lineage.receipt.status
      }
  }
}

const emptyCommandProjection = (
  commandTag: GovernedActionTransitionCommand["_tag"]
): GovernedActionCommandProjection => ({
  commandTag,
  authorizationId: null,
  attemptId: null,
  outcomeSourceKind: null,
  commandProviderOperationId: null,
  commandReconciliationKey: null,
  commandTerminalStatus: null,
  commandUnknownKind: null
})

/** Project command-specific identities without retaining descriptions or provider payloads. */
export const projectGovernedActionCommand = (
  command: GovernedActionTransitionCommand
): GovernedActionCommandProjection => {
  switch (command._tag) {
    case "authorize":
      return { ...emptyCommandProjection(command._tag), authorizationId: command.authorizationId }
    case "start":
      return { ...emptyCommandProjection(command._tag), attemptId: command.attemptId }
    case "recordAccepted":
      return {
        ...emptyCommandProjection(command._tag),
        commandProviderOperationId: command.receipt.providerOperationId,
        commandReconciliationKey: command.receipt.reconciliationKey
      }
    case "recordSucceeded":
    case "recordFailed":
    case "recordCancelled":
      return {
        ...emptyCommandProjection(command._tag),
        outcomeSourceKind: command.source._tag,
        commandProviderOperationId: command.receipt.providerOperationId,
        commandReconciliationKey: command.source._tag === "reconciliation"
          ? encodePersistedGovernedActionReconciliationLocator(command.source.reconciliationKey)
          : null,
        commandTerminalStatus: command.receipt.status
      }
    case "recordUnknown":
      return {
        ...emptyCommandProjection(command._tag),
        commandReconciliationKey: command.outcome._tag === "reconcilable"
          ? command.outcome.reconciliationKey
          : null,
        commandUnknownKind: command.outcome._tag
      }
    case "reconciliationPending":
      return {
        ...emptyCommandProjection(command._tag),
        commandReconciliationKey: encodePersistedGovernedActionReconciliationLocator(
          command.reconciliationKey
        )
      }
    case "propose":
    case "deny":
    case "expire":
    case "cancel":
    case "requestCancellation":
      return emptyCommandProjection(command._tag)
  }
}

/** Project closed transition attribution into mutually exclusive SQL columns. */
export const projectGovernedActionCause = (
  cause: GovernedActionTransitionCause
): GovernedActionCauseProjection => {
  switch (cause._tag) {
    case "human":
      return {
        causeKind: "human",
        causeActorId: cause.actor.personId,
        causeSessionId: cause.sessionId,
        causeJobId: null,
        causeSystemComponent: null
      }
    case "agent":
      return {
        causeKind: "agent",
        causeActorId: cause.actor.agentId,
        causeSessionId: null,
        causeJobId: cause.jobId,
        causeSystemComponent: null
      }
    case "system":
      return {
        causeKind: "system",
        causeActorId: null,
        causeSessionId: null,
        causeJobId: null,
        causeSystemComponent: cause.component
      }
  }
}

/** Encode a validated immutable governed-action envelope as bounded JSON text. */
export const encodeGovernedActionEnvelopeJson = Effect.fn("GovernedActionCodec.encodeEnvelope")(function*(
  envelope: GovernedActionEnvelope
) {
  return yield* encodeEnvelopeJson(envelope).pipe(
    Effect.mapError(() => encodeFailure("governed-action.encode-envelope"))
  )
})

/** Encode a validated fresh policy evaluation as bounded JSON text. */
export const encodeGovernedActionPolicyEvaluationJson = Effect.fn(
  "GovernedActionCodec.encodePolicyEvaluation"
)(function*(evaluation: GovernedActionPolicyEvaluation) {
  return yield* encodePolicyEvaluationJson(evaluation).pipe(
    Effect.mapError(() => encodeFailure("governed-action.encode-policy-evaluation"))
  )
})

/** Encode a validated immutable human authorization as bounded JSON text. */
export const encodeGovernedActionAuthorizationJson = Effect.fn(
  "GovernedActionCodec.encodeAuthorization"
)(function*(authorization: GovernedActionAuthorization) {
  return yield* encodeAuthorizationJson(authorization).pipe(
    Effect.mapError(() => encodeFailure("governed-action.encode-authorization"))
  )
})

/** Encode a validated durable dispatch attempt as bounded JSON text. */
export const encodeGovernedActionAttemptJson = Effect.fn("GovernedActionCodec.encodeAttempt")(function*(
  attempt: GovernedActionAttempt
) {
  return yield* encodeAttemptJson(attempt).pipe(
    Effect.mapError(() => encodeFailure("governed-action.encode-attempt"))
  )
})

/** Encode a validated immutable lifecycle transition as bounded JSON text. */
export const encodeGovernedActionTransitionJson = Effect.fn("GovernedActionCodec.encodeTransition")(function*(
  transition: GovernedActionTransition
) {
  return yield* encodeTransitionJson(transition).pipe(
    Effect.mapError(() => encodeFailure("governed-action.encode-transition"))
  )
})

/** Encode a validated provider lineage projection as bounded JSON text. */
export const encodeGovernedActionLineageJson = Effect.fn("GovernedActionCodec.encodeLineage")(function*(
  lineage: GovernedActionLineage
) {
  return yield* encodeLineageJson(lineage).pipe(
    Effect.mapError(() => encodeFailure("governed-action.encode-lineage"))
  )
})

const lineageProjectionMatches = (
  projection: GovernedActionLineageProjection,
  row: {
    readonly lineageKind: GovernedActionLineageProjection["lineageKind"]
    readonly providerOperationId: PluginProviderOperationId | null
    readonly reconciliationKey: PluginActionReconciliationKey | null
    readonly terminalStatus: GovernedActionLineageProjection["terminalStatus"]
  }
): boolean =>
  projection.lineageKind === row.lineageKind &&
  projection.providerOperationId === row.providerOperationId &&
  projection.reconciliationKey === row.reconciliationKey &&
  projection.terminalStatus === row.terminalStatus

const commandProjectionMatches = (
  projection: GovernedActionCommandProjection,
  row: typeof GovernedActionTransitionRow.Type
): boolean =>
  projection.commandTag === row.commandTag &&
  projection.authorizationId === row.authorizationId &&
  projection.attemptId === row.attemptId &&
  projection.outcomeSourceKind === row.outcomeSourceKind &&
  projection.commandProviderOperationId === row.commandProviderOperationId &&
  projection.commandReconciliationKey === row.commandReconciliationKey &&
  projection.commandTerminalStatus === row.commandTerminalStatus &&
  projection.commandUnknownKind === row.commandUnknownKind

const causeProjectionMatches = (
  projection: GovernedActionCauseProjection,
  row: {
    readonly causeKind: GovernedActionCauseProjection["causeKind"]
    readonly causeActorId: PersonId | AgentId | null
    readonly causeSessionId: SessionId | null
    readonly causeJobId: JobId | null
    readonly causeSystemComponent: string | null
  }
): boolean =>
  projection.causeKind === row.causeKind &&
  projection.causeActorId === row.causeActorId &&
  projection.causeSessionId === row.causeSessionId &&
  projection.causeJobId === row.causeJobId &&
  projection.causeSystemComponent === row.causeSystemComponent

/** Decode and verify the immutable envelope and nullable action-head projection. */
export const decodeGovernedActionRow = Effect.fn("GovernedActionCodec.decodeActionRow")(function*(
  row: typeof GovernedActionRow.Type
) {
  const malformed = (diagnosticCode: GovernedActionQuarantineReasonCode) =>
    governedActionRecordError({
      workspaceId: row.workspaceId,
      recordKind: "governed-action",
      recordKey: row.actionId,
      diagnosticCode
    })
  const envelope = yield* decodeEnvelopeJson(row.envelopeJson).pipe(
    Effect.mapError(() => malformed("governed-action-schema-invalid"))
  )
  const verifiedEnvelope = yield* verifyGovernedActionEnvelope(envelope).pipe(
    Effect.mapError(() => malformed("governed-action-digest-mismatch"))
  )
  const envelopeProjectionMatches = envelope.workspaceId === row.workspaceId &&
    envelope.actionId === row.actionId &&
    envelope.pluginConnectionId === row.pluginConnectionId &&
    envelope.providerId === row.providerId &&
    envelope.targetEntityId === row.targetEntityId &&
    envelope.idempotencyKey === row.idempotencyKey &&
    envelope.envelopeDigest === row.envelopeDigest
  if (!envelopeProjectionMatches) {
    return yield* malformed("governed-action-identity-mismatch")
  }
  const createdAt = yield* decodeTimestamp(row.createdAt).pipe(
    Effect.mapError(() => malformed("governed-action-head-mismatch"))
  )
  const updatedAt = yield* decodeTimestamp(row.updatedAt).pipe(
    Effect.mapError(() => malformed("governed-action-head-mismatch"))
  )
  if (DateTime.Order(createdAt, updatedAt) > 0) {
    return yield* malformed("governed-action-head-mismatch")
  }

  const nullableHead = [
    row.state,
    row.lineageJson,
    row.lineageKind,
    row.headTransitionId,
    row.headSequence
  ]
  const hasEmptyHead = nullableHead.every((value) => value === null) &&
    row.providerOperationId === null &&
    row.reconciliationKey === null &&
    row.terminalStatus === null
  if (hasEmptyHead) {
    return { envelope: verifiedEnvelope.envelope, head: null, createdAt }
  }
  if (
    row.state === null ||
    row.lineageJson === null ||
    row.lineageKind === null ||
    row.headTransitionId === null ||
    row.headSequence === null
  ) {
    return yield* malformed("governed-action-head-mismatch")
  }
  const lineage = yield* decodeLineageJson(row.lineageJson).pipe(
    Effect.mapError(() => malformed("governed-action-head-mismatch"))
  )
  const lifecycle = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionLifecycleHeadV1))({
    state: row.state,
    lineage
  }).pipe(
    Effect.mapError(() => malformed("governed-action-head-mismatch"))
  )
  if (
    !lineageProjectionMatches(projectGovernedActionLineage(lineage), {
      lineageKind: row.lineageKind,
      providerOperationId: row.providerOperationId,
      reconciliationKey: row.reconciliationKey,
      terminalStatus: row.terminalStatus
    })
  ) {
    return yield* malformed("governed-action-head-mismatch")
  }
  return {
    envelope: verifiedEnvelope.envelope,
    head: {
      transitionId: row.headTransitionId,
      sequence: row.headSequence,
      lifecycle,
      updatedAt
    },
    createdAt
  }
})

/** Decode a policy evaluation, then verify its digest and denormalized identity. */
export const decodeGovernedActionPolicyEvaluationRow = Effect.fn(
  "GovernedActionCodec.decodePolicyEvaluationRow"
)(function*(row: typeof GovernedActionPolicyEvaluationRow.Type) {
  const malformed = (diagnosticCode: GovernedActionQuarantineReasonCode) =>
    governedActionRecordError({
      workspaceId: row.workspaceId,
      recordKind: "governed-action-policy-evaluation",
      recordKey: row.actionId,
      diagnosticCode
    })
  const evaluation = yield* decodePolicyEvaluationJson(row.evaluationJson).pipe(
    Effect.mapError(() => malformed("governed-action-companion-invalid"))
  )
  const actualDigest = yield* digestGovernedActionPolicyEvaluation(evaluation).pipe(
    Effect.mapError(() => malformed("governed-action-companion-invalid"))
  )
  if (actualDigest !== row.evaluationDigest) {
    return yield* malformed("governed-action-companion-invalid")
  }
  if (
    evaluation.workspaceId !== row.workspaceId ||
    evaluation.actionId !== row.actionId ||
    evaluation.decision !== row.decision ||
    encodeTimestamp(evaluation.evaluatedAt) !== row.evaluatedAt
  ) {
    return yield* malformed("governed-action-companion-invalid")
  }
  return evaluation
})

/** Decode an authorization, then verify its full digest and denormalized authority columns. */
export const decodeGovernedActionAuthorizationRow = Effect.fn(
  "GovernedActionCodec.decodeAuthorizationRow"
)(function*(row: typeof GovernedActionAuthorizationRow.Type) {
  const malformed = (diagnosticCode: GovernedActionQuarantineReasonCode) =>
    governedActionRecordError({
      workspaceId: row.workspaceId,
      recordKind: "governed-action-authorization",
      recordKey: row.authorizationId,
      diagnosticCode
    })
  const authorization = yield* decodeAuthorizationJson(row.authorizationJson).pipe(
    Effect.mapError(() => malformed("governed-action-companion-invalid"))
  )
  const actualDigest = yield* digestGovernedActionAuthorization(authorization).pipe(
    Effect.mapError(() => malformed("governed-action-companion-invalid"))
  )
  if (actualDigest !== row.authorizationDigest) {
    return yield* malformed("governed-action-companion-invalid")
  }
  if (
    authorization.workspaceId !== row.workspaceId ||
    authorization.actionId !== row.actionId ||
    authorization.authorizationId !== row.authorizationId ||
    authorization.sessionId !== row.sessionId ||
    authorization.actionEnvelopeDigest !== row.envelopeDigest ||
    encodeTimestamp(authorization.authorizedAt) !== row.authorizedAt ||
    encodeTimestamp(authorization.expiresAt) !== row.expiresAt
  ) {
    return yield* malformed("governed-action-companion-invalid")
  }
  return authorization
})

/** Decode a durable attempt, then verify its full digest and authority linkage columns. */
export const decodeGovernedActionAttemptRow = Effect.fn(
  "GovernedActionCodec.decodeAttemptRow"
)(function*(row: typeof GovernedActionAttemptRow.Type) {
  const malformed = (diagnosticCode: GovernedActionQuarantineReasonCode) =>
    governedActionRecordError({
      workspaceId: row.workspaceId,
      recordKind: "governed-action-attempt",
      recordKey: row.attemptId,
      diagnosticCode
    })
  const attempt = yield* decodeAttemptJson(row.attemptJson).pipe(
    Effect.mapError(() => malformed("governed-action-companion-invalid"))
  )
  const actualDigest = yield* digestGovernedActionAttempt(attempt).pipe(
    Effect.mapError(() => malformed("governed-action-companion-invalid"))
  )
  if (actualDigest !== row.attemptDigest) {
    return yield* malformed("governed-action-companion-invalid")
  }
  if (
    attempt.workspaceId !== row.workspaceId ||
    attempt.actionId !== row.actionId ||
    attempt.attemptId !== row.attemptId ||
    attempt.authorizationId !== row.authorizationId ||
    attempt.policyEvaluationDigest !== row.policyEvaluationDigest ||
    attempt.attemptNumber !== row.attemptNumber ||
    encodeTimestamp(attempt.startedAt) !== row.startedAt
  ) {
    return yield* malformed("governed-action-companion-invalid")
  }
  return attempt
})

/** Decode a transition and verify both canonical digests plus every replay projection. */
export const decodeGovernedActionTransitionRow = Effect.fn(
  "GovernedActionCodec.decodeTransitionRow"
)(function*(row: typeof GovernedActionTransitionRow.Type) {
  const malformed = (diagnosticCode: GovernedActionQuarantineReasonCode) =>
    governedActionRecordError({
      workspaceId: row.workspaceId,
      recordKind: "governed-action-transition",
      recordKey: row.transitionId,
      diagnosticCode
    })
  const transition = yield* decodeTransitionJson(row.transitionJson).pipe(
    Effect.mapError(() => malformed("governed-action-transition-schema-invalid"))
  )
  yield* verifyGovernedActionTransition(transition).pipe(
    Effect.mapError(() => malformed("governed-action-transition-digest-mismatch"))
  )
  const actualDigest = yield* digestGovernedActionTransition(transition).pipe(
    Effect.mapError(() => malformed("governed-action-transition-digest-mismatch"))
  )
  if (actualDigest !== row.transitionDigest) {
    return yield* malformed("governed-action-transition-digest-mismatch")
  }
  const identityMatches = transition.workspaceId === row.workspaceId &&
    transition.actionId === row.actionId &&
    transition.transitionId === row.transitionId &&
    transition.previousTransitionId === row.previousTransitionId &&
    transition.sequence === row.sequence &&
    transition.commandId === row.commandId &&
    transition.commandDigest === row.commandDigest &&
    transition.actionEnvelopeDigest === row.envelopeDigest &&
    (row.policyEvaluationDigest === null || transition.command._tag === "deny") &&
    transition.fromState === row.fromState &&
    transition.toState === row.toState &&
    transition.causationId === row.causationId &&
    transition.correlationId === row.correlationId &&
    encodeTimestamp(transition.occurredAt) === row.occurredAt
  if (!identityMatches) {
    return yield* malformed("governed-action-chain-invalid")
  }
  if (!commandProjectionMatches(projectGovernedActionCommand(transition.command), row)) {
    return yield* malformed("governed-action-chain-invalid")
  }
  if (!causeProjectionMatches(projectGovernedActionCause(transition.cause), row)) {
    return yield* malformed("governed-action-chain-invalid")
  }
  const lineage = yield* decodeLineageJson(row.resultLineageJson).pipe(
    Effect.mapError(() => malformed("governed-action-chain-invalid"))
  )
  const resultHead = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionLifecycleHeadV1))({
    state: transition.toState,
    lineage
  }).pipe(
    Effect.mapError(() => malformed("governed-action-chain-invalid"))
  )
  if (
    !lineageProjectionMatches(projectGovernedActionLineage(lineage), {
      lineageKind: row.resultLineageKind,
      providerOperationId: row.resultProviderOperationId,
      reconciliationKey: row.resultReconciliationKey,
      terminalStatus: row.resultTerminalStatus
    })
  ) {
    return yield* malformed("governed-action-chain-invalid")
  }
  return { transition, transitionDigest: row.transitionDigest, resultHead }
})

/** Decode an audit payload and prove that all audit columns attribute its exact transition. */
export const decodeGovernedActionAuditEventRow = Effect.fn(
  "GovernedActionCodec.decodeAuditEventRow"
)(function*(row: typeof GovernedActionAuditEventRow.Type) {
  const malformed = (diagnosticCode: GovernedActionQuarantineReasonCode) =>
    governedActionRecordError({
      workspaceId: row.workspaceId,
      recordKind: "governed-action-audit",
      recordKey: row.auditEventId,
      diagnosticCode
    })
  const transition = yield* decodeTransitionJson(row.payloadJson).pipe(
    Effect.mapError(() => malformed("governed-action-audit-mismatch"))
  )
  yield* verifyGovernedActionTransition(transition).pipe(
    Effect.mapError(() => malformed("governed-action-audit-mismatch"))
  )
  const actualDigest = yield* digestGovernedActionTransition(transition).pipe(
    Effect.mapError(() => malformed("governed-action-audit-mismatch"))
  )
  if (actualDigest !== row.payloadDigest) {
    return yield* malformed("governed-action-audit-mismatch")
  }
  const cause = projectGovernedActionCause(transition.cause)
  const projectionMatches = transition.workspaceId === row.workspaceId &&
    transition.actionId === row.actionId &&
    transition.transitionId === row.transitionId &&
    transition.toState === row.eventKind &&
    transition.causationId === row.causationId &&
    transition.correlationId === row.correlationId &&
    encodeTimestamp(transition.occurredAt) === row.occurredAt &&
    causeProjectionMatches(cause, {
      causeKind: row.causeKind,
      causeActorId: row.actorId,
      causeSessionId: row.sessionId,
      causeJobId: row.jobId,
      causeSystemComponent: row.systemComponent
    })
  if (!projectionMatches) {
    return yield* malformed("governed-action-audit-mismatch")
  }
  return transition
})
