import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"

import type { Role } from "../actors.js"
import { UtcTimestamp } from "../utcTimestamp.js"
import { GovernedActionAttemptV1, GovernedActionAuthorizationV1, GovernedActionEnvelopeV1 } from "./model.js"

/** Closed reasons why durable authorization or dispatch intent does not match its action. */
export const GovernedActionAuthorityMismatch = Schema.Literals([
  "authorization-action-mismatch",
  "authorization-workspace-mismatch",
  "authorization-connection-mismatch",
  "authorization-connection-revision-mismatch",
  "authorization-connection-authority-mismatch",
  "authorization-envelope-mismatch",
  "authorization-idempotency-mismatch",
  "authorization-payload-mismatch",
  "authorization-evidence-mismatch",
  "authorization-policy-mismatch",
  "authorization-revision-mismatch",
  "authorization-capability-mismatch",
  "authorization-permission-mismatch",
  "authorization-outside-proposal-window",
  "authorization-expired",
  "authorization-session-expired",
  "evidence-not-current",
  "evidence-set-changed",
  "evidence-workspace-mismatch",
  "session-id-mismatch",
  "session-actor-mismatch",
  "session-workspace-mismatch",
  "session-permission-mismatch",
  "session-revoked",
  "authorization-session-chronology",
  "current-plugin-connection-mismatch",
  "current-plugin-workspace-mismatch",
  "current-plugin-provider-mismatch",
  "current-plugin-revision-mismatch",
  "current-plugin-authority-mismatch",
  "current-plugin-unavailable",
  "current-plugin-mismatch",
  "current-capability-unavailable",
  "current-capability-version-mismatch",
  "current-policy-denied",
  "current-policy-mismatch",
  "current-target-workspace-mismatch",
  "current-target-entity-mismatch",
  "current-target-type-mismatch",
  "current-target-source-mismatch",
  "current-target-revision-mismatch",
  "attempt-action-mismatch",
  "attempt-authorization-mismatch",
  "attempt-workspace-mismatch",
  "attempt-connection-mismatch",
  "attempt-envelope-mismatch",
  "attempt-idempotency-mismatch",
  "attempt-policy-evaluation-mismatch",
  "attempt-revision-mismatch",
  "attempt-outside-authorization-window"
])

/** Decoded governed-action authority mismatch. */
export type GovernedActionAuthorityMismatch = typeof GovernedActionAuthorityMismatch.Type

/** Complete aggregate authority checked immediately before durable dispatch intent. */
export const GovernedActionAuthorityBindingInput = Schema.Struct({
  envelope: GovernedActionEnvelopeV1,
  authorization: GovernedActionAuthorizationV1,
  attempt: GovernedActionAttemptV1,
  evaluatedAt: UtcTimestamp
})

/** Decoded aggregate authority inputs checked immediately before dispatch. */
export type GovernedActionAuthorityBindingInput = typeof GovernedActionAuthorityBindingInput.Type

/** Explicit V1 permission implication: workspace owner or an exact scoped role. */
export const governedActionPermissionGrants = (sessionPermission: Role, requiredPermission: Role): boolean =>
  sessionPermission === "workspace-owner" || sessionPermission === requiredPermission

