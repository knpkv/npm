import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type { Crypto } from "effect"
import { Effect, Layer, Result, Schema } from "effect"

import {
  GovernedActionAttemptV1,
  governedActionAuthorityMismatches,
  GovernedActionAuthorizationV1,
  GovernedActionEnvelopeMaterialV1,
  GovernedActionEnvelopeV1,
  type GovernedActionEnvelopeV1 as GovernedActionEnvelope,
  GovernedActionEvidenceReference,
  GovernedActionPolicyEvaluationV1,
  GovernedActionTransitionCause,
  GovernedActionTransitionCommand
} from "../../src/domain/governedAction/index.js"
import { PluginPayloadJson } from "../../src/domain/plugins/bounds.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import {
  digestGovernedActionAuthorization,
  digestGovernedActionEvidenceSet,
  digestGovernedActionPayload,
  digestGovernedActionPolicyEvaluation,
  makeGovernedActionEnvelope
} from "../../src/server/governance/governedActionDigests.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistedRecordError } from "../../src/server/persistence/errors.js"
import {
  GovernedActionCommitCompanion,
  GovernedActionCommitInput,
  GovernedActionInputError
} from "../../src/server/persistence/repositories/governed-action/contract.js"
import { makeGovernedActionWrite } from "../../src/server/persistence/repositories/governed-action/write.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-330000000001"
const CONNECTION_ID = "01890f6f-6d6a-7cc0-98d2-330000000002"
const ENTITY_ID = "01890f6f-6d6a-7cc0-98d2-330000000003"
const SESSION_ID = "01890f6f-6d6a-7cc0-98d2-330000000004"
const PERSON_ID = "01890f6f-6d6a-7cc0-98d2-330000000005"
const ACTION_ID = "01890f6f-6d6a-7cc0-98d2-330000000006"
const CONFLICTING_ACTION_ID = "01890f6f-6d6a-7cc0-98d2-330000000007"
const EVIDENCE_ID = "01890f6f-6d6a-7cc0-98d2-330000000008"
const EVIDENCE_CLAIM_ID = "01890f6f-6d6a-7cc0-98d2-330000000009"
const PROPOSAL_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-33000000000a"
const DENIAL_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-33000000000b"
const PROPOSAL_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-33000000000c"
const DENIAL_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-33000000000d"
const CONFLICTING_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-33000000000e"
const CONFLICTING_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-33000000000f"
const AUTHORIZATION_ID = "01890f6f-6d6a-7cc0-98d2-330000000010"
const ATTEMPT_ID = "01890f6f-6d6a-7cc0-98d2-330000000011"
const AUTHORIZATION_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-330000000012"
const START_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-330000000013"
const AUTHORIZATION_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-330000000014"
const START_AUDIT_ID = "01890f6f-6d6a-7cc0-98d2-330000000015"
const PROPOSED_AT = "2026-07-15T10:00:00.000Z"

const decodePayload = Schema.decodeUnknownSync(PluginPayloadJson)
const decodeEnvelopeMaterial = Schema.decodeUnknownSync(GovernedActionEnvelopeMaterialV1)
const decodeEvidence = Schema.decodeUnknownSync(GovernedActionEvidenceReference)
const decodeCommit = Schema.decodeUnknownSync(GovernedActionCommitInput)
const decodeCommand = Schema.decodeUnknownSync(GovernedActionTransitionCommand)
const decodeCause = Schema.decodeUnknownSync(GovernedActionTransitionCause)
const decodeAuthorization = Schema.decodeUnknownSync(GovernedActionAuthorizationV1)
const decodePolicyEvaluation = Schema.decodeUnknownSync(GovernedActionPolicyEvaluationV1)
const decodeAttempt = Schema.decodeUnknownSync(GovernedActionAttemptV1)
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp)
const authorizationJson = Schema.fromJsonString(GovernedActionAuthorizationV1)
const policyEvaluationJson = Schema.fromJsonString(GovernedActionPolicyEvaluationV1)

const humanCause = decodeCause({
  _tag: "human",
  actor: { _tag: "human", personId: PERSON_ID },
  sessionId: SESSION_ID
})

