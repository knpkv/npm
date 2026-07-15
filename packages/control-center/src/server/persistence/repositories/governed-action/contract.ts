import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import {
  GovernedActionAttemptV1,
  GovernedActionAuthorizationV1,
  GovernedActionCommandId,
  GovernedActionEnvelopeV1,
  GovernedActionLifecycleHeadV1,
  governedActionPermissionGrants,
  GovernedActionPolicyEvaluationV1,
  GovernedActionTransitionCause,
  GovernedActionTransitionCommand,
  GovernedActionTransitionV1
} from "../../../../domain/governedAction/index.js"
import {
  DomainEventId,
  GovernedActionId,
  GovernedActionTransitionId,
  WorkspaceId
} from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"

/** Immutable identity of the audit record paired with one action transition. */
export const GovernedActionAuditEventId = DomainEventId

/** Decoded governed-action audit identity. */
export type GovernedActionAuditEventId = typeof GovernedActionAuditEventId.Type

/** Authority records that must commit in the same transaction as their transition. */
export const GovernedActionCommitCompanion = Schema.TaggedUnion({
  none: {},
  authorization: { authorization: GovernedActionAuthorizationV1 },
  dispatch: {
    policyEvaluation: GovernedActionPolicyEvaluationV1,
    attempt: GovernedActionAttemptV1
  },
  policyDenial: { policyEvaluation: GovernedActionPolicyEvaluationV1 }
})

/** Decoded authority companion. */
export type GovernedActionCommitCompanion = typeof GovernedActionCommitCompanion.Type

const companionMatchesCommand = ({
  command,
  companion
}: {
  readonly command: GovernedActionTransitionCommand
  readonly companion: GovernedActionCommitCompanion
}): boolean => {
  switch (command._tag) {
    case "authorize":
      return companion._tag === "authorization" &&
        companion.authorization.authorizationId === command.authorizationId
    case "start":
      return companion._tag === "dispatch" && companion.attempt.attemptId === command.attemptId
    case "deny":
      return companion._tag === "none" || companion._tag === "policyDenial"
    case "propose":
    case "expire":
    case "cancel":
    case "requestCancellation":
    case "recordAccepted":
    case "recordSucceeded":
    case "recordFailed":
    case "recordUnknown":
    case "recordCancelled":
    case "reconciliationPending":
      return companion._tag === "none"
  }
}

