import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-320000000001"
const otherWorkspaceId = "01890f6f-6d6a-7cc0-98d2-320000000002"
const connectionId = "01890f6f-6d6a-7cc0-98d2-320000000003"
const entityId = "01890f6f-6d6a-7cc0-98d2-320000000004"
const sessionId = "01890f6f-6d6a-7cc0-98d2-320000000005"
const otherSessionId = "01890f6f-6d6a-7cc0-98d2-320000000040"
const actionId = "01890f6f-6d6a-7cc0-98d2-320000000006"
const otherActionId = "01890f6f-6d6a-7cc0-98d2-320000000007"
const authorizationId = "01890f6f-6d6a-7cc0-98d2-320000000008"
const attemptId = "01890f6f-6d6a-7cc0-98d2-320000000009"
const firstTransitionId = "01890f6f-6d6a-7cc0-98d2-32000000000a"
const secondTransitionId = "01890f6f-6d6a-7cc0-98d2-32000000000b"
const otherConnectionId = "01890f6f-6d6a-7cc0-98d2-320000000011"
const otherEntityId = "01890f6f-6d6a-7cc0-98d2-320000000012"
const otherAuthorizationId = "01890f6f-6d6a-7cc0-98d2-320000000013"
const otherAttemptId = "01890f6f-6d6a-7cc0-98d2-320000000014"
const auditEventId = "01890f6f-6d6a-7cc0-98d2-320000000015"
const fabricatedActionId = "01890f6f-6d6a-7cc0-98d2-320000000016"
const thirdTransitionId = "01890f6f-6d6a-7cc0-98d2-320000000017"
const fourthTransitionId = "01890f6f-6d6a-7cc0-98d2-320000000018"
const fifthTransitionId = "01890f6f-6d6a-7cc0-98d2-320000000019"
const sixthTransitionId = "01890f6f-6d6a-7cc0-98d2-32000000001a"
const providerOperationId = "jira-operation-42"
const reconciliationKey = "jira-reconcile-42"
const envelopeDigest = `sha256:${"a".repeat(64)}`
const policyEvaluationDigest = `sha256:${"b".repeat(64)}`
const commandDigest = `sha256:${"c".repeat(64)}`
const authorizationDigest = `sha256:${"d".repeat(64)}`
const attemptDigest = `sha256:${"e".repeat(64)}`
const transitionDigest = `sha256:${"f".repeat(64)}`
const recordedAt = "2026-07-15T10:00:00.000Z"
const humanPersonId = "01890f6f-6d6a-7cc0-98d2-320000000010"
const otherHumanPersonId = "01890f6f-6d6a-7cc0-98d2-320000000041"

