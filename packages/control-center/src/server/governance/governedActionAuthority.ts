import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  type GovernedActionAttemptV1 as GovernedActionAttempt,
  GovernedActionAuthorityMismatch,
  type GovernedActionAuthorityMismatch as AuthorityMismatch,
  governedActionAuthorityMismatches,
  type GovernedActionAuthorizationV1 as GovernedActionAuthorization,
  type GovernedActionEnvelopeV1 as GovernedActionEnvelope,
  type GovernedActionEvidenceSet as GovernedActionEvidence,
  type GovernedActionPluginConnectionAuthorityDigest,
  type GovernedActionPluginConnectionRevision,
  type GovernedActionPolicyEvaluationV1 as GovernedActionPolicyEvaluation,
  type GovernedActionTargetSnapshotV1 as GovernedActionTargetSnapshot
} from "../../domain/governedAction/index.js"
import type { PluginConnectionId, WorkspaceId } from "../../domain/identifiers.js"
import type { NegotiatedPluginDescriptorV1 } from "../../domain/plugins/descriptor.js"
import type { ProviderId } from "../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import type { SessionSummary } from "../auth/models.js"
import {
  digestGovernedActionEvidenceSet,
  digestGovernedActionPolicyEvaluation,
  type VerifiedGovernedActionEnvelope,
  verifyGovernedActionEnvelope
} from "./governedActionDigests.js"

/** Fail-closed reasons why a structurally valid action cannot dispatch. */
export class GovernedActionAuthorityRejected extends Schema.TaggedErrorClass<GovernedActionAuthorityRejected>()(
  "GovernedActionAuthorityRejected",
  {
    mismatches: Schema.Array(GovernedActionAuthorityMismatch).check(
      Schema.isNonEmpty(),
      Schema.isUnique(),
      Schema.makeFilter((mismatches) => mismatches.length <= 64, {
        expected: "at most 64 governed-action authority mismatches"
      })
    )
  }
) {}

/** Trusted live plugin, policy, session, and evidence inputs required immediately before dispatch. */
export interface VerifyGovernedActionDispatchAuthorityInput {
  readonly envelope: GovernedActionEnvelope
  readonly authorization: GovernedActionAuthorization
  readonly attempt: GovernedActionAttempt
  readonly currentEvidence: GovernedActionEvidence
  readonly currentPlugin: {
    readonly authorityDigest: GovernedActionPluginConnectionAuthorityDigest
    readonly connectionId: PluginConnectionId
    readonly enabled: boolean
    readonly negotiated: NegotiatedPluginDescriptorV1
    readonly providerId: ProviderId
    readonly revision: GovernedActionPluginConnectionRevision
    readonly workspaceId: WorkspaceId
  }
  readonly currentPolicy: GovernedActionPolicyEvaluation
  readonly currentTarget: GovernedActionTargetSnapshot
  readonly session: SessionSummary
  readonly evaluatedAt: UtcTimestamp
}

class VerifiedDispatchAuthority {
  readonly #envelope: VerifiedGovernedActionEnvelope
  readonly #authorization: GovernedActionAuthorization
  readonly #attempt: GovernedActionAttempt

  constructor(
    envelope: VerifiedGovernedActionEnvelope,
    authorization: GovernedActionAuthorization,
    attempt: GovernedActionAttempt
  ) {
    this.#envelope = envelope
    this.#authorization = authorization
    this.#attempt = attempt
  }

  /** Canonically verified envelope approved for one exact dispatch attempt. */
  get envelope(): VerifiedGovernedActionEnvelope {
    return this.#envelope
  }

  /** Human grant proven to match the verified action envelope and current session. */
  get authorization(): GovernedActionAuthorization {
    return this.#authorization
  }

  /** Single durable dispatch intent proven to match the verified human grant. */
  get attempt(): GovernedActionAttempt {
    return this.#attempt
  }
}