const seedAuthorityRoots = Effect.fn("GovernedActionRepositoryTest.seedRoots")(function*() {
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

const makeEnvelope = Effect.fn("GovernedActionRepositoryTest.makeEnvelope")(function*(
  actionId: string,
  options?: {
    readonly evidenceCurrentUntil?: string
    readonly policyId?: string
    readonly proposalExpiresAt?: string
  }
) {
  const payload = decodePayload({
    fields: { resolution: null, status: "Done" },
    notify: true
  })
  const payloadDigest = yield* digestGovernedActionPayload(payload)
  const evidence = decodeEvidence({
    workspaceId: WORKSPACE_ID,
    evidenceId: EVIDENCE_ID,
    evidenceClaimIds: [EVIDENCE_CLAIM_ID],
    observedAt: "2026-07-15T09:50:00.000Z",
    validUntil: "2026-07-15T11:00:00.000Z",
    currentUntil: options?.evidenceCurrentUntil ?? "2026-07-15T10:30:00.000Z",
    evaluatedAt: PROPOSED_AT,
    source: "current",
    validity: "valid"
  })
  const materialWithoutEvidenceDigest = {
    schemaVersion: 1,
    actionId,
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
    policy: {
      policyId: options?.policyId ?? "jira.transition",
      policyVersion: 1,
      policyDigest: `sha256:${"c".repeat(64)}`,
      requiredPermission: "workspace-owner"
    },
    origin: {
      _tag: "human",
      actor: { _tag: "human", personId: PERSON_ID },
      sessionId: SESSION_ID
    },
    proposalExpiresAt: options?.proposalExpiresAt ?? "2026-07-15T10:10:00.000Z",
    causationId: null,
    correlationId: "action:PAY-42:done"
  }
  const evidenceSetDigest = yield* digestGovernedActionEvidenceSet([evidence])
  const material = decodeEnvelopeMaterial({
    ...materialWithoutEvidenceDigest,
    evidenceSetDigest
  })
  return (yield* makeGovernedActionEnvelope(material)).envelope
})

const makeProposalInput = (
  envelope: GovernedActionEnvelope,
  options?: {
    readonly auditEventId?: string
    readonly commandId?: string
    readonly transitionId?: string
  }
) =>
  decodeCommit({
    envelope: Schema.encodeSync(GovernedActionEnvelopeV1)(envelope),
    expectedHeadTransitionId: null,
    transitionId: options?.transitionId ?? PROPOSAL_TRANSITION_ID,
    commandId: options?.commandId ?? "command:PAY-42:propose",
    command: { _tag: "propose" },
    cause: humanCause,
    occurredAt: PROPOSED_AT,
    causationId: null,
    correlationId: "action:PAY-42:done",
    companion: { _tag: "none" },
    auditEventId: options?.auditEventId ?? PROPOSAL_AUDIT_ID
  })

const makeDenialInput = (
  proposal: ReturnType<typeof makeProposalInput>,
  command: typeof GovernedActionTransitionCommand.Type = decodeCommand({
    _tag: "deny",
    reason: "policy-denied",
    safeSummary: "Policy denied the action"
  }),
  cause: typeof GovernedActionTransitionCause.Type = humanCause,
  companion: GovernedActionCommitCompanion = { _tag: "none" }
) =>
  decodeCommit({
    ...Schema.encodeSync(GovernedActionCommitInput)(proposal),
    expectedHeadTransitionId: PROPOSAL_TRANSITION_ID,
    transitionId: DENIAL_TRANSITION_ID,
    commandId: "command:PAY-42:deny",
    command,
    cause,
    companion: Schema.encodeSync(GovernedActionCommitCompanion)(companion),
    occurredAt: "2026-07-15T10:01:00.000Z",
    auditEventId: DENIAL_AUDIT_ID
  })

const makeAuthorization = (envelope: GovernedActionEnvelope) =>
  decodeAuthorization({
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
    authorizedAt: "2026-07-15T10:01:00.000Z",
    expiresAt: "2026-07-15T10:05:00.000Z"
  })

const makeDispatchCompanion = Effect.fn("GovernedActionRepositoryTest.makeDispatchCompanion")(function*(
  envelope: GovernedActionEnvelope
) {
  const policyEvaluation = decodePolicyEvaluation({
    schemaVersion: 1,
    actionId: envelope.actionId,
    workspaceId: envelope.workspaceId,
    policy: Schema.encodeSync(GovernedActionPolicyEvaluationV1.fields.policy)(envelope.policy),
    payloadDigest: envelope.proposal.payloadDigest,
    evidenceSetDigest: envelope.evidenceSetDigest,
    expectedRevision: envelope.proposal.request.expectedRevision,
    decision: "allowed",
    evaluatedAt: "2026-07-15T10:02:00.000Z"
  })
  const attempt = decodeAttempt({
    schemaVersion: 1,
    attemptId: ATTEMPT_ID,
    authorizationId: AUTHORIZATION_ID,
    actionId: envelope.actionId,
    workspaceId: envelope.workspaceId,
    pluginConnectionId: envelope.pluginConnectionId,
    idempotencyKey: envelope.idempotencyKey,
    attemptNumber: 1,
    actionEnvelopeDigest: envelope.envelopeDigest,
    expectedRevision: envelope.proposal.request.expectedRevision,
    policyEvaluationDigest: yield* digestGovernedActionPolicyEvaluation(policyEvaluation),
    preflight: {
      _tag: "ready",
      checkedRevision: envelope.proposal.request.expectedRevision,
      checkedAt: "2026-07-15T10:01:45.000Z"
    },
    startedAt: "2026-07-15T10:02:00.000Z"
  })
  return { attempt, policyEvaluation }
})

const makeAuthorizationInput = (
  proposal: ReturnType<typeof makeProposalInput>,
  authorization: typeof GovernedActionAuthorizationV1.Type
) =>
  decodeCommit({
    ...Schema.encodeSync(GovernedActionCommitInput)(proposal),
    expectedHeadTransitionId: PROPOSAL_TRANSITION_ID,
    transitionId: AUTHORIZATION_TRANSITION_ID,
    commandId: "command:PAY-42:authorize",
    command: { _tag: "authorize", authorizationId: AUTHORIZATION_ID },
    cause: humanCause,
    occurredAt: "2026-07-15T10:01:00.000Z",
    companion: {
      _tag: "authorization",
      authorization: Schema.encodeSync(GovernedActionAuthorizationV1)(authorization)
    },
    auditEventId: AUTHORIZATION_AUDIT_ID
  })

const makeStartInput = (
  authorizationInput: ReturnType<typeof makeAuthorizationInput>,
  companion: {
    readonly attempt: typeof GovernedActionAttemptV1.Type
    readonly policyEvaluation: typeof GovernedActionPolicyEvaluationV1.Type
  }
) =>
  decodeCommit({
    ...Schema.encodeSync(GovernedActionCommitInput)(authorizationInput),
    expectedHeadTransitionId: AUTHORIZATION_TRANSITION_ID,
    transitionId: START_TRANSITION_ID,
    commandId: "command:PAY-42:start",
    command: { _tag: "start", attemptId: ATTEMPT_ID },
    cause: { _tag: "system", component: "governed-action-engine" },
    occurredAt: "2026-07-15T10:02:00.000Z",
    companion: {
      _tag: "dispatch",
      attempt: Schema.encodeSync(GovernedActionAttemptV1)(companion.attempt),
      policyEvaluation: Schema.encodeSync(GovernedActionPolicyEvaluationV1)(companion.policyEvaluation)
    },
    auditEventId: START_AUDIT_ID
  })

interface LedgerCounts {
  readonly actions: number
  readonly audits: number
  readonly transitions: number
}

interface CompanionCounts {
  readonly attempts: number
  readonly authorizations: number
  readonly evaluations: number
}

const readLedgerCounts = Effect.fn("GovernedActionRepositoryTest.readCounts")(function*() {
  const { sql } = yield* Database
  const rows = yield* sql<LedgerCounts>`SELECT
    (SELECT COUNT(*) FROM governed_actions) AS actions,
    (SELECT COUNT(*) FROM governed_action_transitions) AS transitions,
    (SELECT COUNT(*) FROM audit_events) AS audits`
  return rows[0]
})

const readCompanionCounts = Effect.fn("GovernedActionRepositoryTest.readCompanionCounts")(function*() {
  const { sql } = yield* Database
  const rows = yield* sql<CompanionCounts>`SELECT
    (SELECT COUNT(*) FROM governed_action_authorizations) AS authorizations,
    (SELECT COUNT(*) FROM governed_action_policy_evaluations) AS evaluations,
    (SELECT COUNT(*) FROM governed_action_attempts) AS attempts`
  return rows[0]
})

const withWriter = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Database>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-governed-action-writer-")
    return yield* use.pipe(Effect.provide(databaseLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const withRepository = <Success, Failure>(
  use: Effect.Effect<
    Success,
    Failure,
    Crypto.Crypto | Database | GovernedActionRepository | QuarantineRepository
  >
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-governed-action-repository-")
    const database = databaseLayer(config)
    const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
    const repository = GovernedActionRepository.layer.pipe(Layer.provideMerge(foundation))
    return yield* use.pipe(Effect.provide(repository))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const assertInputError = (result: Result.Result<unknown, unknown>, reason: GovernedActionInputError["reason"]) => {
  assert.isTrue(Result.isFailure(result))
  if (Result.isFailure(result)) {
    assert.isTrue(Schema.is(GovernedActionInputError)(result.failure))
    if (Schema.is(GovernedActionInputError)(result.failure)) {
      assert.strictEqual(result.failure.reason, reason)
    }
  }
}

describe("governed action writer", () => {
  it.effect("commits a proposal once and replays the exact command without duplicate ledger rows", () =>
    withWriter(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const writer = yield* makeGovernedActionWrite
      const proposal = makeProposalInput(yield* makeEnvelope(ACTION_ID))

      const committed = yield* writer.commit(proposal)
      const replayed = yield* writer.commit(proposal)

      assert.strictEqual(committed._tag, "committed")
      assert.strictEqual(replayed._tag, "replayed")
      assert.deepStrictEqual(replayed.transition, committed.transition)
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 1,
        transitions: 1
      })
    })))

  it.effect("rejects a changed envelope under the same semantic idempotency identity", () =>
    withWriter(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const writer = yield* makeGovernedActionWrite
      yield* writer.commit(makeProposalInput(yield* makeEnvelope(ACTION_ID)))
      const conflicting = makeProposalInput(yield* makeEnvelope(CONFLICTING_ACTION_ID), {
        auditEventId: CONFLICTING_AUDIT_ID,
        commandId: "command:PAY-42:conflicting-proposal",
        transitionId: CONFLICTING_TRANSITION_ID
      })

      assertInputError(
        yield* Effect.result(writer.commit(conflicting)),
        "conflicting-action-identity"
      )
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 1,
        transitions: 1
      })
    })))

  it.effect("rejects changed command or cause content under one committed command identity", () =>
    withWriter(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const writer = yield* makeGovernedActionWrite
      const proposal = makeProposalInput(yield* makeEnvelope(ACTION_ID))
      yield* writer.commit(proposal)
      const denial = makeDenialInput(proposal)
      yield* writer.commit(denial)

      const changedCommand = makeDenialInput(
        proposal,
        decodeCommand({ _tag: "cancel", safeSummary: "Cancel instead of deny" })
      )
      const changedCause = makeDenialInput(
        proposal,
        denial.command,
        decodeCause({ _tag: "system", component: "governed-action-engine" })
      )
      const deniedPolicy = decodePolicyEvaluation({
        schemaVersion: 1,
        actionId: proposal.envelope.actionId,
        workspaceId: proposal.envelope.workspaceId,
        policy: Schema.encodeSync(GovernedActionPolicyEvaluationV1.fields.policy)(proposal.envelope.policy),
        payloadDigest: proposal.envelope.proposal.payloadDigest,
        evidenceSetDigest: proposal.envelope.evidenceSetDigest,
        expectedRevision: proposal.envelope.proposal.request.expectedRevision,
        decision: "denied",
        evaluatedAt: "2026-07-15T10:00:30.000Z"
      })
      const changedCompanion = makeDenialInput(proposal, undefined, humanCause, {
        _tag: "policyDenial",
        policyEvaluation: deniedPolicy
      })

      assertInputError(
        yield* Effect.result(writer.commit(changedCommand)),
        "changed-command-retry"
      )
      assertInputError(
        yield* Effect.result(writer.commit(changedCause)),
        "changed-command-retry"
      )
      assertInputError(
        yield* Effect.result(writer.commit(changedCompanion)),
        "changed-command-retry"
      )
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 2,
        transitions: 2
      })
    })))

  it.effect("classifies a changed denied-policy replay as a command conflict", () =>
    withWriter(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const writer = yield* makeGovernedActionWrite
      const proposal = makeProposalInput(yield* makeEnvelope(ACTION_ID))
      yield* writer.commit(proposal)
      const deniedPolicy = decodePolicyEvaluation({
        schemaVersion: 1,
        actionId: proposal.envelope.actionId,
        workspaceId: proposal.envelope.workspaceId,
        policy: Schema.encodeSync(GovernedActionPolicyEvaluationV1.fields.policy)(proposal.envelope.policy),
        payloadDigest: proposal.envelope.proposal.payloadDigest,
        evidenceSetDigest: proposal.envelope.evidenceSetDigest,
        expectedRevision: proposal.envelope.proposal.request.expectedRevision,
        decision: "denied",
        evaluatedAt: "2026-07-15T10:00:30.000Z"
      })
      const denial = makeDenialInput(proposal, undefined, humanCause, {
        _tag: "policyDenial",
        policyEvaluation: deniedPolicy
      })
      yield* writer.commit(denial)
      assert.strictEqual((yield* writer.commit(denial))._tag, "replayed")
      assertInputError(
        yield* writer.commit(makeDenialInput(proposal)).pipe(Effect.result),
        "changed-command-retry"
      )
      const changedPolicy = decodePolicyEvaluation({
        ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(deniedPolicy),
        evaluatedAt: "2026-07-15T10:00:31.000Z"
      })

      assertInputError(
        yield* writer.commit(makeDenialInput(proposal, undefined, humanCause, {
          _tag: "policyDenial",
          policyEvaluation: changedPolicy
        })).pipe(Effect.result),
        "changed-command-retry"
      )
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 0,
        evaluations: 1
      })
    })))

  it.effect("links one denied policy evaluation to its exact deny transition", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const policyEvaluation = decodePolicyEvaluation({
        schemaVersion: 1,
        actionId: envelope.actionId,
        workspaceId: envelope.workspaceId,
        policy: Schema.encodeSync(GovernedActionPolicyEvaluationV1.fields.policy)(envelope.policy),
        payloadDigest: envelope.proposal.payloadDigest,
        evidenceSetDigest: envelope.evidenceSetDigest,
        expectedRevision: envelope.proposal.request.expectedRevision,
        decision: "denied",
        evaluatedAt: "2026-07-15T10:00:30.000Z"
      })
      const denial = makeDenialInput(proposal, undefined, humanCause, {
        _tag: "policyDenial",
        policyEvaluation
      })

      yield* repository.commit(denial)
      assert.strictEqual((yield* repository.commit(denial))._tag, "replayed")
      const record = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      })
      assert.deepStrictEqual(record.policyEvaluation, policyEvaluation)
      const { sql } = yield* Database
      const linked = yield* sql<{ readonly policyEvaluationDigest: string | null }>`SELECT
        policy_evaluation_digest AS policyEvaluationDigest
        FROM governed_action_denial_policy_evaluations
        WHERE workspace_id = ${envelope.workspaceId} AND transition_id = ${DENIAL_TRANSITION_ID}`
      assert.strictEqual(
        linked[0]?.policyEvaluationDigest,
        yield* digestGovernedActionPolicyEvaluation(policyEvaluation)
      )
    })))

  it.effect("rejects future denial evidence and prevents post-hoc ownership", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const { sql } = yield* Database
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const futureEvaluation = decodePolicyEvaluation({
        schemaVersion: 1,
        actionId: envelope.actionId,
        workspaceId: envelope.workspaceId,
        policy: Schema.encodeSync(GovernedActionPolicyEvaluationV1.fields.policy)(envelope.policy),
        payloadDigest: envelope.proposal.payloadDigest,
        evidenceSetDigest: envelope.evidenceSetDigest,
        expectedRevision: envelope.proposal.request.expectedRevision,
        decision: "denied",
        evaluatedAt: "2026-07-15T10:01:01.000Z"
      })
      const validDenial = makeDenialInput(proposal)
      assertInputError(
        yield* repository.commit({
          ...validDenial,
          companion: { _tag: "policyDenial", policyEvaluation: futureEvaluation }
        }).pipe(Effect.result),
        "invalid-request"
      )
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 1,
        transitions: 1
      })
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 0,
        evaluations: 0
      })

      yield* repository.commit(validDenial)
      const evaluationDigest = yield* digestGovernedActionPolicyEvaluation(futureEvaluation)
      const evaluationJson = Schema.encodeSync(policyEvaluationJson)(futureEvaluation)
      yield* sql`INSERT INTO governed_action_policy_evaluations (
        workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
      ) VALUES (
        ${envelope.workspaceId}, ${envelope.actionId}, ${evaluationDigest}, ${evaluationJson},
        ${futureEvaluation.decision}, '2026-07-15T10:01:01.000Z'
      )`
      const linked = yield* sql`INSERT INTO governed_action_denial_policy_evaluations (
        workspace_id, action_id, transition_id, policy_evaluation_digest
      ) VALUES (
        ${envelope.workspaceId}, ${envelope.actionId}, ${DENIAL_TRANSITION_ID}, ${evaluationDigest}
      )`.pipe(Effect.result)
      assert.isTrue(Result.isFailure(linked))
      const ownership = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_denial_policy_evaluations
        WHERE workspace_id = ${envelope.workspaceId} AND action_id = ${envelope.actionId}`
      assert.deepStrictEqual(ownership, [{ count: 0 }])

      const backdatedEvaluation = decodePolicyEvaluation({
        ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(futureEvaluation),
        evaluatedAt: "2026-07-15T10:00:30.000Z"
      })
      const backdatedDigest = yield* digestGovernedActionPolicyEvaluation(backdatedEvaluation)
      const backdatedJson = Schema.encodeSync(policyEvaluationJson)(backdatedEvaluation)
      yield* sql`INSERT INTO governed_action_policy_evaluations (
        workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
      ) VALUES (
        ${envelope.workspaceId}, ${envelope.actionId}, ${backdatedDigest}, ${backdatedJson},
        ${backdatedEvaluation.decision}, '2026-07-15T10:00:30.000Z'
      )`
      const postHocOwnership = yield* sql`INSERT INTO governed_action_denial_policy_evaluations (
        workspace_id, action_id, transition_id, policy_evaluation_digest
      ) VALUES (
        ${envelope.workspaceId}, ${envelope.actionId}, ${DENIAL_TRANSITION_ID}, ${backdatedDigest}
      )`.pipe(Effect.result)
      assert.isTrue(Result.isFailure(postHocOwnership))
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_denial_policy_evaluations
        WHERE workspace_id = ${envelope.workspaceId} AND action_id = ${envelope.actionId}`,
        [{ count: 0 }]
      )
    })))

  it.effect("quarantines post-hoc denied policy evidence on read and exact replay", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const quarantine = yield* QuarantineRepository
      const { sql } = yield* Database
      const policyCanary = "policy-never-retain-unowned-evaluation"
      const envelope = yield* makeEnvelope(ACTION_ID, { policyId: policyCanary })
      const proposal = makeProposalInput(envelope)
      const denial = makeDenialInput(proposal)
      yield* repository.commit(proposal)
      yield* repository.commit(denial)
      assert.isNull(
        (yield* repository.read({
          workspaceId: envelope.workspaceId,
          actionId: envelope.actionId
        })).policyEvaluation
      )
      assert.strictEqual((yield* repository.commit(denial))._tag, "replayed")

      const postHocEvaluation = decodePolicyEvaluation({
        schemaVersion: 1,
        actionId: envelope.actionId,
        workspaceId: envelope.workspaceId,
        policy: Schema.encodeSync(GovernedActionPolicyEvaluationV1.fields.policy)(envelope.policy),
        payloadDigest: envelope.proposal.payloadDigest,
        evidenceSetDigest: envelope.evidenceSetDigest,
        expectedRevision: envelope.proposal.request.expectedRevision,
        decision: "denied",
        evaluatedAt: "2026-07-15T10:00:30.000Z"
      })
      const digest = yield* digestGovernedActionPolicyEvaluation(postHocEvaluation)
      const json = Schema.encodeSync(policyEvaluationJson)(postHocEvaluation)
      yield* sql`INSERT INTO governed_action_policy_evaluations (
        workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
      ) VALUES (
        ${envelope.workspaceId}, ${envelope.actionId}, ${digest}, ${json}, 'denied',
        '2026-07-15T10:00:30.000Z'
      )`

      assert.isTrue(Result.isFailure(yield* repository.commit(denial).pipe(Effect.result)))
      assert.isTrue(Result.isFailure(
        yield* repository.read({
          workspaceId: envelope.workspaceId,
          actionId: envelope.actionId
        }).pipe(Effect.result)
      ))
      const quarantined = yield* quarantine.list(envelope.workspaceId)
      assert.lengthOf(quarantined, 2)
      assert.isTrue(quarantined.every(
        ({ diagnosticCode }) => diagnosticCode === "governed-action-companion-invalid"
      ))
      assert.notInclude(JSON.stringify(quarantined), policyCanary)
    })))

  it.effect("reads a committed proposal as one verified lifecycle head and history", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const envelope = yield* makeEnvelope(ACTION_ID)
      const committed = yield* repository.commit(makeProposalInput(envelope))

      const record = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      })

      assert.deepStrictEqual(record.envelope, envelope)
      assert.deepStrictEqual(record.head, {
        state: "proposed",
        lineage: { _tag: "none" }
      })
      assert.deepStrictEqual(record.headTransition, committed.transition)
      assert.deepStrictEqual(record.history, [committed.transition])
      assert.isNull(record.authorization)
      assert.isNull(record.policyEvaluation)
      assert.isNull(record.attempt)
    })))

  it.effect("commits authorization and dispatch companions atomically and replays exact start intent", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)

      const authorization = makeAuthorization(envelope)
      const authorizationInput = makeAuthorizationInput(proposal, authorization)
      yield* repository.commit(authorizationInput)

      const companion = yield* makeDispatchCompanion(envelope)
      assert.deepStrictEqual(
        governedActionAuthorityMismatches({
          envelope,
          authorization,
          attempt: companion.attempt,
          evaluatedAt: companion.attempt.startedAt
        }),
        []
      )
      const startInput = makeStartInput(authorizationInput, companion)
      const started = yield* repository.commit(startInput)
      const replayed = yield* repository.commit(startInput)
      const proposalReplayedAfterHeadAdvanced = yield* repository.commit(proposal)

      assert.strictEqual(started._tag, "committed")
      assert.strictEqual(replayed._tag, "replayed")
      assert.deepStrictEqual(replayed.transition, started.transition)
      assert.strictEqual(proposalReplayedAfterHeadAdvanced._tag, "replayed")
      assert.strictEqual(proposalReplayedAfterHeadAdvanced.transition.sequence, 1)
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 3,
        transitions: 3
      })
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 1,
        authorizations: 1,
        evaluations: 1
      })

      const record = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      })
      assert.deepStrictEqual(record.head, {
        state: "started",
        lineage: { _tag: "none" }
      })
      assert.deepStrictEqual(record.headTransition, started.transition)
      assert.deepStrictEqual(
        record.history.map(({ command }) => command._tag),
        ["propose", "authorize", "start"]
      )
      assert.deepStrictEqual(record.authorization, authorization)
      assert.deepStrictEqual(record.policyEvaluation, companion.policyEvaluation)
      assert.deepStrictEqual(record.attempt, companion.attempt)

      const changedAttempt = decodeAttempt({
        ...Schema.encodeSync(GovernedActionAttemptV1)(companion.attempt),
        preflight: {
          _tag: "ready",
          checkedRevision: envelope.proposal.request.expectedRevision,
          checkedAt: "2026-07-15T10:01:46.000Z"
        }
      })
      assertInputError(
        yield* repository.commit(makeStartInput(authorizationInput, {
          ...companion,
          attempt: changedAttempt
        })).pipe(Effect.result),
        "changed-command-retry"
      )
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 3,
        transitions: 3
      })
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 1,
        authorizations: 1,
        evaluations: 1
      })
    })))

  it.effect("quarantines invalid stored authorization before start on read and exact replay", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const quarantine = yield* QuarantineRepository
      const { sql } = yield* Database
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorization = makeAuthorization(envelope)
      const authorizationInput = makeAuthorizationInput(proposal, authorization)
      yield* repository.commit(authorizationInput)

      assert.deepStrictEqual(
        (yield* repository.read({
          workspaceId: envelope.workspaceId,
          actionId: envelope.actionId
        })).authorization,
        authorization
      )
      assert.strictEqual((yield* repository.commit(authorizationInput))._tag, "replayed")

      const insufficientAuthorization = decodeAuthorization({
        ...Schema.encodeSync(GovernedActionAuthorizationV1)(authorization),
        sessionPermission: "issue-owner"
      })
      const insufficientDigest = yield* digestGovernedActionAuthorization(insufficientAuthorization)
      const insufficientJson = Schema.encodeSync(authorizationJson)(insufficientAuthorization)
      yield* sql`DROP TRIGGER governed_action_authorizations_no_update`
      yield* sql`UPDATE governed_action_authorizations
        SET authorization_digest = ${insufficientDigest}, authorization_json = ${insufficientJson}
        WHERE workspace_id = ${envelope.workspaceId}
          AND action_id = ${envelope.actionId}
          AND authorization_id = ${AUTHORIZATION_ID}`

      const readResult = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      }).pipe(Effect.result)
      const replayResult = yield* repository.commit(authorizationInput).pipe(Effect.result)
      assert.isTrue(Result.isFailure(readResult))
      assert.isTrue(Result.isFailure(replayResult))
      if (Result.isFailure(readResult)) {
        assert.isTrue(Schema.is(PersistedRecordError)(readResult.failure))
      }
      if (Result.isFailure(replayResult)) {
        assert.isTrue(Schema.is(PersistedRecordError)(replayResult.failure))
        assert.isFalse(Schema.is(GovernedActionInputError)(replayResult.failure))
      }
      const quarantined = yield* quarantine.list(envelope.workspaceId)
      assert.lengthOf(quarantined, 2)
      assert.isTrue(quarantined.every(
        ({ diagnosticCode, recordKey, recordKind }) =>
          recordKind === "governed-action-authorization" &&
          recordKey === AUTHORIZATION_ID &&
          diagnosticCode === "governed-action-companion-invalid"
      ))

      const mistimedAuthorization = decodeAuthorization({
        ...Schema.encodeSync(GovernedActionAuthorizationV1)(authorization),
        authorizedAt: "2026-07-15T10:00:30.000Z"
      })
      const mistimedDigest = yield* digestGovernedActionAuthorization(mistimedAuthorization)
      const mistimedJson = Schema.encodeSync(authorizationJson)(mistimedAuthorization)
      yield* sql`UPDATE governed_action_authorizations
        SET authorization_digest = ${mistimedDigest}, authorization_json = ${mistimedJson},
          authorized_at = '2026-07-15T10:00:30.000Z'
        WHERE workspace_id = ${envelope.workspaceId}
          AND action_id = ${envelope.actionId}
          AND authorization_id = ${AUTHORIZATION_ID}`

      const mistimedRead = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      }).pipe(Effect.result)
      const mistimedReplay = yield* repository.commit(authorizationInput).pipe(Effect.result)
      assert.isTrue(Result.isFailure(mistimedRead))
      assert.isTrue(Result.isFailure(mistimedReplay))
      if (Result.isFailure(mistimedRead)) {
        assert.isTrue(Schema.is(PersistedRecordError)(mistimedRead.failure))
      }
      if (Result.isFailure(mistimedReplay)) {
        assert.isTrue(Schema.is(PersistedRecordError)(mistimedReplay.failure))
        assert.isFalse(Schema.is(GovernedActionInputError)(mistimedReplay.failure))
      }
      const allQuarantined = yield* quarantine.list(envelope.workspaceId)
      assert.lengthOf(allQuarantined, 4)
      assert.isTrue(allQuarantined.every(
        ({ diagnosticCode, recordKey, recordKind }) =>
          recordKind === "governed-action-authorization" &&
          recordKey === AUTHORIZATION_ID &&
          diagnosticCode === "governed-action-companion-invalid"
      ))
    })))

  it.effect("quarantines invalid stored authorization before replaying an exact dispatch", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const quarantine = yield* QuarantineRepository
      const { sql } = yield* Database
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorization = makeAuthorization(envelope)
      const authorizationInput = makeAuthorizationInput(proposal, authorization)
      yield* repository.commit(authorizationInput)
      const companion = yield* makeDispatchCompanion(envelope)
      const startInput = makeStartInput(authorizationInput, companion)
      yield* repository.commit(startInput)

      const expiredAuthorization = decodeAuthorization({
        ...Schema.encodeSync(GovernedActionAuthorizationV1)(authorization),
        expiresAt: "2026-07-15T10:01:30.000Z"
      })
      const expiredDigest = yield* digestGovernedActionAuthorization(expiredAuthorization)
      const expiredJson = Schema.encodeSync(authorizationJson)(expiredAuthorization)
      yield* sql`DROP TRIGGER governed_action_authorizations_no_update`
      yield* sql`UPDATE governed_action_authorizations
        SET authorization_digest = ${expiredDigest}, authorization_json = ${expiredJson},
          expires_at = '2026-07-15T10:01:30.000Z'
        WHERE workspace_id = ${envelope.workspaceId}
          AND action_id = ${envelope.actionId}
          AND authorization_id = ${AUTHORIZATION_ID}`

      const replayed = yield* repository.commit(startInput).pipe(Effect.result)
      assert.isTrue(Result.isFailure(replayed))
      if (Result.isFailure(replayed)) {
        assert.isTrue(Schema.is(PersistedRecordError)(replayed.failure))
      }
      const quarantined = yield* quarantine.list(envelope.workspaceId)
      assert.lengthOf(quarantined, 1)
      assert.deepInclude(quarantined[0], {
        recordKind: "governed-action-authorization",
        recordKey: AUTHORIZATION_ID,
        diagnosticCode: "governed-action-companion-invalid",
        diagnosticSummary: "Stored governed action authority companion is invalid.",
        occurrenceCount: 1
      })
    })))

  it.effect("quarantines a missing stored authorization before replaying an exact dispatch", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const quarantine = yield* QuarantineRepository
      const { sql } = yield* Database
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorizationInput = makeAuthorizationInput(proposal, makeAuthorization(envelope))
      yield* repository.commit(authorizationInput)
      const startInput = makeStartInput(authorizationInput, yield* makeDispatchCompanion(envelope))
      yield* repository.commit(startInput)

      yield* sql`DROP TRIGGER governed_action_authorizations_no_delete`
      yield* sql`PRAGMA foreign_keys = OFF`
      yield* sql`DELETE FROM governed_action_authorizations
        WHERE workspace_id = ${envelope.workspaceId}
          AND action_id = ${envelope.actionId}
          AND authorization_id = ${AUTHORIZATION_ID}`
      yield* sql`PRAGMA foreign_keys = ON`

      const replayed = yield* repository.commit(startInput).pipe(Effect.result)
      assert.isTrue(Result.isFailure(replayed))
      if (Result.isFailure(replayed)) {
        assert.isTrue(Schema.is(PersistedRecordError)(replayed.failure))
        assert.isFalse(Schema.is(GovernedActionInputError)(replayed.failure))
      }
      const quarantined = yield* quarantine.list(envelope.workspaceId)
      assert.lengthOf(quarantined, 1)
      assert.deepInclude(quarantined[0], {
        recordKind: "governed-action-authorization",
        recordKey: AUTHORIZATION_ID,
        diagnosticCode: "governed-action-companion-invalid",
        diagnosticSummary: "Stored governed action authority companion is invalid.",
        occurrenceCount: 1
      })
    })))

  it.effect("rolls back authority and transition rows when the paired audit cannot commit", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorizationInput = makeAuthorizationInput(proposal, makeAuthorization(envelope))
      const collidingAudit = decodeCommit({
        ...Schema.encodeSync(GovernedActionCommitInput)(authorizationInput),
        auditEventId: PROPOSAL_AUDIT_ID
      })

      assert.isTrue(Result.isFailure(yield* repository.commit(collidingAudit).pipe(Effect.result)))
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 1,
        transitions: 1
      })
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 0,
        evaluations: 0
      })
      const record = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      })
      assert.strictEqual(record.head.state, "proposed")
    })))

  it.effect("rejects mismatched authorization and dispatch authority before durable writes", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorization = makeAuthorization(envelope)
      const validAuthorizationInput = makeAuthorizationInput(proposal, authorization)
      const invalidAuthorizationInputs = [
        {
          ...validAuthorizationInput,
          companion: {
            _tag: "authorization",
            authorization: { ...authorization, pluginConnectionRevision: 2 }
          }
        },
        {
          ...validAuthorizationInput,
          companion: {
            _tag: "authorization",
            authorization: { ...authorization, sessionPermission: "issue-owner" }
          }
        },
        {
          ...validAuthorizationInput,
          companion: {
            _tag: "authorization",
            authorization: {
              ...authorization,
              actor: { _tag: "human", personId: CONFLICTING_ACTION_ID }
            }
          }
        }
      ]
      for (const invalidAuthorizationInput of invalidAuthorizationInputs) {
        assertInputError(
          yield* repository.commit(invalidAuthorizationInput).pipe(Effect.result),
          "invalid-request"
        )
      }
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 0,
        evaluations: 0
      })

      const { sql } = yield* Database
      yield* sql`UPDATE sessions SET permission = 'issue-owner'
        WHERE workspace_id = ${envelope.workspaceId} AND session_id = ${SESSION_ID}`
      assertInputError(
        yield* repository.commit(validAuthorizationInput).pipe(Effect.result),
        "illegal-transition"
      )
      yield* sql`UPDATE sessions SET permission = 'workspace-owner'
        WHERE workspace_id = ${envelope.workspaceId} AND session_id = ${SESSION_ID}`
      yield* repository.commit(validAuthorizationInput)
      const companion = yield* makeDispatchCompanion(envelope)
      const changedPolicy = decodePolicyEvaluation({
        ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(companion.policyEvaluation),
        policy: {
          ...Schema.encodeSync(GovernedActionPolicyEvaluationV1.fields.policy)(companion.policyEvaluation.policy),
          policyDigest: `sha256:${"f".repeat(64)}`
        }
      })
      const changedAttempt = decodeAttempt({
        ...Schema.encodeSync(GovernedActionAttemptV1)(companion.attempt),
        policyEvaluationDigest: yield* digestGovernedActionPolicyEvaluation(changedPolicy)
      })
      const validStartInput = makeStartInput(validAuthorizationInput, companion)
      assertInputError(
        yield* repository.commit({
          ...validStartInput,
          companion: {
            _tag: "dispatch",
            attempt: changedAttempt,
            policyEvaluation: changedPolicy
          }
        }).pipe(Effect.result),
        "invalid-request"
      )
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 2,
        transitions: 2
      })
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 1,
        evaluations: 0
      })
    })))

  it.effect("rejects authorization and dispatch at or beyond the proposal authority window", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorization = makeAuthorization(envelope)
      const validAuthorizationInput = makeAuthorizationInput(proposal, authorization)
      const lateAuthorization = {
        ...authorization,
        authorizedAt: decodeTimestamp("2026-07-15T10:10:00.000Z"),
        expiresAt: decodeTimestamp("2026-07-15T10:11:00.000Z")
      }
      assertInputError(
        yield* repository.commit({
          ...validAuthorizationInput,
          occurredAt: lateAuthorization.authorizedAt,
          companion: { _tag: "authorization", authorization: lateAuthorization }
        }).pipe(Effect.result),
        "invalid-request"
      )
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 0,
        evaluations: 0
      })

      yield* repository.commit(validAuthorizationInput)
      const companion = yield* makeDispatchCompanion(envelope)
      const expiredAuthorizationStart = "2026-07-15T10:06:00.000Z"
      const expiredAuthorizationPolicy = decodePolicyEvaluation({
        ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(companion.policyEvaluation),
        evaluatedAt: expiredAuthorizationStart
      })
      const expiredAuthorizationAttempt = decodeAttempt({
        ...Schema.encodeSync(GovernedActionAttemptV1)(companion.attempt),
        policyEvaluationDigest: yield* digestGovernedActionPolicyEvaluation(expiredAuthorizationPolicy),
        preflight: {
          _tag: "ready",
          checkedRevision: envelope.proposal.request.expectedRevision,
          checkedAt: expiredAuthorizationStart
        },
        startedAt: expiredAuthorizationStart
      })
      assertInputError(
        yield* repository.commit({
          ...makeStartInput(validAuthorizationInput, companion),
          occurredAt: decodeTimestamp(expiredAuthorizationStart),
          companion: {
            _tag: "dispatch",
            attempt: expiredAuthorizationAttempt,
            policyEvaluation: expiredAuthorizationPolicy
          }
        }).pipe(Effect.result),
        "illegal-transition"
      )

      const lateStartedAt = decodeTimestamp("2026-07-15T10:10:00.000Z")
      const latePolicy = decodePolicyEvaluation({
        ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(companion.policyEvaluation),
        evaluatedAt: "2026-07-15T10:10:00.000Z"
      })
      const lateAttempt = decodeAttempt({
        ...Schema.encodeSync(GovernedActionAttemptV1)(companion.attempt),
        policyEvaluationDigest: yield* digestGovernedActionPolicyEvaluation(latePolicy),
        preflight: {
          _tag: "ready",
          checkedRevision: envelope.proposal.request.expectedRevision,
          checkedAt: "2026-07-15T10:10:00.000Z"
        },
        startedAt: "2026-07-15T10:10:00.000Z"
      })
      assertInputError(
        yield* repository.commit({
          ...makeStartInput(validAuthorizationInput, companion),
          occurredAt: lateStartedAt,
          companion: { _tag: "dispatch", attempt: lateAttempt, policyEvaluation: latePolicy }
        }).pipe(Effect.result),
        "invalid-request"
      )
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 2,
        transitions: 2
      })
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 1,
        evaluations: 0
      })
    })))

  it.effect("rejects dispatch after bound evidence is no longer current", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const envelope = yield* makeEnvelope(ACTION_ID, {
        evidenceCurrentUntil: "2026-07-15T10:01:59.000Z"
      })
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorizationInput = makeAuthorizationInput(proposal, makeAuthorization(envelope))
      yield* repository.commit(authorizationInput)
      const companion = yield* makeDispatchCompanion(envelope)
      const staleEvidenceStartInput = {
        ...authorizationInput,
        expectedHeadTransitionId: AUTHORIZATION_TRANSITION_ID,
        transitionId: START_TRANSITION_ID,
        commandId: "command:PAY-42:start",
        command: decodeCommand({ _tag: "start", attemptId: ATTEMPT_ID }),
        cause: decodeCause({ _tag: "system", component: "governed-action-engine" }),
        occurredAt: decodeTimestamp("2026-07-15T10:02:00.000Z"),
        companion: { _tag: "dispatch", ...companion },
        auditEventId: START_AUDIT_ID
      }

      assertInputError(
        yield* repository.commit(staleEvidenceStartInput).pipe(Effect.result),
        "invalid-request"
      )
      assert.deepStrictEqual(yield* readLedgerCounts(), {
        actions: 1,
        audits: 2,
        transitions: 2
      })
      assert.deepStrictEqual(yield* readCompanionCounts(), {
        attempts: 0,
        authorizations: 1,
        evaluations: 0
      })
    })))

  it.effect("quarantines a second policy evaluation on exact replay and read", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const quarantine = yield* QuarantineRepository
      const { sql } = yield* Database
      const envelope = yield* makeEnvelope(ACTION_ID)
      const proposal = makeProposalInput(envelope)
      yield* repository.commit(proposal)
      const authorizationInput = makeAuthorizationInput(proposal, makeAuthorization(envelope))
      yield* repository.commit(authorizationInput)
      const companion = yield* makeDispatchCompanion(envelope)
      yield* repository.commit(makeStartInput(authorizationInput, companion))

      const secondEvaluation = decodePolicyEvaluation({
        ...Schema.encodeSync(GovernedActionPolicyEvaluationV1)(companion.policyEvaluation),
        evaluatedAt: "2026-07-15T10:01:31.000Z"
      })
      const secondDigest = yield* digestGovernedActionPolicyEvaluation(secondEvaluation)
      const secondJson = Schema.encodeSync(policyEvaluationJson)(secondEvaluation)
      yield* sql`INSERT INTO governed_action_policy_evaluations (
        workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
      ) VALUES (
        ${envelope.workspaceId}, ${envelope.actionId}, ${secondDigest}, ${secondJson},
        ${secondEvaluation.decision}, '2026-07-15T10:01:31.000Z'
      )`

      const replayResult = yield* repository.commit(
        makeStartInput(authorizationInput, companion)
      ).pipe(Effect.result)
      const result = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(replayResult))
      assert.isTrue(Result.isFailure(result))
      const quarantined = yield* quarantine.list(envelope.workspaceId)
      assert.lengthOf(quarantined, 2)
      assert.isTrue(quarantined.every(
        ({ diagnosticCode, occurrenceCount }) =>
          diagnosticCode === "governed-action-companion-invalid" && occurrenceCount === 1
      ))
    })))

  it.effect("quarantines malformed transition JSON before returning a governed action", () =>
    withRepository(Effect.gen(function*() {
      yield* seedAuthorityRoots()
      const repository = yield* GovernedActionRepository
      const quarantine = yield* QuarantineRepository
      const database = yield* Database
      const envelope = yield* makeEnvelope(ACTION_ID)
      yield* repository.commit(makeProposalInput(envelope))

      const secretCanary = "never-retain-corrupt-transition-json"
      yield* database.sql`DROP TRIGGER governed_action_transitions_no_update`
      yield* database.sql`UPDATE governed_action_transitions
        SET transition_json = ${JSON.stringify({ secret: secretCanary })}
        WHERE workspace_id = ${envelope.workspaceId}
          AND action_id = ${envelope.actionId}
          AND transition_id = ${PROPOSAL_TRANSITION_ID}`

      const corrupted = yield* repository.read({
        workspaceId: envelope.workspaceId,
        actionId: envelope.actionId
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(corrupted))
      if (Result.isFailure(corrupted)) {
        assert.isTrue(Schema.is(PersistedRecordError)(corrupted.failure))
        if (Schema.is(PersistedRecordError)(corrupted.failure)) {
          assert.strictEqual(
            corrupted.failure.diagnosticCode,
            "governed-action-transition-schema-invalid"
          )
        }
      }
      const quarantined = yield* quarantine.list(envelope.workspaceId)
      assert.lengthOf(quarantined, 1)
      assert.deepInclude(quarantined[0], {
        recordKind: "governed-action-transition",
        recordKey: PROPOSAL_TRANSITION_ID,
        schemaVersion: 1,
        diagnosticCode: "governed-action-transition-schema-invalid",
        diagnosticSummary: "Stored governed action transition failed schema validation.",
        occurrenceCount: 1
      })
      assert.match(quarantined[0]?.payloadDigest ?? "", /^[0-9a-f]{64}$/u)
      assert.notInclude(JSON.stringify(quarantined), secretCanary)
    })))
})
