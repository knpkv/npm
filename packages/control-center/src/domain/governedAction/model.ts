import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import { AgentActor, HumanActor, Role } from "../actors.js"
import { DomainEventCorrelationId } from "../domainEvent.js"
import {
  DomainEventId,
  EntityId,
  EvidenceClaimId,
  EvidenceId,
  GovernedActionAttemptId,
  GovernedActionAuthorizationId,
  GovernedActionId,
  JobId,
  PluginConnectionId,
  SessionId,
  WorkspaceId
} from "../identifiers.js"
import { PluginActionPayloadDigest, PluginActionProposalV1, ReadyPluginActionPreflightV1 } from "../plugins/actions.js"
import { PluginId, SemanticVersion } from "../plugins/descriptor.js"
import { PluginEntityType } from "../plugins/events.js"
import { ProviderId, Revision, SourceRevision } from "../sourceRevision.js"
import { UtcTimestamp } from "../utcTimestamp.js"

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const boundedIdentifier = (name: string, maximumLength: number) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[A-Za-z0-9._:/-]+$/u, { expected: "a bounded action identifier" })
  ).pipe(Schema.brand(name))
const sha256Digest = (name: string) =>
  Schema.String.check(
    Schema.isPattern(/^sha256:[0-9a-f]{64}$/u, { expected: "a lowercase SHA-256 digest" })
  ).pipe(Schema.brand(name))
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
const isCanonicalText = (values: ReadonlyArray<string>): boolean =>
  values.every((value, index) => index === 0 || compareText(values[index - 1] ?? "", value) < 0)

/** Digest of every immutable field in a governed action envelope. */
export const GovernedActionEnvelopeDigest = sha256Digest("GovernedActionEnvelopeDigest")

/** Decoded governed-action envelope digest. */
export type GovernedActionEnvelopeDigest = typeof GovernedActionEnvelopeDigest.Type

/** Digest of the canonical evidence-reference set bound to an action. */
export const GovernedActionEvidenceSetDigest = sha256Digest("GovernedActionEvidenceSetDigest")

/** Decoded governed-action evidence-set digest. */
export type GovernedActionEvidenceSetDigest = typeof GovernedActionEvidenceSetDigest.Type

/** Digest of a fresh policy evaluation persisted with one exact dispatch attempt. */
export const GovernedActionPolicyEvaluationDigest = sha256Digest("GovernedActionPolicyEvaluationDigest")

/** Decoded fresh-policy evaluation digest. */
export type GovernedActionPolicyEvaluationDigest = typeof GovernedActionPolicyEvaluationDigest.Type

/** Digest of every immutable field in one human action authorization. */
export const GovernedActionAuthorizationDigest = sha256Digest("GovernedActionAuthorizationDigest")

/** Decoded governed-action authorization digest. */
export type GovernedActionAuthorizationDigest = typeof GovernedActionAuthorizationDigest.Type

/** Digest of every immutable field in one durable dispatch attempt. */
export const GovernedActionAttemptDigest = sha256Digest("GovernedActionAttemptDigest")

/** Decoded governed-action attempt digest. */
export type GovernedActionAttemptDigest = typeof GovernedActionAttemptDigest.Type

/** Digest of the exact versioned policy snapshot used for authorization. */
export const GovernedActionPolicyDigest = sha256Digest("GovernedActionPolicyDigest")

/** Decoded governed-action policy digest. */
export type GovernedActionPolicyDigest = typeof GovernedActionPolicyDigest.Type

/** Stable identity of one governed-action policy family. */
export const GovernedActionPolicyId = boundedIdentifier("GovernedActionPolicyId", 200)

/** Decoded governed-action policy identity. */
export type GovernedActionPolicyId = typeof GovernedActionPolicyId.Type

/** Workspace-connection scoped key that deduplicates one governed provider mutation. */
export const GovernedActionIdempotencyKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
).pipe(Schema.brand("GovernedActionIdempotencyKey"))

/** Decoded governed-action idempotency key. */
export type GovernedActionIdempotencyKey = typeof GovernedActionIdempotencyKey.Type

