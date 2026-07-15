import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  GovernedActionAuthorizationV1,
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEnvelopeV1,
  GovernedActionEvidenceReference,
  GovernedActionTransitionCause
} from "../../../src/domain/governedAction/index.js"
import { PluginPayloadJson } from "../../../src/domain/plugins/bounds.js"
import {
  digestGovernedActionEvidenceSet,
  digestGovernedActionPayload,
  makeGovernedActionEnvelope
} from "../../../src/server/governance/governedActionDigests.js"
import { makeBuiltInGovernedActionPolicyDefinition } from "../../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { Database } from "../../../src/server/persistence/Database.js"
import { GovernedActionCommitInput } from "../../../src/server/persistence/repositories/governed-action/contract.js"
import { GovernedActionRepository } from "../../../src/server/persistence/repositories/governedActionRepository.js"

export const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-440000000001"
export const CONNECTION_ID = "01890f6f-6d6a-7cc0-98d2-440000000002"
export const ENTITY_ID = "01890f6f-6d6a-7cc0-98d2-440000000003"
export const SESSION_ID = "01890f6f-6d6a-7cc0-98d2-440000000004"
export const PERSON_ID = "01890f6f-6d6a-7cc0-98d2-440000000005"
export const ACTION_ID = "01890f6f-6d6a-7cc0-98d2-440000000006"
export const AUTHORIZATION_ID = "01890f6f-6d6a-7cc0-98d2-440000000007"
export const PROPOSAL_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-440000000008"
export const AUTHORIZATION_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-440000000009"
const PROPOSAL_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-44000000000a"
const AUTHORIZATION_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-44000000000b"
const EVIDENCE_ID = "01890f6f-6d6a-7cc0-98d2-44000000000c"
const EVIDENCE_CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-44000000000d"
export const PROPOSED_AT = "2026-07-15T10:00:00.000Z"
export const AUTHORIZED_AT = "2026-07-15T10:01:00.000Z"

const decodePayload = Schema.decodeUnknownSync(PluginPayloadJson)
const decodeEnvelopeMaterial = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)
const decodeEvidence = Schema.decodeUnknownSync(GovernedActionEvidenceReference)
const decodeCommit = Schema.decodeUnknownSync(GovernedActionCommitInput)
const decodeCause = Schema.decodeUnknownSync(GovernedActionTransitionCause)
const decodeAuthorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)

const humanCause = decodeCause({
  _tag: "human",
  actor: { _tag: "human", personId: PERSON_ID },
  sessionId: SESSION_ID
})

const seedAuthorityRoots = Effect.fn("AuthorizedGovernedActionFixture.seedRoots")(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES (${WORKSPACE_ID}, 'Governance', 1, '2026-07-15T09:00:00.000Z', ${PROPOSED_AT})`
  yield* sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${CONNECTION_ID}, 'jira', 'Payments Jira',
    1, 1, '2026-07-15T09:00:00.000Z', ${PROPOSED_AT}
  )`
  yield* sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
    entity_type, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE_ID}, ${ENTITY_ID}, ${CONNECTION_ID}, 'jira', 'PAY-42',
    'issue', 1, '2026-07-15T09:00:00.000Z', ${PROPOSED_AT}
  )`
  yield* sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
    permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
  ) VALUES (
    ${WORKSPACE_ID}, ${SESSION_ID}, ${"1".repeat(64)}, ${"2".repeat(64)},
    'human', ${PERSON_ID}, NULL, 'workspace-owner', '2026-07-15T09:00:00.000Z',
    '2026-07-15T09:30:00.000Z', '2026-07-15T11:00:00.000Z',
    '2026-08-15T10:00:00.000Z', NULL
  )`
})