/** Nominal server-only proof consumed by the internal provider-dispatch engine. */
export type VerifiedGovernedActionDispatchAuthority = VerifiedDispatchAuthority

const currentSessionMismatches = (
  input: VerifyGovernedActionDispatchAuthorityInput
): ReadonlyArray<AuthorityMismatch> => {
  const mismatches: Array<AuthorityMismatch> = []
  const { authorization, envelope, evaluatedAt, session } = input
  if (session.sessionId !== authorization.sessionId) mismatches.push("session-id-mismatch")
  if (session.workspaceId !== envelope.workspaceId || session.workspaceId !== authorization.workspaceId) {
    mismatches.push("session-workspace-mismatch")
  }
  if (
    session.actor._tag !== "human" ||
    session.actor.personId !== authorization.actor.personId
  ) mismatches.push("session-actor-mismatch")
  if (session.permission !== authorization.sessionPermission) mismatches.push("session-permission-mismatch")
  if (session.revokedAt !== null) mismatches.push("session-revoked")
  if (DateTime.Order(session.createdAt, authorization.authorizedAt) > 0) {
    mismatches.push("authorization-session-chronology")
  }
  if (
    DateTime.Order(evaluatedAt, session.idleExpiresAt) >= 0 ||
    DateTime.Order(evaluatedAt, session.absoluteExpiresAt) >= 0
  ) mismatches.push("authorization-session-expired")
  return mismatches
}

const semanticVersionsMatch = (
  left: { readonly major: number; readonly minor: number; readonly patch: number },
  right: { readonly major: number; readonly minor: number; readonly patch: number }
): boolean => left.major === right.major && left.minor === right.minor && left.patch === right.patch

const currentPluginMismatches = (
  input: VerifyGovernedActionDispatchAuthorityInput
): ReadonlyArray<AuthorityMismatch> => {
  const mismatches: Array<AuthorityMismatch> = []
  const { currentPlugin, envelope } = input
  const descriptor = currentPlugin.negotiated.descriptor
  if (currentPlugin.connectionId !== envelope.pluginConnectionId) {
    mismatches.push("current-plugin-connection-mismatch")
  }
  if (currentPlugin.workspaceId !== envelope.workspaceId) {
    mismatches.push("current-plugin-workspace-mismatch")
  }
  if (currentPlugin.providerId !== envelope.providerId) {
    mismatches.push("current-plugin-provider-mismatch")
  }
  if (currentPlugin.revision !== envelope.pluginConnectionRevision) {
    mismatches.push("current-plugin-revision-mismatch")
  }
  if (currentPlugin.authorityDigest !== envelope.pluginConnectionAuthorityDigest) {
    mismatches.push("current-plugin-authority-mismatch")
  }
  if (!currentPlugin.enabled) mismatches.push("current-plugin-unavailable")
  if (
    descriptor.pluginId !== envelope.pluginId ||
    !semanticVersionsMatch(descriptor.contractVersion, envelope.pluginContractVersion) ||
    !semanticVersionsMatch(descriptor.adapterVersion, envelope.pluginAdapterVersion)
  ) mismatches.push("current-plugin-mismatch")
  const executeCapability = currentPlugin.negotiated.capabilities.find(
    ({ capabilityId }) => capabilityId === "action.execute"
  )
  const executeOffer = descriptor.capabilities.find(({ capabilityId }) => capabilityId === "action.execute")
  if (executeCapability === undefined || executeOffer === undefined) {
    mismatches.push("current-capability-unavailable")
  } else if (
    executeCapability.version !== envelope.capability.version ||
    !executeOffer.supportedVersions.includes(executeCapability.version)
  ) {
    mismatches.push("current-capability-version-mismatch")
  }
  return mismatches
}

