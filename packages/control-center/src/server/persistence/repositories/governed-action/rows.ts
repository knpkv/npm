import * as Schema from "effect/Schema"

import { DomainEventCorrelationId } from "../../../../domain/domainEvent.js"
import {
  GovernedActionAttemptDigest,
  GovernedActionAuthorizationDigest,
  GovernedActionEnvelopeDigest,
  GovernedActionIdempotencyKey,
  GovernedActionPolicyEvaluationDigest
} from "../../../../domain/governedAction/model.js"
import {
  GovernedActionCommandDigest,
  GovernedActionCommandId,
  GovernedActionState,
  GovernedActionTransitionDigest
} from "../../../../domain/governedAction/stateMachine.js"
import {
  AgentId,
  DomainEventId,
  EntityId,
  GovernedActionAttemptId,
  GovernedActionAuthorizationId,
  GovernedActionId,
  GovernedActionTransitionId,
  JobId,
  PersonId,
  PluginConnectionId,
  SessionId,
  WorkspaceId
} from "../../../../domain/identifiers.js"
import { PluginActionReconciliationKey, PluginProviderOperationId } from "../../../../domain/plugins/actions.js"
import { ProviderId } from "../../../../domain/sourceRevision.js"
import { PersistedGovernedActionReconciliationLocator } from "../../governedActionReconciliationLocator.js"
import { GovernedActionAuditEventId } from "./contract.js"

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const GovernedActionLineageKind = Schema.Literals([
  "none",
  "accepted",
  "reconcilable",
  "manual",
  "terminal"
])
const GovernedActionTerminalStatus = Schema.Literals(["succeeded", "failed", "cancelled"])
const GovernedActionCauseKind = Schema.Literals(["human", "agent", "system"])
const GovernedActionCommandTag = Schema.Literals([
  "propose",
  "authorize",
  "deny",
  "expire",
  "cancel",
  "start",
  "requestCancellation",
  "recordAccepted",
  "recordSucceeded",
  "recordFailed",
  "recordUnknown",
  "recordCancelled",
  "reconciliationPending"
])
const GovernedActionSystemComponent = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/u, { expected: "a bounded system component" })
)

/** Driver row retained without trust until repository-controlled decoding and verification. */
export const RawGovernedActionRow = Schema.Record(Schema.String, Schema.Unknown)

/** Persisted immutable action envelope plus its materialized lifecycle head. */
export const GovernedActionRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  targetEntityId: EntityId,
  idempotencyKey: GovernedActionIdempotencyKey,
  envelopeDigest: GovernedActionEnvelopeDigest,
  envelopeJson: Schema.String,
  state: Schema.NullOr(GovernedActionState),
  lineageJson: Schema.NullOr(Schema.String),
  lineageKind: Schema.NullOr(GovernedActionLineageKind),
  providerOperationId: Schema.NullOr(PluginProviderOperationId),
  reconciliationKey: Schema.NullOr(PluginActionReconciliationKey),
  terminalStatus: Schema.NullOr(GovernedActionTerminalStatus),
  headTransitionId: Schema.NullOr(GovernedActionTransitionId),
  headSequence: Schema.NullOr(PositiveInteger),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

/** Persisted canonical policy decision bound to one governed action. */
export const GovernedActionPolicyEvaluationRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  evaluationDigest: GovernedActionPolicyEvaluationDigest,
  evaluationJson: Schema.String,
  decision: Schema.Literals(["allowed", "denied"]),
  evaluatedAt: Schema.String
})

/** Persisted immutable human authorization bound to an exact envelope. */
export const GovernedActionAuthorizationRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  authorizationId: GovernedActionAuthorizationId,
  sessionId: SessionId,
  envelopeDigest: GovernedActionEnvelopeDigest,
  authorizationDigest: GovernedActionAuthorizationDigest,
  authorizationJson: Schema.String,
  authorizedAt: Schema.String,
  expiresAt: Schema.String
})

/** Persisted durable dispatch intent bound to authorization and fresh policy. */
export const GovernedActionAttemptRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  attemptId: GovernedActionAttemptId,
  authorizationId: GovernedActionAuthorizationId,
  policyEvaluationDigest: GovernedActionPolicyEvaluationDigest,
  attemptDigest: GovernedActionAttemptDigest,
  attemptNumber: Schema.Literal(1),
  attemptJson: Schema.String,
  startedAt: Schema.String
})

/** Persisted transition with exact command, cause, result-lineage, and replay projections. */
export const GovernedActionTransitionRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  transitionId: GovernedActionTransitionId,
  previousTransitionId: Schema.NullOr(GovernedActionTransitionId),
  sequence: PositiveInteger,
  commandId: GovernedActionCommandId,
  commandTag: GovernedActionCommandTag,
  authorizationId: Schema.NullOr(GovernedActionAuthorizationId),
  attemptId: Schema.NullOr(GovernedActionAttemptId),
  policyEvaluationDigest: Schema.NullOr(GovernedActionPolicyEvaluationDigest),
  outcomeSourceKind: Schema.NullOr(Schema.Literals(["direct", "providerOperation", "reconciliation"])),
  commandProviderOperationId: Schema.NullOr(PluginProviderOperationId),
  commandReconciliationKey: Schema.NullOr(PersistedGovernedActionReconciliationLocator),
  commandTerminalStatus: Schema.NullOr(GovernedActionTerminalStatus),
  commandUnknownKind: Schema.NullOr(Schema.Literals(["reconcilable", "manual"])),
  commandDigest: GovernedActionCommandDigest,
  transitionDigest: GovernedActionTransitionDigest,
  envelopeDigest: GovernedActionEnvelopeDigest,
  fromState: Schema.NullOr(GovernedActionState),
  toState: GovernedActionState,
  resultLineageJson: Schema.String,
  resultLineageKind: GovernedActionLineageKind,
  resultProviderOperationId: Schema.NullOr(PluginProviderOperationId),
  resultReconciliationKey: Schema.NullOr(PluginActionReconciliationKey),
  resultTerminalStatus: Schema.NullOr(GovernedActionTerminalStatus),
  causeKind: GovernedActionCauseKind,
  causeActorId: Schema.NullOr(Schema.Union([PersonId, AgentId])),
  causeSessionId: Schema.NullOr(SessionId),
  causeJobId: Schema.NullOr(JobId),
  causeSystemComponent: Schema.NullOr(GovernedActionSystemComponent),
  causationId: Schema.NullOr(DomainEventId),
  correlationId: Schema.NullOr(DomainEventCorrelationId),
  transitionJson: Schema.String,
  occurredAt: Schema.String
})

/** Persisted audit event whose payload is the exact canonical transition JSON. */
export const GovernedActionAuditEventRow = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId,
  transitionId: GovernedActionTransitionId,
  auditEventId: GovernedActionAuditEventId,
  eventKind: GovernedActionState,
  causeKind: GovernedActionCauseKind,
  actorId: Schema.NullOr(Schema.Union([PersonId, AgentId])),
  sessionId: Schema.NullOr(SessionId),
  jobId: Schema.NullOr(JobId),
  systemComponent: Schema.NullOr(GovernedActionSystemComponent),
  causationId: Schema.NullOr(DomainEventId),
  correlationId: Schema.NullOr(DomainEventCorrelationId),
  payloadDigest: GovernedActionTransitionDigest,
  payloadJson: Schema.String,
  occurredAt: Schema.String
})

/** Decode an untrusted driver result without allowing malformed rows into repository logic. */
export const decodeGovernedActionRows = <SchemaType extends Schema.Top>(schema: SchemaType, rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(rows)