export const makeAuthorizedGovernedActionEnvelope = Effect.fn(
  "AuthorizedGovernedActionFixture.makeEnvelope"
)(function*() {
  const payload = decodePayload({ fields: { resolution: null, status: "Done" }, notify: true })
  const payloadDigest = yield* digestGovernedActionPayload(payload)
  const evidence = decodeEvidence({
    workspaceId: WORKSPACE_ID,
    evidenceId: EVIDENCE_ID,
    evidenceClaimIds: [EVIDENCE_CLAIM_ID],
    observedAt: "2026-07-15T09:50:00.000Z",
    validUntil: "2026-07-15T11:00:00.000Z",
    currentUntil: "2026-07-15T10:30:00.000Z",
    evaluatedAt: PROPOSED_AT,
    source: "current",
    validity: "valid"
  })
  const evidenceSetDigest = yield* digestGovernedActionEvidenceSet([evidence])
  const policy = (yield* makeBuiltInGovernedActionPolicyDefinition()).binding
  const material = decodeEnvelopeMaterial({
    schemaVersion: 1,
    actionId: ACTION_ID,
    idempotencyKey: "governed-action:PAY-42:done:1",
    workspaceId: WORKSPACE_ID,
    pluginConnectionId: CONNECTION_ID,
    pluginConnectionRevision: 1,
    pluginConnectionAuthorityDigest: `sha256:${"a".repeat(64)}`,
    pluginId: "dev.knpkv.jira",
    pluginContractVersion: { major: 1, minor: 0, patch: 0 },
    pluginAdapterVersion: { major: 1, minor: 2, patch: 3 },
    providerId: "jira",
    capability: { capabilityId: "action.execute", version: 1 },
    targetEntityId: ENTITY_ID,
    proposal: {
      proposalKey: "transition:PAY-42:done",
      capabilityVersion: 1,
      request: {
        actionKind: "transition",
        target: { entityType: "issue", vendorImmutableId: "PAY-42" },
        expectedRevision: "1",
        payload,
        evidenceIds: ["provider-evidence-1"]
      },
      payloadDigest,
      summary: "Move PAY-42 to Done",
      impact: { level: "medium", summary: "Changes the issue workflow state" },
      proposedAt: PROPOSED_AT
    },
    evidence: [Schema.encodeSync(GovernedActionEvidenceReference)(evidence)],
    evidenceSetDigest,
    policy,
    origin: {
      _tag: "human",
      actor: { _tag: "human", personId: PERSON_ID },
      sessionId: SESSION_ID
    },
    proposalExpiresAt: "2026-07-15T10:10:00.000Z",
    causationId: null,
    correlationId: "action:PAY-42:done"
  })
  return (yield* makeGovernedActionEnvelope(material)).envelope
})

/** Seed a verified proposed action and optionally commit its exact human authorization. */
export const seedGovernedAction = Effect.fn("AuthorizedGovernedActionFixture.seed")(function*(options?: {
  readonly authorizationExpiresAt?: string
  readonly authorized?: boolean
}) {
  yield* seedAuthorityRoots()
  const repository = yield* GovernedActionRepository
  const envelope = yield* makeAuthorizedGovernedActionEnvelope()
  const proposal = decodeCommit({
    envelope: Schema.encodeSync(GovernedActionEnvelopeV1)(envelope),
    expectedHeadTransitionId: null,
    transitionId: PROPOSAL_TRANSITION_ID,
    commandId: "command:PAY-42:propose",
    command: { _tag: "propose" },
    cause: humanCause,
    occurredAt: PROPOSED_AT,
    causationId: null,
    correlationId: "action:PAY-42:done",
    companion: { _tag: "none" },
    auditEventId: PROPOSAL_AUDIT_ID
  })
  yield* repository.commit(proposal)

  if (options?.authorized === false) return { envelope, authorization: null }

  const authorization = decodeAuthorization({
    schemaVersion: 1,
    authorizationId: AUTHORIZATION_ID,
    actionId: envelope.actionId,
    workspaceId: envelope.workspaceId,
    pluginConnectionId: envelope.pluginConnectionId,
    pluginConnectionRevision: envelope.pluginConnectionRevision,
    pluginConnectionAuthorityDigest: envelope.pluginConnectionAuthorityDigest,
    actionEnvelopeDigest: envelope.envelopeDigest,
    idempotencyKey: envelope.idempotencyKey,
    payloadDigest: envelope.proposal.payloadDigest,
    evidenceSetDigest: envelope.evidenceSetDigest,
    policyDigest: envelope.policy.policyDigest,
    expectedRevision: envelope.proposal.request.expectedRevision,
    capabilityVersion: envelope.capability.version,
    actor: { _tag: "human", personId: PERSON_ID },
    sessionId: SESSION_ID,
    sessionPermission: "workspace-owner",
    sessionExpiresAt: "2026-07-15T11:00:00.000Z",
    requiredPermission: envelope.policy.requiredPermission,
    authorizedAt: AUTHORIZED_AT,
    expiresAt: options?.authorizationExpiresAt ?? "2026-07-15T10:05:00.000Z"
  })
  yield* repository.commit(decodeCommit({
    ...Schema.encodeSync(GovernedActionCommitInput)(proposal),
    expectedHeadTransitionId: PROPOSAL_TRANSITION_ID,
    transitionId: AUTHORIZATION_TRANSITION_ID,
    commandId: "command:PAY-42:authorize",
    command: { _tag: "authorize", authorizationId: AUTHORIZATION_ID },
    cause: humanCause,
    occurredAt: AUTHORIZED_AT,
    companion: {
      _tag: "authorization",
      authorization: Schema.encodeSync(GovernedActionAuthorizationV1)(authorization)
    },
    auditEventId: AUTHORIZATION_AUDIT_ID
  }))
  return { envelope, authorization }
})