/** Optimistic revision of the exact configured plugin connection authorized for dispatch. */
export const GovernedActionPluginConnectionRevision = PositiveInteger.pipe(
  Schema.brand("GovernedActionPluginConnectionRevision")
)

/** Decoded configured-connection revision bound to a governed action. */
export type GovernedActionPluginConnectionRevision = typeof GovernedActionPluginConnectionRevision.Type

/** Non-secret digest that changes with configuration, credentials, or resolved provider account. */
export const GovernedActionPluginConnectionAuthorityDigest = sha256Digest(
  "GovernedActionPluginConnectionAuthorityDigest"
)

/** Decoded configured-connection authority generation. */
export type GovernedActionPluginConnectionAuthorityDigest = typeof GovernedActionPluginConnectionAuthorityDigest.Type

/** Versioned policy and permission snapshot bound into an action proposal. */
export const GovernedActionPolicyBinding = Schema.Struct({
  policyId: GovernedActionPolicyId,
  policyVersion: PositiveInteger,
  policyDigest: GovernedActionPolicyDigest,
  requiredPermission: Role
})

/** Decoded governed-action policy binding. */
export type GovernedActionPolicyBinding = typeof GovernedActionPolicyBinding.Type

/** Fresh policy result recomputed immediately before a provider mutation may dispatch. */
export const GovernedActionPolicyEvaluationV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  actionId: GovernedActionId,
  workspaceId: WorkspaceId,
  policy: GovernedActionPolicyBinding,
  payloadDigest: PluginActionPayloadDigest,
  evidenceSetDigest: GovernedActionEvidenceSetDigest,
  expectedRevision: Revision,
  decision: Schema.Literals(["allowed", "denied"]),
  evaluatedAt: UtcTimestamp
})

/** Decoded fresh policy evaluation for one exact governed action. */
export type GovernedActionPolicyEvaluationV1 = typeof GovernedActionPolicyEvaluationV1.Type

/** Current normalized target and exact provider provenance checked before dispatch. */
export const GovernedActionTargetSnapshotV1 = Schema.Struct({
  workspaceId: WorkspaceId,
  entityId: EntityId,
  entityType: PluginEntityType,
  sourceRevision: SourceRevision
})

/** Decoded current target snapshot used by governed-action authority. */
export type GovernedActionTargetSnapshotV1 = typeof GovernedActionTargetSnapshotV1.Type

/** Exact immutable evidence state considered by policy at proposal time. */
export const GovernedActionEvidenceReference = Schema.Struct({
  workspaceId: WorkspaceId,
  evidenceId: EvidenceId,
  evidenceClaimIds: Schema.Array(EvidenceClaimId).check(
    Schema.isUnique(),
    Schema.makeFilter(isCanonicalText, { expected: "evidence claim identities in canonical order" }),
    Schema.makeFilter((evidenceClaimIds) => evidenceClaimIds.length <= 100, {
      expected: "at most 100 evidence claims per evidence item"
    })
  ),
  observedAt: UtcTimestamp,
  validUntil: Schema.NullOr(UtcTimestamp),
  currentUntil: Schema.NullOr(UtcTimestamp),
  evaluatedAt: UtcTimestamp,
  source: Schema.Literals(["current", "stale", "missing", "unavailable"]),
  validity: Schema.Literals(["valid", "expired"])
}).check(
  Schema.makeFilter(
    ({ evaluatedAt, observedAt }) => DateTime.Order(observedAt, evaluatedAt) <= 0,
    { expected: "evidence evaluation not to precede observation" }
  ),
  Schema.makeFilter(
    ({ observedAt, validUntil }) => validUntil === null || DateTime.Order(observedAt, validUntil) < 0,
    { expected: "evidence validity to end after observation" }
  ),
  Schema.makeFilter(
    ({ currentUntil, observedAt }) => currentUntil === null || DateTime.Order(observedAt, currentUntil) < 0,
    { expected: "evidence freshness to end after observation" }
  ),
  Schema.makeFilter(
    ({ currentUntil, evaluatedAt, source }) => {
      if (source === "current") return currentUntil === null || DateTime.Order(evaluatedAt, currentUntil) < 0
      if (source === "stale") return currentUntil !== null && DateTime.Order(evaluatedAt, currentUntil) >= 0
      return currentUntil === null
    },
    { expected: "evidence source state to match its evaluation and freshness window" }
  ),
  Schema.makeFilter(
    ({ evaluatedAt, validUntil, validity }) => {
      const expectedValidity = validUntil === null || DateTime.Order(evaluatedAt, validUntil) < 0
        ? "valid"
        : "expired"
      return validity === expectedValidity
    },
    { expected: "evidence validity to match its evaluation and validity window" }
  )
)