const currentTargetMismatches = (
  input: VerifyGovernedActionDispatchAuthorityInput
): ReadonlyArray<AuthorityMismatch> => {
  const mismatches: Array<AuthorityMismatch> = []
  const { currentTarget, envelope } = input
  if (currentTarget.workspaceId !== envelope.workspaceId) mismatches.push("current-target-workspace-mismatch")
  if (currentTarget.entityId !== envelope.targetEntityId) mismatches.push("current-target-entity-mismatch")
  if (currentTarget.entityType !== envelope.proposal.request.target.entityType) {
    mismatches.push("current-target-type-mismatch")
  }
  if (
    currentTarget.sourceRevision.providerId !== envelope.providerId ||
    currentTarget.sourceRevision.pluginConnectionId !== envelope.pluginConnectionId ||
    currentTarget.sourceRevision.vendorImmutableId !== envelope.proposal.request.target.vendorImmutableId
  ) mismatches.push("current-target-source-mismatch")
  if (currentTarget.sourceRevision.revision !== envelope.proposal.request.expectedRevision) {
    mismatches.push("current-target-revision-mismatch")
  }
  return mismatches
}

const currentPolicyMismatches = (
  input: VerifyGovernedActionDispatchAuthorityInput
): ReadonlyArray<AuthorityMismatch> => {
  const mismatches: Array<AuthorityMismatch> = []
  const { currentPolicy, envelope, evaluatedAt } = input
  if (currentPolicy.decision !== "allowed") mismatches.push("current-policy-denied")
  if (
    currentPolicy.actionId !== envelope.actionId ||
    currentPolicy.workspaceId !== envelope.workspaceId ||
    currentPolicy.policy.policyId !== envelope.policy.policyId ||
    currentPolicy.policy.policyVersion !== envelope.policy.policyVersion ||
    currentPolicy.policy.policyDigest !== envelope.policy.policyDigest ||
    currentPolicy.policy.requiredPermission !== envelope.policy.requiredPermission ||
    currentPolicy.payloadDigest !== envelope.proposal.payloadDigest ||
    currentPolicy.evidenceSetDigest !== envelope.evidenceSetDigest ||
    currentPolicy.expectedRevision !== envelope.proposal.request.expectedRevision ||
    DateTime.Order(currentPolicy.evaluatedAt, evaluatedAt) !== 0
  ) mismatches.push("current-policy-mismatch")
  return mismatches
}

/**
 * Recompute cryptographic bindings, current evidence, session authority, and aggregate identity.
 * Provider dispatch accepts only the nominal proof returned by this function.
 */
export const verifyGovernedActionDispatchAuthority = Effect.fn(
  "GovernedActionAuthority.verifyDispatch"
)(function*(input: VerifyGovernedActionDispatchAuthorityInput) {
  const verifiedEnvelope = yield* verifyGovernedActionEnvelope(input.envelope)
  const currentEvidenceDigest = yield* digestGovernedActionEvidenceSet(input.currentEvidence)
  const currentPolicyDigest = yield* digestGovernedActionPolicyEvaluation(input.currentPolicy)
  const mismatches = [
    ...governedActionAuthorityMismatches(input),
    ...currentSessionMismatches(input),
    ...currentPluginMismatches(input),
    ...currentPolicyMismatches(input),
    ...currentTargetMismatches(input)
  ]
  if (currentPolicyDigest !== input.attempt.policyEvaluationDigest) {
    mismatches.push("attempt-policy-evaluation-mismatch")
  }
  if (currentEvidenceDigest !== input.envelope.evidenceSetDigest) mismatches.push("evidence-set-changed")
  if (input.currentEvidence.some(({ workspaceId }) => workspaceId !== input.envelope.workspaceId)) {
    mismatches.push("evidence-workspace-mismatch")
  }
  const uniqueMismatches = Array.from(new Set(mismatches))
  if (uniqueMismatches.length > 0) {
    return yield* new GovernedActionAuthorityRejected({ mismatches: uniqueMismatches })
  }
  return new VerifiedDispatchAuthority(verifiedEnvelope, input.authorization, input.attempt)
})
