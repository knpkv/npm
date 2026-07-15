import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { migration0013GovernedActionExecution } from "../../src/server/persistence/migrations/0013_governed_action_execution.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = "01890f6f-6d6a-7cc0-98d2-330000000001"
const ACTION_ID = "01890f6f-6d6a-7cc0-98d2-330000000002"
const ATTEMPT_ID = "01890f6f-6d6a-7cc0-98d2-330000000003"
const AUTHORIZED_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-330000000004"
const START_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-330000000005"
const OUTCOME_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-330000000006"
const WRONG_OUTCOME_TRANSITION_ID = "01890f6f-6d6a-7cc0-98d2-330000000007"
const ENVELOPE_DIGEST = `sha256:${"a".repeat(64)}`
const PREPARATION_DIGEST = "b".repeat(64)
const PERMIT_DIGEST = "c".repeat(64)
const FIRST_CLAIM_DIGEST = "e".repeat(64)
const SECOND_CLAIM_DIGEST = "f".repeat(64)
const OUTCOME_DIGEST = "1".repeat(64)
const COMMAND_DIGEST = `sha256:${"2".repeat(64)}`
const WRONG_COMMAND_DIGEST = `sha256:${"3".repeat(64)}`

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase())

const createParentSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE governed_actions (
      workspace_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      envelope_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      head_transition_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, action_id),
      UNIQUE (workspace_id, action_id, envelope_digest)
    )`
    yield* sql`CREATE TABLE governed_action_transitions (
      workspace_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      transition_id TEXT NOT NULL,
      to_state TEXT NOT NULL,
      command_tag TEXT NOT NULL,
      attempt_id TEXT,
      outcome_source_kind TEXT,
      command_digest TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, action_id, transition_id)
    )`
    yield* sql`CREATE TABLE governed_action_attempts (
      workspace_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      PRIMARY KEY (workspace_id, action_id, attempt_id)
    )`
    yield* migration0013GovernedActionExecution.pipe(
      Effect.provideService(SqlClient.SqlClient, sql)
    )
  })

const insertLease = (sql: SqlClient.SqlClient, dispatchDeadline: string) =>
  sql`INSERT INTO governed_action_execution_leases (
    workspace_id, action_id, attempt_id, start_transition_id,
    permit_token_digest, runtime_authority_token,
    recovery_capability_version, created_at, dispatch_deadline,
    lease_expires_at, recovery_eligible_at
  ) VALUES (
    ${WORKSPACE_ID}, ${ACTION_ID}, ${ATTEMPT_ID}, ${START_TRANSITION_ID},
    ${PERMIT_DIGEST}, 'runtime-generation-a', 1,
    '2026-07-15T10:01:00.000Z', ${dispatchDeadline},
    '2026-07-15T10:02:00.000Z', '2026-07-15T10:03:00.000Z'
  )`

describe("governed action execution migration", () => {
  it.effect("fences dispatch and recovery timing and preserves the provider outcome inbox", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-governed-execution-")
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* createParentSchema(sql)
        yield* sql`INSERT INTO governed_action_transitions (
          workspace_id, action_id, transition_id, to_state, command_tag, attempt_id,
          outcome_source_kind, command_digest, occurred_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, ${AUTHORIZED_TRANSITION_ID},
          'authorized', 'authorize', NULL, NULL, ${WRONG_COMMAND_DIGEST},
          '2026-07-15T10:00:00.000Z'
        )`
        yield* sql`INSERT INTO governed_actions (
          workspace_id, action_id, envelope_digest, state, head_transition_id
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, ${ENVELOPE_DIGEST},
          'authorized', ${AUTHORIZED_TRANSITION_ID}
        )`
        yield* sql`INSERT INTO governed_action_execution_preparations (
          preparation_token_digest, workspace_id, action_id, expected_head_transition_id,
          expected_envelope_digest, created_at, expires_at
        ) VALUES (
          ${PREPARATION_DIGEST}, ${WORKSPACE_ID}, ${ACTION_ID}, ${AUTHORIZED_TRANSITION_ID},
          ${ENVELOPE_DIGEST}, '2026-07-15T10:00:00.000Z', '2026-07-15T10:01:00.000Z'
        )`

        yield* sql`INSERT INTO governed_action_attempts (
          workspace_id, action_id, attempt_id
        ) VALUES (${WORKSPACE_ID}, ${ACTION_ID}, ${ATTEMPT_ID})`
        yield* sql`INSERT INTO governed_action_transitions (
          workspace_id, action_id, transition_id, to_state, command_tag, attempt_id,
          outcome_source_kind, command_digest, occurred_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, ${START_TRANSITION_ID},
          'started', 'start', ${ATTEMPT_ID}, NULL, ${WRONG_COMMAND_DIGEST},
          '2026-07-15T10:01:00.000Z'
        )`
        yield* sql`UPDATE governed_actions
          SET state = 'started', head_transition_id = ${START_TRANSITION_ID}
          WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`

        const invalidDeadline = yield* insertLease(
          sql,
          "2026-07-15T10:02:00.000Z"
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(invalidDeadline))
        yield* insertLease(sql, "2026-07-15T10:01:30.000Z")

        const earlyRecovery = yield* sql`INSERT INTO governed_action_recovery_claims (
          workspace_id, action_id, claim_sequence, claim_token_digest, claimed_at, lease_expires_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 1, ${FIRST_CLAIM_DIGEST},
          '2026-07-15T10:02:30.000Z', '2026-07-15T10:04:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(earlyRecovery))
        yield* sql`INSERT INTO governed_action_recovery_claims (
          workspace_id, action_id, claim_sequence, claim_token_digest, claimed_at, lease_expires_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 1, ${FIRST_CLAIM_DIGEST},
          '2026-07-15T10:03:00.000Z', '2026-07-15T10:04:00.000Z'
        )`
        const overlappingRecovery = yield* sql`INSERT INTO governed_action_recovery_claims (
          workspace_id, action_id, claim_sequence, claim_token_digest, claimed_at, lease_expires_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 2, ${SECOND_CLAIM_DIGEST},
          '2026-07-15T10:03:30.000Z', '2026-07-15T10:05:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(overlappingRecovery))

        yield* sql`INSERT INTO governed_action_provider_outcomes (
          workspace_id, action_id, outcome_id, source_kind, permit_token_digest,
          recovery_claim_token_digest, result_kind, schema_version, outcome_json,
          outcome_digest, expected_command_digest, observed_at, received_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 'dispatch-outcome-1', 'dispatch', ${PERMIT_DIGEST},
          NULL, 'succeeded', 1, '{}', ${OUTCOME_DIGEST}, ${COMMAND_DIGEST},
          '2026-07-15T10:01:20.000Z', '2026-07-15T10:01:21.000Z'
        )`
        const conflictingReplay = yield* sql`INSERT INTO governed_action_provider_outcomes (
          workspace_id, action_id, outcome_id, source_kind, permit_token_digest,
          recovery_claim_token_digest, result_kind, schema_version, outcome_json,
          outcome_digest, expected_command_digest, observed_at, received_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 'dispatch-outcome-2', 'dispatch', ${PERMIT_DIGEST},
          NULL, 'unknown', 1, '{}', ${"2".repeat(64)}, ${WRONG_COMMAND_DIGEST},
          '2026-07-15T10:01:20.000Z', '2026-07-15T10:01:21.000Z'
        )`.pipe(Effect.result)
        const mutatedInbox = yield* sql`UPDATE governed_action_provider_outcomes
          SET outcome_json = '{"changed":true}'
          WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`.pipe(Effect.result)
        const deletedInbox = yield* sql`DELETE FROM governed_action_provider_outcomes
          WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`.pipe(Effect.result)

        yield* sql`INSERT INTO governed_action_transitions (
          workspace_id, action_id, transition_id, to_state, command_tag, attempt_id,
          outcome_source_kind, command_digest, occurred_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, ${OUTCOME_TRANSITION_ID},
          'succeeded', 'recordSucceeded', NULL, 'direct', ${COMMAND_DIGEST},
          '2026-07-15T10:01:21.000Z'
        )`
        yield* sql`INSERT INTO governed_action_transitions (
          workspace_id, action_id, transition_id, to_state, command_tag, attempt_id,
          outcome_source_kind, command_digest, occurred_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, ${WRONG_OUTCOME_TRANSITION_ID},
          'succeeded', 'recordSucceeded', NULL, 'direct', ${WRONG_COMMAND_DIGEST},
          '2026-07-15T10:01:21.000Z'
        )`
        const wrongTransitionFold = yield* sql`INSERT INTO governed_action_provider_outcome_folds (
          workspace_id, action_id, outcome_id, transition_id, folded_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 'dispatch-outcome-1',
          ${START_TRANSITION_ID}, '2026-07-15T10:01:21.000Z'
        )`.pipe(Effect.result)
        yield* sql`UPDATE governed_actions
          SET state = 'succeeded', head_transition_id = ${WRONG_OUTCOME_TRANSITION_ID}
          WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`
        const wrongDigestFold = yield* sql`INSERT INTO governed_action_provider_outcome_folds (
          workspace_id, action_id, outcome_id, transition_id, folded_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 'dispatch-outcome-1',
          ${WRONG_OUTCOME_TRANSITION_ID}, '2026-07-15T10:01:21.000Z'
        )`.pipe(Effect.result)
        yield* sql`UPDATE governed_actions
          SET head_transition_id = ${OUTCOME_TRANSITION_ID}
          WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`
        const earlyFold = yield* sql`INSERT INTO governed_action_provider_outcome_folds (
          workspace_id, action_id, outcome_id, transition_id, folded_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 'dispatch-outcome-1',
          ${OUTCOME_TRANSITION_ID}, '2026-07-15T10:01:20.000Z'
        )`.pipe(Effect.result)
        yield* sql`INSERT INTO governed_action_provider_outcome_folds (
          workspace_id, action_id, outcome_id, transition_id, folded_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 'dispatch-outcome-1',
          ${OUTCOME_TRANSITION_ID}, '2026-07-15T10:01:21.000Z'
        )`
        const mutatedFold = yield* sql`UPDATE governed_action_provider_outcome_folds
          SET folded_at = '2026-07-15T10:01:22.000Z'
          WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`.pipe(Effect.result)

        assert.isTrue(Result.isFailure(conflictingReplay))
        assert.isTrue(Result.isFailure(mutatedInbox))
        assert.isTrue(Result.isFailure(deletedInbox))
        assert.isTrue(Result.isFailure(wrongTransitionFold))
        assert.isTrue(Result.isFailure(wrongDigestFold))
        assert.isTrue(Result.isFailure(earlyFold))
        assert.isTrue(Result.isFailure(mutatedFold))

        yield* sql`UPDATE governed_actions
          SET state = 'succeeded'
          WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`
        const terminalRecovery = yield* sql`INSERT INTO governed_action_recovery_claims (
          workspace_id, action_id, claim_sequence, claim_token_digest, claimed_at, lease_expires_at
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 2, ${SECOND_CLAIM_DIGEST},
          '2026-07-15T10:04:00.000Z', '2026-07-15T10:05:00.000Z'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(terminalRecovery))
      }).pipe(
        Effect.provide(LibsqlClient.layer({
          transformResultNames: snakeToCamel,
          url: config.databaseUrl
        })),
        Effect.scoped
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