/** Return every fail-closed mismatch between an envelope, human grant, and dispatch intent. */
export const governedActionAuthorityMismatches = ({
  attempt,
  authorization,
  envelope,
  evaluatedAt
}: GovernedActionAuthorityBindingInput): ReadonlyArray<GovernedActionAuthorityMismatch> => {
  const mismatches: Array<GovernedActionAuthorityMismatch> = []
  const addMismatch = (condition: boolean, mismatch: GovernedActionAuthorityMismatch): void => {
    if (condition) mismatches.push(mismatch)
  }

  addMismatch(authorization.actionId !== envelope.actionId, "authorization-action-mismatch")
  addMismatch(authorization.workspaceId !== envelope.workspaceId, "authorization-workspace-mismatch")
  addMismatch(
    authorization.pluginConnectionId !== envelope.pluginConnectionId,
    "authorization-connection-mismatch"
  )
  addMismatch(
    authorization.pluginConnectionRevision !== envelope.pluginConnectionRevision,
    "authorization-connection-revision-mismatch"
  )
  addMismatch(
    authorization.pluginConnectionAuthorityDigest !== envelope.pluginConnectionAuthorityDigest,
    "authorization-connection-authority-mismatch"
  )
  addMismatch(
    authorization.actionEnvelopeDigest !== envelope.envelopeDigest,
    "authorization-envelope-mismatch"
  )
  addMismatch(authorization.idempotencyKey !== envelope.idempotencyKey, "authorization-idempotency-mismatch")
  addMismatch(
    authorization.payloadDigest !== envelope.proposal.payloadDigest,
    "authorization-payload-mismatch"
  )
  addMismatch(
    authorization.evidenceSetDigest !== envelope.evidenceSetDigest,
    "authorization-evidence-mismatch"
  )
  addMismatch(authorization.policyDigest !== envelope.policy.policyDigest, "authorization-policy-mismatch")
  addMismatch(
    authorization.expectedRevision !== envelope.proposal.request.expectedRevision,
    "authorization-revision-mismatch"
  )
  addMismatch(
    authorization.capabilityVersion !== envelope.capability.version,
    "authorization-capability-mismatch"
  )
  addMismatch(
    authorization.requiredPermission !== envelope.policy.requiredPermission,
    "authorization-permission-mismatch"
  )
  addMismatch(
    !governedActionPermissionGrants(authorization.sessionPermission, authorization.requiredPermission),
    "authorization-permission-mismatch"
  )
  addMismatch(
    DateTime.Order(authorization.authorizedAt, envelope.proposal.proposedAt) < 0 ||
      DateTime.Order(authorization.authorizedAt, envelope.proposalExpiresAt) >= 0 ||
      DateTime.Order(authorization.expiresAt, envelope.proposalExpiresAt) > 0,
    "authorization-outside-proposal-window"
  )
  addMismatch(
    DateTime.Order(evaluatedAt, authorization.expiresAt) >= 0 ||
      DateTime.Order(evaluatedAt, envelope.proposalExpiresAt) >= 0,
    "authorization-expired"
  )
  addMismatch(
    DateTime.Order(evaluatedAt, authorization.sessionExpiresAt) >= 0,
    "authorization-session-expired"
  )
  addMismatch(
    envelope.evidence.some(({ currentUntil, source, validUntil }) =>
      source !== "current" ||
      (currentUntil !== null && DateTime.Order(evaluatedAt, currentUntil) >= 0) ||
      (validUntil !== null && DateTime.Order(evaluatedAt, validUntil) >= 0)
    ),
    "evidence-not-current"
  )

  addMismatch(attempt.actionId !== envelope.actionId, "attempt-action-mismatch")
  addMismatch(attempt.authorizationId !== authorization.authorizationId, "attempt-authorization-mismatch")
  addMismatch(attempt.workspaceId !== envelope.workspaceId, "attempt-workspace-mismatch")
  addMismatch(attempt.pluginConnectionId !== envelope.pluginConnectionId, "attempt-connection-mismatch")
  addMismatch(attempt.actionEnvelopeDigest !== envelope.envelopeDigest, "attempt-envelope-mismatch")
  addMismatch(attempt.idempotencyKey !== envelope.idempotencyKey, "attempt-idempotency-mismatch")
  addMismatch(attempt.expectedRevision !== envelope.proposal.request.expectedRevision, "attempt-revision-mismatch")
  addMismatch(
    DateTime.Order(attempt.preflight.checkedAt, authorization.authorizedAt) < 0 ||
      DateTime.Order(attempt.startedAt, authorization.authorizedAt) < 0 ||
      DateTime.Order(attempt.startedAt, authorization.expiresAt) >= 0 ||
      DateTime.Order(attempt.startedAt, envelope.proposalExpiresAt) >= 0 ||
      DateTime.Order(attempt.startedAt, evaluatedAt) > 0,
    "attempt-outside-authorization-window"
  )

  return mismatches
}