/** Decoded immutable evidence reference. */
export type GovernedActionEvidenceReference = typeof GovernedActionEvidenceReference.Type

/** Human or agent provenance for a proposal; neither form grants execution authority. */
export const GovernedActionProposalOrigin = Schema.TaggedUnion({
  human: {
    actor: HumanActor,
    sessionId: SessionId
  },
  agent: {
    actor: AgentActor,
    jobId: JobId,
    initiatingSessionId: Schema.NullOr(SessionId)
  }
})

/** Decoded governed-action proposal provenance. */
export type GovernedActionProposalOrigin = typeof GovernedActionProposalOrigin.Type

const canonicalEvidenceReferences = Schema.makeFilter(
  (evidence: ReadonlyArray<GovernedActionEvidenceReference>) =>
    isCanonicalText(evidence.map(({ evidenceId }) => evidenceId)),
  { expected: "unique evidence references in canonical evidence-id order" }
)

/** Bounded canonical set of immutable evidence references used by action authority. */
export const GovernedActionEvidenceSet = Schema.Array(GovernedActionEvidenceReference).check(
  Schema.makeFilter((evidence) => evidence.length <= 100, { expected: "at most 100 evidence references" }),
  canonicalEvidenceReferences
)

/** Decoded governed-action evidence set. */
export type GovernedActionEvidenceSet = typeof GovernedActionEvidenceSet.Type

const governedActionEnvelopeMaterialFields = {
  schemaVersion: Schema.Literal(1),
  actionId: GovernedActionId,
  idempotencyKey: GovernedActionIdempotencyKey,
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  pluginConnectionRevision: GovernedActionPluginConnectionRevision,
  pluginConnectionAuthorityDigest: GovernedActionPluginConnectionAuthorityDigest,
  pluginId: PluginId,
  pluginContractVersion: SemanticVersion,
  pluginAdapterVersion: SemanticVersion,
  providerId: ProviderId,
  capability: Schema.Struct({
    capabilityId: Schema.Literal("action.execute"),
    version: PositiveInteger
  }),
  targetEntityId: EntityId,
  proposal: PluginActionProposalV1,
  evidence: GovernedActionEvidenceSet,
  evidenceSetDigest: GovernedActionEvidenceSetDigest,
  policy: GovernedActionPolicyBinding,
  origin: GovernedActionProposalOrigin,
  proposalExpiresAt: UtcTimestamp,
  causationId: Schema.NullOr(DomainEventId),
  correlationId: Schema.NullOr(DomainEventCorrelationId)
}

/** Complete digest-free material used to derive an immutable action envelope identity. */
export const GovernedActionEnvelopeMaterialV1 = Schema.Struct(governedActionEnvelopeMaterialFields).check(
  Schema.makeFilter(
    ({ capability, proposal }) => capability.version === proposal.capabilityVersion,
    { expected: "envelope capability version to match the proposal capability version" }
  ),
  Schema.makeFilter(
    ({ proposal, proposalExpiresAt }) => DateTime.Order(proposal.proposedAt, proposalExpiresAt) < 0,
    { expected: "action proposal to expire after it is created" }
  ),
  Schema.makeFilter(
    ({ evidence, workspaceId }) => evidence.every((reference) => reference.workspaceId === workspaceId),
    { expected: "every governed-action evidence reference to belong to the action workspace" }
  )
)