const seedAuthorityRoots = Effect.fn("GovernedActionMigrationTest.seedRoots")(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES
    (${workspaceId}, 'Governance', 1, ${recordedAt}, ${recordedAt}),
    (${otherWorkspaceId}, 'Other', 1, ${recordedAt}, ${recordedAt})`
  yield* sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES (${workspaceId}, ${connectionId}, 'jira', 'Jira', 1, 1, ${recordedAt}, ${recordedAt})`
  yield* sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
    entity_type, current_revision, created_at, updated_at
  ) VALUES (
    ${workspaceId}, ${entityId}, ${connectionId}, 'jira', 'PAY-42',
    'issue', 1, ${recordedAt}, ${recordedAt}
  )`
  yield* sql`INSERT INTO sessions (
    workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
    permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
  ) VALUES
    (${workspaceId}, ${sessionId}, ${"1".repeat(64)}, ${"2".repeat(64)},
      'human', ${humanPersonId}, NULL, 'workspace-owner',
      ${recordedAt}, ${recordedAt}, '2026-07-15T11:00:00.000Z',
      '2026-08-15T10:00:00.000Z', NULL),
    (${workspaceId}, ${otherSessionId}, ${"9".repeat(64)}, ${"0".repeat(64)},
      'human', ${otherHumanPersonId}, NULL, 'workspace-owner',
      ${recordedAt}, ${recordedAt}, '2026-07-15T11:00:00.000Z',
      '2026-08-15T10:00:00.000Z', NULL)`
})

const insertAction = Effect.fn("GovernedActionMigrationTest.insertAction")(function*(options?: {
  readonly actionId?: string
  readonly connectionId?: string
  readonly entityId?: string
  readonly idempotencyKey?: string
}) {
  const { sql } = yield* Database
  const selectedActionId = options?.actionId ?? actionId
  const selectedConnectionId = options?.connectionId ?? connectionId
  const selectedEntityId = options?.entityId ?? entityId
  const idempotencyKey = options?.idempotencyKey ?? "jira:PAY-42:done"
  yield* sql`INSERT INTO governed_actions (
    workspace_id, action_id, plugin_connection_id, provider_id, target_entity_id,
    idempotency_key, envelope_digest, envelope_json, state, lineage_json,
    lineage_kind, provider_operation_id, reconciliation_key, terminal_status,
    head_transition_id, head_sequence, created_at, updated_at
  ) VALUES (
    ${workspaceId}, ${selectedActionId}, ${selectedConnectionId}, 'jira', ${selectedEntityId},
    ${idempotencyKey}, ${envelopeDigest}, '{}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    ${recordedAt}, ${recordedAt}
  )`
})

const insertTransition = Effect.fn("GovernedActionMigrationTest.insertTransition")(function*(input: {
  readonly actionId?: string
  readonly attemptId?: string
  readonly authorizationId?: string
  readonly causationId?: string
  readonly causeActorId?: string
  readonly causeJobId?: string
  readonly causeKind?: "agent" | "human" | "system"
  readonly causeSessionId?: string
  readonly causeSystemComponent?: string
  readonly commandId: string
  readonly commandProviderOperationId?: string
  readonly commandReconciliationKey?: string
  readonly commandTag: string
  readonly commandTerminalStatus?: string
  readonly commandUnknownKind?: string
  readonly correlationId?: string
  readonly fromState: string | null
  readonly occurredAt: string
  readonly outcomeSourceKind?: string
  readonly previousTransitionId: string | null
  readonly resultLineageJson: string
  readonly resultLineageKind: string
  readonly resultProviderOperationId?: string
  readonly resultReconciliationKey?: string
  readonly resultTerminalStatus?: string
  readonly sequence: number
  readonly toState: string
  readonly transitionId: string
}) {
  const { sql } = yield* Database
  const selectedActionId = input.actionId ?? actionId
  const defaultHumanCause = input.commandTag === "propose" || input.commandTag === "authorize"
  const causeKind = input.causeKind ?? (defaultHumanCause ? "human" : "system")
  const causeActorId = input.causeActorId ?? (causeKind === "human" ? humanPersonId : null)
  const causeSessionId = input.causeSessionId ?? (causeKind === "human" ? sessionId : null)
  const causeSystemComponent = input.causeSystemComponent ??
    (causeKind === "system" ? "governed-action-engine" : null)
  yield* sql`INSERT INTO governed_action_transitions (
    workspace_id, action_id, transition_id, previous_transition_id, sequence,
    command_id, command_tag, authorization_id, attempt_id, outcome_source_kind,
    command_provider_operation_id, command_reconciliation_key, command_terminal_status,
    command_unknown_kind, command_digest, envelope_digest,
    from_state, to_state, result_lineage_json, result_lineage_kind,
    result_provider_operation_id, result_reconciliation_key, result_terminal_status,
    cause_kind, cause_actor_id, cause_session_id, cause_job_id, cause_system_component,
    causation_id, correlation_id,
    transition_digest, transition_json, occurred_at
  ) VALUES (
    ${workspaceId}, ${selectedActionId}, ${input.transitionId}, ${input.previousTransitionId}, ${input.sequence},
    ${input.commandId}, ${input.commandTag}, ${input.authorizationId ?? null}, ${input.attemptId ?? null},
    ${input.outcomeSourceKind ?? null}, ${input.commandProviderOperationId ?? null},
    ${input.commandReconciliationKey ?? null}, ${input.commandTerminalStatus ?? null},
    ${input.commandUnknownKind ?? null},
    ${commandDigest}, ${envelopeDigest}, ${input.fromState}, ${input.toState},
    ${input.resultLineageJson}, ${input.resultLineageKind},
    ${input.resultProviderOperationId ?? null}, ${input.resultReconciliationKey ?? null},
    ${input.resultTerminalStatus ?? null}, ${causeKind}, ${causeActorId}, ${causeSessionId},
    ${input.causeJobId ?? null}, ${causeSystemComponent}, ${input.causationId ?? null},
    ${input.correlationId ?? null}, ${transitionDigest}, '{}', ${input.occurredAt}
  )`
})

const insertAudit = Effect.fn("GovernedActionMigrationTest.insertAudit")(function*(input: {
  readonly actionId?: string
  readonly actorId?: string
  readonly auditEventId: string
  readonly causationId?: string
  readonly causeKind: "agent" | "human" | "system"
  readonly correlationId?: string
  readonly eventKind: string
  readonly jobId?: string
  readonly occurredAt: string
  readonly payloadDigest?: string
  readonly sessionId?: string
  readonly systemComponent?: string
  readonly transitionId: string
}) {
  const { sql } = yield* Database
  yield* sql`INSERT INTO audit_events (
    workspace_id, action_id, transition_id, audit_event_id, event_kind, cause_kind,
    actor_id, session_id, job_id, system_component, causation_id, correlation_id,
    payload_digest, payload_json, occurred_at
  ) VALUES (
    ${workspaceId}, ${input.actionId ?? actionId}, ${input.transitionId}, ${input.auditEventId},
    ${input.eventKind}, ${input.causeKind}, ${input.actorId ?? null}, ${input.sessionId ?? null},
    ${input.jobId ?? null}, ${input.systemComponent ?? null}, ${input.causationId ?? null},
    ${input.correlationId ?? null}, ${input.payloadDigest ?? transitionDigest}, '{}', ${input.occurredAt}
  )`
})

describe("governed action migration invariants", () => {
  it.effect("enforces exact append-only head advancement and immutable child records", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-governed-actions-")
      yield* Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedAuthorityRoots()
        yield* insertAction()
        yield* insertAction({
          actionId: otherActionId,
          idempotencyKey: "jira:PAY-42:lifecycle-other"
        })

        yield* insertTransition({
          commandId: "propose-1",
          commandTag: "propose",
          fromState: null,
          occurredAt: recordedAt,
          previousTransitionId: null,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 1,
          toState: "proposed",
          transitionId: firstTransitionId
        })
        yield* insertAudit({
          actorId: humanPersonId,
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000030",
          causeKind: "human",
          eventKind: "proposed",
          occurredAt: recordedAt,
          sessionId,
          transitionId: firstTransitionId
        })
        yield* sql`UPDATE governed_actions
          SET state = 'proposed', lineage_json = '{"_tag":"none"}',
              lineage_kind = 'none', provider_operation_id = NULL,
              reconciliation_key = NULL, terminal_status = NULL,
              head_transition_id = ${firstTransitionId}, head_sequence = 1,
              updated_at = ${recordedAt}
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        yield* sql`INSERT INTO governed_action_policy_evaluations (
          workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
        ) VALUES
          (${workspaceId}, ${actionId}, ${policyEvaluationDigest}, '{}', 'allowed', ${recordedAt}),
          (${workspaceId}, ${otherActionId}, ${policyEvaluationDigest}, '{}', 'allowed', ${recordedAt})`
        yield* sql`INSERT INTO governed_action_authorizations (
          workspace_id, action_id, authorization_id, session_id, envelope_digest,
          authorization_digest, authorization_json, authorized_at, expires_at
        ) VALUES
          (${workspaceId}, ${actionId}, ${authorizationId}, ${sessionId}, ${envelopeDigest},
            ${authorizationDigest}, '{}', ${recordedAt}, '2026-07-15T10:05:00.000Z'),
          (${workspaceId}, ${otherActionId}, ${otherAuthorizationId}, ${sessionId}, ${envelopeDigest},
            ${authorizationDigest}, '{}', ${recordedAt}, '2026-07-15T10:05:00.000Z')`
        const missingAuthorization = yield* insertTransition({
          commandId: "authorize-missing",
          commandTag: "authorize",
          fromState: "proposed",
          occurredAt: recordedAt,
          previousTransitionId: firstTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 2,
          toState: "authorized",
          transitionId: secondTransitionId
        }).pipe(Effect.result)
        const crossActionAuthorization = yield* insertTransition({
          authorizationId: otherAuthorizationId,
          commandId: "authorize-cross-action",
          commandTag: "authorize",
          fromState: "proposed",
          occurredAt: recordedAt,
          previousTransitionId: firstTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 2,
          toState: "authorized",
          transitionId: secondTransitionId
        }).pipe(Effect.result)
        const mismatchedAuthorizationSession = yield* insertTransition({
          authorizationId,
          causeActorId: otherHumanPersonId,
          causeSessionId: otherSessionId,
          commandId: "authorize-other-session",
          commandTag: "authorize",
          fromState: "proposed",
          occurredAt: recordedAt,
          previousTransitionId: firstTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 2,
          toState: "authorized",
          transitionId: secondTransitionId
        }).pipe(Effect.result)

        const skipped = yield* insertTransition({
          authorizationId,
          commandId: "authorize-skipped",
          commandTag: "authorize",
          fromState: "proposed",
          occurredAt: recordedAt,
          previousTransitionId: firstTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 3,
          toState: "authorized",
          transitionId: secondTransitionId
        }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(skipped))

        yield* insertTransition({
          authorizationId,
          commandId: "authorize-1",
          commandTag: "authorize",
          fromState: "proposed",
          occurredAt: recordedAt,
          previousTransitionId: firstTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 2,
          toState: "authorized",
          transitionId: secondTransitionId
        })
        const headWithoutAudit = yield* sql`UPDATE governed_actions
          SET state = 'authorized', lineage_json = '{"_tag":"none"}',
              lineage_kind = 'none', provider_operation_id = NULL,
              reconciliation_key = NULL, terminal_status = NULL,
              head_transition_id = ${secondTransitionId}, head_sequence = 2,
              updated_at = ${recordedAt}
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`.pipe(Effect.result)
        const misattributedAudit = yield* insertAudit({
          actorId: "01890f6f-6d6a-7cc0-98d2-320000000099",
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000029",
          causeKind: "human",
          eventKind: "authorized",
          occurredAt: recordedAt,
          sessionId,
          transitionId: secondTransitionId
        }).pipe(Effect.result)
        yield* insertAudit({
          actorId: humanPersonId,
          auditEventId,
          causeKind: "human",
          eventKind: "authorized",
          occurredAt: recordedAt,
          sessionId,
          transitionId: secondTransitionId
        })
        yield* sql`UPDATE governed_actions
          SET state = 'authorized', lineage_json = '{"_tag":"none"}',
              lineage_kind = 'none', provider_operation_id = NULL,
              reconciliation_key = NULL, terminal_status = NULL,
              head_transition_id = ${secondTransitionId}, head_sequence = 2,
              updated_at = ${recordedAt}
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES
          (${workspaceId}, ${actionId}, ${attemptId}, ${authorizationId}, ${policyEvaluationDigest},
            ${attemptDigest}, 1, '{}', '2026-07-15T10:01:00.000Z'),
          (${workspaceId}, ${otherActionId}, ${otherAttemptId}, ${otherAuthorizationId},
            ${policyEvaluationDigest}, ${attemptDigest}, 1, '{}', '2026-07-15T10:01:00.000Z')`
        const missingAttempt = yield* insertTransition({
          commandId: "start-missing",
          commandTag: "start",
          fromState: "authorized",
          occurredAt: "2026-07-15T10:01:00.000Z",
          previousTransitionId: secondTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 3,
          toState: "started",
          transitionId: thirdTransitionId
        }).pipe(Effect.result)
        const crossActionAttempt = yield* insertTransition({
          attemptId: otherAttemptId,
          commandId: "start-cross-action",
          commandTag: "start",
          fromState: "authorized",
          occurredAt: "2026-07-15T10:01:00.000Z",
          previousTransitionId: secondTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 3,
          toState: "started",
          transitionId: thirdTransitionId
        }).pipe(Effect.result)
        const fabricatedStartLineage = yield* insertTransition({
          attemptId,
          commandId: "start-fabricated-lineage",
          commandTag: "start",
          fromState: "authorized",
          occurredAt: "2026-07-15T10:01:00.000Z",
          previousTransitionId: secondTransitionId,
          resultLineageJson: "{\"_tag\":\"accepted\"}",
          resultLineageKind: "accepted",
          resultProviderOperationId: providerOperationId,
          resultReconciliationKey: reconciliationKey,
          sequence: 3,
          toState: "started",
          transitionId: thirdTransitionId
        }).pipe(Effect.result)

        const mutateAttempt = yield* sql`UPDATE governed_action_attempts
          SET attempt_json = '{"changed":true}'
          WHERE workspace_id = ${workspaceId} AND attempt_id = ${attemptId}`.pipe(Effect.result)
        const deleteTransition = yield* sql`DELETE FROM governed_action_transitions
          WHERE workspace_id = ${workspaceId} AND transition_id = ${firstTransitionId}`.pipe(Effect.result)
        const rewriteEnvelope = yield* sql`UPDATE governed_actions SET envelope_json = '{"changed":true}'
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`.pipe(Effect.result)
        const deleteAudit = yield* sql`DELETE FROM audit_events
          WHERE workspace_id = ${workspaceId} AND audit_event_id = ${auditEventId}`.pipe(Effect.result)

        assert.isTrue(Result.isFailure(mutateAttempt))
        assert.isTrue(Result.isFailure(deleteTransition))
        assert.isTrue(Result.isFailure(rewriteEnvelope))
        assert.isTrue(Result.isFailure(deleteAudit))
        assert.isTrue(Result.isFailure(misattributedAudit))
        assert.isTrue(Result.isFailure(headWithoutAudit))
        assert.isTrue(Result.isFailure(missingAuthorization))
        assert.isTrue(Result.isFailure(crossActionAuthorization))
        assert.isTrue(Result.isFailure(mismatchedAuthorizationSession))
        assert.isTrue(Result.isFailure(missingAttempt))
        assert.isTrue(Result.isFailure(crossActionAttempt))
        assert.isTrue(Result.isFailure(fabricatedStartLineage))
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("scopes idempotency and child authority to the exact workspace action", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-governed-action-scope-")
      yield* Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedAuthorityRoots()
        yield* insertAction()

        yield* sql`INSERT INTO plugin_connections (
          workspace_id, plugin_connection_id, provider_id, display_name,
          revision, is_enabled, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${otherConnectionId}, 'jira', 'Other Jira', 1, 1,
          ${recordedAt}, ${recordedAt}
        )`
        yield* sql`INSERT INTO entities (
          workspace_id, entity_id, plugin_connection_id, provider_id, vendor_immutable_id,
          entity_type, current_revision, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${otherEntityId}, ${otherConnectionId}, 'jira', 'PAY-43',
          'issue', 1, ${recordedAt}, ${recordedAt}
        )`

        const duplicateKey = yield* insertAction({ actionId: otherActionId }).pipe(Effect.result)
        const mismatchedTarget = yield* insertAction({
          actionId: otherActionId,
          entityId: otherEntityId,
          idempotencyKey: "jira:PAY-43:done"
        }).pipe(Effect.result)
        yield* insertAction({
          actionId: otherActionId,
          connectionId: otherConnectionId,
          entityId: otherEntityId,
          idempotencyKey: "jira:PAY-42:done"
        })
        const fabricatedHead = yield* sql`INSERT INTO governed_actions (
          workspace_id, action_id, plugin_connection_id, provider_id, target_entity_id,
          idempotency_key, envelope_digest, envelope_json, state, lineage_json,
          lineage_kind, provider_operation_id, reconciliation_key, terminal_status,
          head_transition_id, head_sequence, created_at, updated_at
        ) VALUES (
          ${workspaceId}, ${fabricatedActionId}, ${connectionId}, 'jira', ${entityId},
          'jira:PAY-42:fabricated', ${envelopeDigest}, '{}', 'succeeded',
          '{"_tag":"terminal"}', 'terminal', ${providerOperationId}, NULL, 'succeeded',
          ${fifthTransitionId}, 1, ${recordedAt}, ${recordedAt}
        )`.pipe(Effect.result)
        const crossWorkspacePolicy = yield* sql`INSERT INTO governed_action_policy_evaluations (
          workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
        ) VALUES (
          ${otherWorkspaceId}, ${actionId}, ${policyEvaluationDigest}, '{}', 'allowed', ${recordedAt}
        )`.pipe(Effect.result)
        const orphanAttempt = yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${attemptId}, ${authorizationId}, ${policyEvaluationDigest},
          ${attemptDigest}, 1, '{}', '2026-07-15T10:01:00.000Z'
        )`.pipe(Effect.result)

        assert.isTrue(Result.isFailure(duplicateKey))
        assert.isTrue(Result.isFailure(mismatchedTarget))
        assert.isTrue(Result.isFailure(fabricatedHead))
        assert.isTrue(Result.isFailure(crossWorkspacePolicy))
        assert.isTrue(Result.isFailure(orphanAttempt))
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("binds dispatch attempts to current human authorization windows", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-governed-action-authority-")
      yield* Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedAuthorityRoots()
        yield* insertAction()
        yield* insertAction({
          actionId: otherActionId,
          idempotencyKey: "jira:PAY-42:other-action"
        })
        yield* insertAction({
          actionId: fabricatedActionId,
          idempotencyKey: "jira:PAY-42:invalid-session"
        })

        yield* sql`INSERT INTO governed_action_policy_evaluations (
          workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
        ) VALUES
          (${workspaceId}, ${actionId}, ${policyEvaluationDigest}, '{}', 'allowed', ${recordedAt}),
          (${workspaceId}, ${otherActionId}, ${policyEvaluationDigest}, '{}', 'allowed', ${recordedAt})`
        yield* sql`INSERT INTO governed_action_authorizations (
          workspace_id, action_id, authorization_id, session_id, envelope_digest,
          authorization_digest, authorization_json, authorized_at, expires_at
        ) VALUES (
          ${workspaceId}, ${otherActionId}, ${otherAuthorizationId}, ${sessionId}, ${envelopeDigest},
          ${authorizationDigest}, '{}', '2026-07-15T10:01:00.000Z', '2026-07-15T10:05:00.000Z'
        )`

        const splicedAuthorization = yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${attemptId}, ${otherAuthorizationId}, ${policyEvaluationDigest},
          ${attemptDigest}, 1, '{}', '2026-07-15T10:02:00.000Z'
        )`.pipe(Effect.result)

        yield* sql`INSERT INTO governed_action_authorizations (
          workspace_id, action_id, authorization_id, session_id, envelope_digest,
          authorization_digest, authorization_json, authorized_at, expires_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${authorizationId}, ${sessionId}, ${envelopeDigest},
          ${authorizationDigest}, '{}', '2026-07-15T10:01:00.000Z', '2026-07-15T10:05:00.000Z'
        )`
        const beforeAuthorization = yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${attemptId}, ${authorizationId}, ${policyEvaluationDigest},
          ${attemptDigest}, 1, '{}', '2026-07-15T10:00:30.000Z'
        )`.pipe(Effect.result)
        const atExpiry = yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${attemptId}, ${authorizationId}, ${policyEvaluationDigest},
          ${attemptDigest}, 1, '{}', '2026-07-15T10:05:00.000Z'
        )`.pipe(Effect.result)
        yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${attemptId}, ${authorizationId}, ${policyEvaluationDigest},
          ${attemptDigest}, 1, '{}', '2026-07-15T10:02:00.000Z'
        )`
        yield* sql`UPDATE sessions SET revoked_at = '2026-07-15T10:02:30.000Z'
          WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}`
        const revokedSessionAttempt = yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${workspaceId}, ${otherActionId}, ${otherAttemptId}, ${otherAuthorizationId},
          ${policyEvaluationDigest}, ${attemptDigest}, 1, '{}', '2026-07-15T10:03:00.000Z'
        )`.pipe(Effect.result)

        yield* sql`INSERT INTO sessions (
          workspace_id, session_id, token_hash, csrf_hash, actor_kind, person_id, agent_id,
          permission, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
        ) VALUES
          (${workspaceId}, '01890f6f-6d6a-7cc0-98d2-320000000020', ${"3".repeat(64)}, ${"4".repeat(64)},
            'agent', NULL, '01890f6f-6d6a-7cc0-98d2-320000000021', 'operator',
            ${recordedAt}, ${recordedAt}, '2026-07-15T11:00:00.000Z',
            '2026-08-15T10:00:00.000Z', NULL),
          (${workspaceId}, '01890f6f-6d6a-7cc0-98d2-320000000022', ${"5".repeat(64)}, ${"6".repeat(64)},
            'human', '01890f6f-6d6a-7cc0-98d2-320000000023', NULL, 'workspace-owner',
            '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z',
            '2026-07-15T11:00:00.000Z', '2026-08-15T10:00:00.000Z',
            '2026-07-15T09:59:00.000Z'),
          (${workspaceId}, '01890f6f-6d6a-7cc0-98d2-320000000024', ${"7".repeat(64)}, ${"8".repeat(64)},
            'human', '01890f6f-6d6a-7cc0-98d2-320000000025', NULL, 'workspace-owner',
            '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z',
            '2026-07-15T09:59:00.000Z', '2026-08-15T10:00:00.000Z', NULL)`

        const invalidSessionAuthorizations = yield* Effect.all([
          sql`INSERT INTO governed_action_authorizations (
            workspace_id, action_id, authorization_id, session_id, envelope_digest,
            authorization_digest, authorization_json, authorized_at, expires_at
          ) VALUES (
            ${workspaceId}, ${fabricatedActionId}, '01890f6f-6d6a-7cc0-98d2-320000000026',
            '01890f6f-6d6a-7cc0-98d2-320000000020', ${envelopeDigest}, ${authorizationDigest},
            '{}', ${recordedAt}, '2026-07-15T10:05:00.000Z'
          )`.pipe(Effect.result),
          sql`INSERT INTO governed_action_authorizations (
            workspace_id, action_id, authorization_id, session_id, envelope_digest,
            authorization_digest, authorization_json, authorized_at, expires_at
          ) VALUES (
            ${workspaceId}, ${fabricatedActionId}, '01890f6f-6d6a-7cc0-98d2-320000000027',
            '01890f6f-6d6a-7cc0-98d2-320000000022', ${envelopeDigest}, ${authorizationDigest},
            '{}', ${recordedAt}, '2026-07-15T10:05:00.000Z'
          )`.pipe(Effect.result),
          sql`INSERT INTO governed_action_authorizations (
            workspace_id, action_id, authorization_id, session_id, envelope_digest,
            authorization_digest, authorization_json, authorized_at, expires_at
          ) VALUES (
            ${workspaceId}, ${fabricatedActionId}, '01890f6f-6d6a-7cc0-98d2-320000000028',
            '01890f6f-6d6a-7cc0-98d2-320000000024', ${envelopeDigest}, ${authorizationDigest},
            '{}', ${recordedAt}, '2026-07-15T10:05:00.000Z'
          )`.pipe(Effect.result)
        ])
        const revokedTransitionCause = yield* insertTransition({
          actionId: fabricatedActionId,
          commandId: "propose-revoked-session",
          commandTag: "propose",
          fromState: null,
          occurredAt: "2026-07-15T10:03:00.000Z",
          previousTransitionId: null,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 1,
          toState: "proposed",
          transitionId: sixthTransitionId
        }).pipe(Effect.result)
        const expiredTransitionCause = yield* insertTransition({
          actionId: fabricatedActionId,
          causeActorId: "01890f6f-6d6a-7cc0-98d2-320000000025",
          causeSessionId: "01890f6f-6d6a-7cc0-98d2-320000000024",
          commandId: "propose-expired-session",
          commandTag: "propose",
          fromState: null,
          occurredAt: recordedAt,
          previousTransitionId: null,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 1,
          toState: "proposed",
          transitionId: sixthTransitionId
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(splicedAuthorization))
        assert.isTrue(Result.isFailure(beforeAuthorization))
        assert.isTrue(Result.isFailure(atExpiry))
        assert.isTrue(Result.isFailure(revokedSessionAttempt))
        assert.isTrue(Result.isFailure(revokedTransitionCause))
        assert.isTrue(Result.isFailure(expiredTransitionCause))
        assert.isTrue(invalidSessionAuthorizations.every(Result.isFailure))
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects impossible, regressive, or lineage-spliced lifecycle heads", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-governed-action-lifecycle-")
      yield* Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedAuthorityRoots()
        yield* insertAction()

        const directInitialSuccess = yield* insertTransition({
          commandId: "impossible-success-1",
          commandProviderOperationId: providerOperationId,
          commandTag: "recordSucceeded",
          commandTerminalStatus: "succeeded",
          fromState: null,
          occurredAt: recordedAt,
          outcomeSourceKind: "direct",
          previousTransitionId: null,
          resultLineageJson: "{\"_tag\":\"terminal\"}",
          resultLineageKind: "terminal",
          resultProviderOperationId: providerOperationId,
          resultTerminalStatus: "succeeded",
          sequence: 1,
          toState: "succeeded",
          transitionId: fifthTransitionId
        }).pipe(Effect.result)

        yield* insertTransition({
          commandId: "propose-1",
          commandTag: "propose",
          fromState: null,
          occurredAt: recordedAt,
          previousTransitionId: null,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 1,
          toState: "proposed",
          transitionId: firstTransitionId
        })
        yield* insertAudit({
          actorId: humanPersonId,
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000031",
          causeKind: "human",
          eventKind: "proposed",
          occurredAt: recordedAt,
          sessionId,
          transitionId: firstTransitionId
        })
        yield* sql`UPDATE governed_actions
          SET state = 'proposed', lineage_json = '{"_tag":"none"}', lineage_kind = 'none',
              provider_operation_id = NULL, reconciliation_key = NULL, terminal_status = NULL,
              head_transition_id = ${firstTransitionId}, head_sequence = 1, updated_at = ${recordedAt}
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        yield* sql`INSERT INTO governed_action_policy_evaluations (
          workspace_id, action_id, evaluation_digest, evaluation_json, decision, evaluated_at
        ) VALUES (${workspaceId}, ${actionId}, ${policyEvaluationDigest}, '{}', 'allowed', ${recordedAt})`
        yield* sql`INSERT INTO governed_action_authorizations (
          workspace_id, action_id, authorization_id, session_id, envelope_digest,
          authorization_digest, authorization_json, authorized_at, expires_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${authorizationId}, ${sessionId}, ${envelopeDigest},
          ${authorizationDigest}, '{}', ${recordedAt}, '2026-07-15T10:05:00.000Z'
        )`
        const regressiveAuthorization = yield* insertTransition({
          authorizationId,
          commandId: "authorize-regressive",
          commandTag: "authorize",
          fromState: "proposed",
          occurredAt: "2026-07-15T09:59:59.000Z",
          previousTransitionId: firstTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 2,
          toState: "authorized",
          transitionId: secondTransitionId
        }).pipe(Effect.result)
        yield* insertTransition({
          authorizationId,
          commandId: "authorize-1",
          commandTag: "authorize",
          fromState: "proposed",
          occurredAt: recordedAt,
          previousTransitionId: firstTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 2,
          toState: "authorized",
          transitionId: secondTransitionId
        })
        yield* insertAudit({
          actorId: humanPersonId,
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000032",
          causeKind: "human",
          eventKind: "authorized",
          occurredAt: recordedAt,
          sessionId,
          transitionId: secondTransitionId
        })
        yield* sql`UPDATE governed_actions
          SET state = 'authorized', lineage_json = '{"_tag":"none"}', lineage_kind = 'none',
              provider_operation_id = NULL, reconciliation_key = NULL, terminal_status = NULL,
              head_transition_id = ${secondTransitionId}, head_sequence = 2, updated_at = ${recordedAt}
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id, authorization_id, policy_evaluation_digest,
          attempt_digest, attempt_number, attempt_json, started_at
        ) VALUES (
          ${workspaceId}, ${actionId}, ${attemptId}, ${authorizationId}, ${policyEvaluationDigest},
          ${attemptDigest}, 1, '{}', '2026-07-15T10:01:00.000Z'
        )`
        const skippedStart = yield* insertTransition({
          commandId: "skip-start-1",
          commandProviderOperationId: providerOperationId,
          commandTag: "recordSucceeded",
          commandTerminalStatus: "succeeded",
          fromState: "authorized",
          occurredAt: "2026-07-15T10:01:00.000Z",
          outcomeSourceKind: "direct",
          previousTransitionId: secondTransitionId,
          resultLineageJson: "{\"_tag\":\"terminal\"}",
          resultLineageKind: "terminal",
          resultProviderOperationId: providerOperationId,
          resultTerminalStatus: "succeeded",
          sequence: 3,
          toState: "succeeded",
          transitionId: thirdTransitionId
        }).pipe(Effect.result)
        yield* insertTransition({
          attemptId,
          commandId: "start-1",
          commandTag: "start",
          fromState: "authorized",
          occurredAt: "2026-07-15T10:01:00.000Z",
          previousTransitionId: secondTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 3,
          toState: "started",
          transitionId: thirdTransitionId
        })
        const wrongSystemAudit = yield* insertAudit({
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000036",
          causationId: "unrelated-cause",
          causeKind: "system",
          eventKind: "started",
          occurredAt: "2026-07-15T10:01:00.000Z",
          payloadDigest: authorizationDigest,
          systemComponent: "unrelated-component",
          transitionId: thirdTransitionId
        }).pipe(Effect.result)
        const humanAuditForSystemTransition = yield* insertAudit({
          actorId: humanPersonId,
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000037",
          causeKind: "human",
          eventKind: "started",
          occurredAt: "2026-07-15T10:01:00.000Z",
          sessionId,
          transitionId: thirdTransitionId
        }).pipe(Effect.result)
        yield* insertAudit({
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000033",
          causeKind: "system",
          eventKind: "started",
          occurredAt: "2026-07-15T10:01:00.000Z",
          systemComponent: "governed-action-engine",
          transitionId: thirdTransitionId
        })

        const splicedStartedLineage = yield* sql`UPDATE governed_actions
          SET state = 'started', lineage_json = '{"_tag":"accepted"}', lineage_kind = 'accepted',
              provider_operation_id = ${providerOperationId}, reconciliation_key = ${reconciliationKey},
              terminal_status = NULL, head_transition_id = ${thirdTransitionId}, head_sequence = 3,
              updated_at = '2026-07-15T10:01:00.000Z'
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`.pipe(Effect.result)
        yield* sql`UPDATE governed_actions
          SET state = 'started', lineage_json = '{"_tag":"none"}', lineage_kind = 'none',
              provider_operation_id = NULL, reconciliation_key = NULL, terminal_status = NULL,
              head_transition_id = ${thirdTransitionId}, head_sequence = 3,
              updated_at = '2026-07-15T10:01:00.000Z'
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        const droppedAcceptedReceipt = yield* insertTransition({
          commandId: "accepted-dropped",
          commandProviderOperationId: providerOperationId,
          commandReconciliationKey: reconciliationKey,
          commandTag: "recordAccepted",
          fromState: "started",
          occurredAt: "2026-07-15T10:02:00.000Z",
          previousTransitionId: thirdTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 4,
          toState: "started",
          transitionId: fourthTransitionId
        }).pipe(Effect.result)
        yield* insertTransition({
          commandId: "accepted-1",
          commandProviderOperationId: providerOperationId,
          commandReconciliationKey: reconciliationKey,
          commandTag: "recordAccepted",
          fromState: "started",
          occurredAt: "2026-07-15T10:02:00.000Z",
          previousTransitionId: thirdTransitionId,
          resultLineageJson: "{\"_tag\":\"accepted\"}",
          resultLineageKind: "accepted",
          resultProviderOperationId: providerOperationId,
          resultReconciliationKey: reconciliationKey,
          sequence: 4,
          toState: "started",
          transitionId: fourthTransitionId
        })
        yield* insertAudit({
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000034",
          causeKind: "system",
          eventKind: "started",
          occurredAt: "2026-07-15T10:02:00.000Z",
          systemComponent: "governed-action-engine",
          transitionId: fourthTransitionId
        })
        yield* sql`UPDATE governed_actions
          SET state = 'started', lineage_json = '{"_tag":"accepted"}', lineage_kind = 'accepted',
              provider_operation_id = ${providerOperationId}, reconciliation_key = ${reconciliationKey},
              terminal_status = NULL, head_transition_id = ${fourthTransitionId}, head_sequence = 4,
              updated_at = '2026-07-15T10:02:00.000Z'
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        const replacedAcceptedReceipt = yield* insertTransition({
          commandId: "accepted-replaced",
          commandProviderOperationId: "unrelated-operation",
          commandReconciliationKey: "unrelated-reconciliation",
          commandTag: "recordAccepted",
          fromState: "started",
          occurredAt: "2026-07-15T10:03:00.000Z",
          previousTransitionId: fourthTransitionId,
          resultLineageJson: "{\"_tag\":\"accepted\"}",
          resultLineageKind: "accepted",
          resultProviderOperationId: "unrelated-operation",
          resultReconciliationKey: "unrelated-reconciliation",
          sequence: 5,
          toState: "started",
          transitionId: fifthTransitionId
        }).pipe(Effect.result)
        const droppedCancellationLineage = yield* insertTransition({
          commandId: "cancel-dropped-lineage",
          commandTag: "requestCancellation",
          fromState: "started",
          occurredAt: "2026-07-15T10:03:00.000Z",
          previousTransitionId: fourthTransitionId,
          resultLineageJson: "{\"_tag\":\"none\"}",
          resultLineageKind: "none",
          sequence: 5,
          toState: "cancel-requested",
          transitionId: fifthTransitionId
        }).pipe(Effect.result)
        const unrelatedProviderTerminal = yield* insertTransition({
          commandId: "provider-terminal-unrelated",
          commandProviderOperationId: "unrelated-operation",
          commandTag: "recordSucceeded",
          commandTerminalStatus: "succeeded",
          fromState: "started",
          occurredAt: "2026-07-15T10:03:00.000Z",
          outcomeSourceKind: "providerOperation",
          previousTransitionId: fourthTransitionId,
          resultLineageJson: "{\"_tag\":\"terminal\"}",
          resultLineageKind: "terminal",
          resultProviderOperationId: "unrelated-operation",
          resultTerminalStatus: "succeeded",
          sequence: 5,
          toState: "succeeded",
          transitionId: fifthTransitionId
        }).pipe(Effect.result)
        const droppedManualUnknownKey = yield* insertTransition({
          commandId: "unknown-manual-dropped-key",
          commandTag: "recordUnknown",
          commandUnknownKind: "manual",
          fromState: "started",
          occurredAt: "2026-07-15T10:03:00.000Z",
          previousTransitionId: fourthTransitionId,
          resultLineageJson: "{\"_tag\":\"manual\"}",
          resultLineageKind: "manual",
          resultProviderOperationId: providerOperationId,
          sequence: 5,
          toState: "unknown",
          transitionId: fifthTransitionId
        }).pipe(Effect.result)
        yield* insertTransition({
          commandId: "unknown-1",
          commandTag: "recordUnknown",
          commandUnknownKind: "manual",
          fromState: "started",
          occurredAt: "2026-07-15T10:03:00.000Z",
          previousTransitionId: fourthTransitionId,
          resultLineageJson: "{\"_tag\":\"reconcilable\"}",
          resultLineageKind: "reconcilable",
          resultProviderOperationId: providerOperationId,
          resultReconciliationKey: reconciliationKey,
          sequence: 5,
          toState: "unknown",
          transitionId: fifthTransitionId
        })
        yield* insertAudit({
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000038",
          causeKind: "system",
          eventKind: "unknown",
          occurredAt: "2026-07-15T10:03:00.000Z",
          systemComponent: "governed-action-engine",
          transitionId: fifthTransitionId
        })
        yield* sql`UPDATE governed_actions
          SET state = 'unknown', lineage_json = '{"_tag":"reconcilable"}',
              lineage_kind = 'reconcilable', provider_operation_id = ${providerOperationId},
              reconciliation_key = ${reconciliationKey}, terminal_status = NULL,
              head_transition_id = ${fifthTransitionId}, head_sequence = 5,
              updated_at = '2026-07-15T10:03:00.000Z'
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        const directUnknownSuccess = yield* insertTransition({
          commandId: "unknown-direct-success",
          commandProviderOperationId: providerOperationId,
          commandTag: "recordSucceeded",
          commandTerminalStatus: "succeeded",
          fromState: "unknown",
          occurredAt: "2026-07-15T10:04:00.000Z",
          outcomeSourceKind: "direct",
          previousTransitionId: fifthTransitionId,
          resultLineageJson: "{\"_tag\":\"terminal\"}",
          resultLineageKind: "terminal",
          resultProviderOperationId: providerOperationId,
          resultTerminalStatus: "succeeded",
          sequence: 6,
          toState: "succeeded",
          transitionId: sixthTransitionId
        }).pipe(Effect.result)
        yield* insertTransition({
          commandId: "unknown-reconciled-success",
          commandProviderOperationId: providerOperationId,
          commandReconciliationKey: reconciliationKey,
          commandTag: "recordSucceeded",
          commandTerminalStatus: "succeeded",
          fromState: "unknown",
          occurredAt: "2026-07-15T10:04:00.000Z",
          outcomeSourceKind: "reconciliation",
          previousTransitionId: fifthTransitionId,
          resultLineageJson: "{\"_tag\":\"terminal\"}",
          resultLineageKind: "terminal",
          resultProviderOperationId: providerOperationId,
          resultTerminalStatus: "succeeded",
          sequence: 6,
          toState: "succeeded",
          transitionId: sixthTransitionId
        })
        yield* insertAudit({
          auditEventId: "01890f6f-6d6a-7cc0-98d2-320000000039",
          causeKind: "system",
          eventKind: "succeeded",
          occurredAt: "2026-07-15T10:04:00.000Z",
          systemComponent: "governed-action-engine",
          transitionId: sixthTransitionId
        })
        const unrelatedTerminalReceipt = yield* sql`UPDATE governed_actions
          SET state = 'succeeded', lineage_json = '{"_tag":"terminal"}', lineage_kind = 'terminal',
              provider_operation_id = 'unrelated-operation', reconciliation_key = NULL,
              terminal_status = 'succeeded', head_transition_id = ${sixthTransitionId}, head_sequence = 6,
              updated_at = '2026-07-15T10:04:00.000Z'
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`.pipe(Effect.result)
        yield* sql`UPDATE governed_actions
          SET state = 'succeeded', lineage_json = '{"_tag":"terminal"}', lineage_kind = 'terminal',
              provider_operation_id = ${providerOperationId}, reconciliation_key = NULL,
              terminal_status = 'succeeded', head_transition_id = ${sixthTransitionId}, head_sequence = 6,
              updated_at = '2026-07-15T10:04:00.000Z'
          WHERE workspace_id = ${workspaceId} AND action_id = ${actionId}`

        assert.isTrue(Result.isFailure(directInitialSuccess))
        assert.isTrue(Result.isFailure(regressiveAuthorization))
        assert.isTrue(Result.isFailure(skippedStart))
        assert.isTrue(Result.isFailure(wrongSystemAudit))
        assert.isTrue(Result.isFailure(humanAuditForSystemTransition))
        assert.isTrue(Result.isFailure(splicedStartedLineage))
        assert.isTrue(Result.isFailure(droppedAcceptedReceipt))
        assert.isTrue(Result.isFailure(replacedAcceptedReceipt))
        assert.isTrue(Result.isFailure(droppedCancellationLineage))
        assert.isTrue(Result.isFailure(unrelatedProviderTerminal))
        assert.isTrue(Result.isFailure(droppedManualUnknownKey))
        assert.isTrue(Result.isFailure(directUnknownSuccess))
        assert.isTrue(Result.isFailure(unrelatedTerminalReceipt))
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