/** Caller intent; lifecycle state, sequence, lineage, and audit payload are derived by the repository. */
export const GovernedActionCommitInput = Schema.Struct({
  envelope: GovernedActionEnvelopeV1,
  expectedHeadTransitionId: Schema.NullOr(GovernedActionTransitionId),
  transitionId: GovernedActionTransitionId,
  commandId: GovernedActionCommandId,
  command: GovernedActionTransitionCommand,
  cause: GovernedActionTransitionCause,
  occurredAt: UtcTimestamp,
  causationId: GovernedActionTransitionV1.fields.causationId,
  correlationId: GovernedActionTransitionV1.fields.correlationId,
  companion: GovernedActionCommitCompanion,
  auditEventId: GovernedActionAuditEventId
}).check(
  Schema.makeFilter(companionMatchesCommand, {
    expected: "authority companion to match the lifecycle command"
  }),
  Schema.makeFilter(
    ({ command, expectedHeadTransitionId }) => (command._tag === "propose") === (expectedHeadTransitionId === null),
    { expected: "only a proposal to begin without an expected lifecycle head" }
  ),
  Schema.makeFilter(
    ({ cause, command, envelope }) => {
      if (command._tag !== "propose") return true
      if (envelope.origin._tag === "human" && cause._tag === "human") {
        return envelope.origin.actor.personId === cause.actor.personId &&
          envelope.origin.sessionId === cause.sessionId
      }
      if (envelope.origin._tag === "agent" && cause._tag === "agent") {
        return envelope.origin.actor.agentId === cause.actor.agentId && envelope.origin.jobId === cause.jobId
      }
      return false
    },
    { expected: "proposal cause to match its immutable origin" }
  ),
  Schema.makeFilter(
    ({ cause, command, companion, envelope, occurredAt }) =>
      companion._tag !== "authorization" ||
      (command._tag === "authorize" &&
        companion.authorization.workspaceId === envelope.workspaceId &&
        companion.authorization.actionId === envelope.actionId &&
        companion.authorization.pluginConnectionId === envelope.pluginConnectionId &&
        companion.authorization.pluginConnectionRevision === envelope.pluginConnectionRevision &&
        companion.authorization.pluginConnectionAuthorityDigest === envelope.pluginConnectionAuthorityDigest &&
        companion.authorization.actionEnvelopeDigest === envelope.envelopeDigest &&
        companion.authorization.idempotencyKey === envelope.idempotencyKey &&
        companion.authorization.payloadDigest === envelope.proposal.payloadDigest &&
        companion.authorization.evidenceSetDigest === envelope.evidenceSetDigest &&
        companion.authorization.policyDigest === envelope.policy.policyDigest &&
        companion.authorization.expectedRevision === envelope.proposal.request.expectedRevision &&
        companion.authorization.capabilityVersion === envelope.capability.version &&
        companion.authorization.requiredPermission === envelope.policy.requiredPermission &&
        governedActionPermissionGrants(
          companion.authorization.sessionPermission,
          companion.authorization.requiredPermission
        ) &&
        cause._tag === "human" &&
        companion.authorization.actor.personId === cause.actor.personId &&
        companion.authorization.sessionId === cause.sessionId &&
        companion.authorization.authorizationId === command.authorizationId &&
        DateTime.Order(companion.authorization.authorizedAt, occurredAt) === 0 &&
        DateTime.Order(companion.authorization.authorizedAt, envelope.proposal.proposedAt) >= 0 &&
        DateTime.Order(companion.authorization.authorizedAt, envelope.proposalExpiresAt) < 0 &&
        DateTime.Order(companion.authorization.expiresAt, envelope.proposalExpiresAt) <= 0),
    { expected: "authorization to bind the exact action and transition" }
  ),
  Schema.makeFilter(
    ({ companion, envelope, occurredAt }) => {
      if (companion._tag !== "dispatch") return true
      return companion.attempt.workspaceId === envelope.workspaceId &&
        companion.attempt.actionId === envelope.actionId &&
        companion.attempt.actionEnvelopeDigest === envelope.envelopeDigest &&
        companion.attempt.idempotencyKey === envelope.idempotencyKey &&
        companion.attempt.pluginConnectionId === envelope.pluginConnectionId &&
        companion.attempt.expectedRevision === envelope.proposal.request.expectedRevision &&
        companion.policyEvaluation.workspaceId === envelope.workspaceId &&
        companion.policyEvaluation.actionId === envelope.actionId &&
        companion.policyEvaluation.policy.policyId === envelope.policy.policyId &&
        companion.policyEvaluation.policy.policyVersion === envelope.policy.policyVersion &&
        companion.policyEvaluation.policy.policyDigest === envelope.policy.policyDigest &&
        companion.policyEvaluation.policy.requiredPermission === envelope.policy.requiredPermission &&
        companion.policyEvaluation.payloadDigest === envelope.proposal.payloadDigest &&
        companion.policyEvaluation.evidenceSetDigest === envelope.evidenceSetDigest &&
        companion.policyEvaluation.expectedRevision === envelope.proposal.request.expectedRevision &&
        companion.policyEvaluation.decision === "allowed" &&
        DateTime.Order(companion.policyEvaluation.evaluatedAt, envelope.proposal.proposedAt) >= 0 &&
        DateTime.Order(companion.policyEvaluation.evaluatedAt, companion.attempt.startedAt) === 0 &&
        DateTime.Order(companion.attempt.startedAt, occurredAt) === 0 &&
        DateTime.Order(companion.attempt.startedAt, envelope.proposalExpiresAt) < 0 &&
        envelope.evidence.every((reference) =>
          reference.source === "current" &&
          DateTime.Order(reference.evaluatedAt, companion.attempt.startedAt) <= 0 &&
          (reference.currentUntil === null ||
            DateTime.Order(companion.attempt.startedAt, reference.currentUntil) < 0) &&
          (reference.validUntil === null ||
            DateTime.Order(companion.attempt.startedAt, reference.validUntil) < 0)
        )
    },
    { expected: "dispatch authority to bind the exact action envelope" }
  ),
  Schema.makeFilter(
    ({ companion, envelope, occurredAt }) =>
      companion._tag !== "policyDenial" ||
      (companion.policyEvaluation.workspaceId === envelope.workspaceId &&
        companion.policyEvaluation.actionId === envelope.actionId &&
        companion.policyEvaluation.policy.policyId === envelope.policy.policyId &&
        companion.policyEvaluation.policy.policyVersion === envelope.policy.policyVersion &&
        companion.policyEvaluation.policy.policyDigest === envelope.policy.policyDigest &&
        companion.policyEvaluation.policy.requiredPermission === envelope.policy.requiredPermission &&
        companion.policyEvaluation.payloadDigest === envelope.proposal.payloadDigest &&
        companion.policyEvaluation.evidenceSetDigest === envelope.evidenceSetDigest &&
        companion.policyEvaluation.expectedRevision === envelope.proposal.request.expectedRevision &&
        companion.policyEvaluation.decision === "denied" &&
        DateTime.Order(companion.policyEvaluation.evaluatedAt, occurredAt) <= 0),
    { expected: "denied policy evaluation to bind the exact action inputs" }
  )
)

/** Decoded atomic governed-action commit intent. */
export type GovernedActionCommitInput = typeof GovernedActionCommitInput.Type

/** Workspace-scoped aggregate lookup. */
export const GovernedActionReadInput = Schema.Struct({
  workspaceId: WorkspaceId,
  actionId: GovernedActionId
})

/** Decoded governed-action lookup. */
export type GovernedActionReadInput = typeof GovernedActionReadInput.Type

/** Trusted governed action reconstructed from its immutable ordered history. */
export const GovernedActionRecord = Schema.Struct({
  envelope: GovernedActionEnvelopeV1,
  head: GovernedActionLifecycleHeadV1,
  headTransition: GovernedActionTransitionV1,
  history: Schema.Array(GovernedActionTransitionV1).check(Schema.isNonEmpty()),
  authorization: Schema.NullOr(GovernedActionAuthorizationV1),
  policyEvaluation: Schema.NullOr(GovernedActionPolicyEvaluationV1),
  attempt: Schema.NullOr(GovernedActionAttemptV1)
})

/** Decoded governed-action aggregate. */
export type GovernedActionRecord = typeof GovernedActionRecord.Type

/** Exact command commit or replay result. Replays never carry an execution permit. */
export type GovernedActionCommitResult =
  | { readonly _tag: "committed"; readonly transition: GovernedActionTransitionV1 }
  | { readonly _tag: "replayed"; readonly transition: GovernedActionTransitionV1 }

/** Caller material is invalid or conflicts with immutable governed-action identity. */
export class GovernedActionInputError extends Schema.TaggedErrorClass<GovernedActionInputError>()(
  "GovernedActionInputError",
  {
    operation: Schema.Literals(["commit", "read"]),
    reason: Schema.Literals([
      "changed-command-retry",
      "conflicting-action-identity",
      "illegal-transition",
      "invalid-request",
      "stale-head"
    ])
  }
) {}