/** Decoded digest-free V1 governed-action envelope material. */
export type GovernedActionEnvelopeMaterialV1 = typeof GovernedActionEnvelopeMaterialV1.Type

/** Immutable, versioned host authority for one proposed provider mutation. */
export const GovernedActionEnvelopeV1 = Schema.Struct({
  ...governedActionEnvelopeMaterialFields,
  envelopeDigest: GovernedActionEnvelopeDigest
}).check(
  Schema.makeFilter(
    ({ capability, proposal }) => capability.version === proposal.capabilityVersion,
    { expected: "envelope capability version to match the proposal capability version" }
  ),
  Schema.makeFilter(
    ({ proposal, proposalExpiresAt }) => DateTime.Order(proposal.proposedAt, proposalExpiresAt) < 0,
    { expected: "action proposal to expire after it is created" }
  ),
  Schema.makeFilter(
    ({ evidence, workspaceId }) => evidence.every((reference) => reference.workspaceId === workspaceId),
    { expected: "every governed-action evidence reference to belong to the action workspace" }
  )
)

/** Decoded immutable V1 governed-action envelope. */
export type GovernedActionEnvelopeV1 = typeof GovernedActionEnvelopeV1.Type

/** Human authorization bound to the complete immutable action and policy inputs. */
export const GovernedActionAuthorizationV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  authorizationId: GovernedActionAuthorizationId,
  actionId: GovernedActionId,
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  pluginConnectionRevision: GovernedActionPluginConnectionRevision,
  pluginConnectionAuthorityDigest: GovernedActionPluginConnectionAuthorityDigest,
  actionEnvelopeDigest: GovernedActionEnvelopeDigest,
  idempotencyKey: GovernedActionIdempotencyKey,
  payloadDigest: PluginActionPayloadDigest,
  evidenceSetDigest: GovernedActionEvidenceSetDigest,
  policyDigest: GovernedActionPolicyDigest,
  expectedRevision: Revision,
  capabilityVersion: PositiveInteger,
  actor: HumanActor,
  sessionId: SessionId,
  sessionPermission: Role,
  sessionExpiresAt: UtcTimestamp,
  requiredPermission: Role,
  authorizedAt: UtcTimestamp,
  expiresAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ authorizedAt, expiresAt }) => DateTime.Order(authorizedAt, expiresAt) < 0,
    { expected: "governed-action authorization to expire after it is issued" }
  ),
  Schema.makeFilter(
    ({ expiresAt, sessionExpiresAt }) => DateTime.Order(expiresAt, sessionExpiresAt) <= 0,
    { expected: "governed-action authorization not to outlive its authenticated session" }
  )
)

/** Decoded immutable human authorization. */
export type GovernedActionAuthorizationV1 = typeof GovernedActionAuthorizationV1.Type

/** Durable dispatch intent created only after an exact ready preflight. */
export const GovernedActionAttemptV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  attemptId: GovernedActionAttemptId,
  authorizationId: GovernedActionAuthorizationId,
  actionId: GovernedActionId,
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  idempotencyKey: GovernedActionIdempotencyKey,
  attemptNumber: Schema.Literal(1),
  actionEnvelopeDigest: GovernedActionEnvelopeDigest,
  expectedRevision: Revision,
  policyEvaluationDigest: GovernedActionPolicyEvaluationDigest,
  preflight: ReadyPluginActionPreflightV1,
  startedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ expectedRevision, preflight }) => expectedRevision === preflight.checkedRevision,
    { expected: "dispatch intent revision to match the ready preflight revision" }
  ),
  Schema.makeFilter(
    ({ preflight, startedAt }) => DateTime.Order(preflight.checkedAt, startedAt) <= 0,
    { expected: "dispatch intent not to precede its ready preflight" }
  )
)

/** Decoded immutable dispatch intent. */
export type GovernedActionAttemptV1 = typeof GovernedActionAttemptV1.Type
