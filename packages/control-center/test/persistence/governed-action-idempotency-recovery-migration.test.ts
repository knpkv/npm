import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { assert, describe, it } from "@effect/vitest"
import type { FileSystem, Scope } from "effect"
import { Effect, Exit, Result } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR } from "../../src/server/persistence/governedActionReconciliationLocator.js"
import { migration0015GovernedActionIdempotencyRecovery } from "../../src/server/persistence/migrations/0015_governed_action_idempotency_recovery.js"
import { makePersistenceTestConfig } from "./fixtures.js"

const WORKSPACE_ID = "workspace-1"
const ACTION_ID = "action-1"
const LEGACY_TRANSITION_ID = "transition-legacy-unknown"
const PENDING_TRANSITION_ID = "transition-pending"
const LEGACY_DIGEST = `sha256:${"a".repeat(64)}`
const PENDING_DIGEST = `sha256:${"b".repeat(64)}`

const createVersionFourteenFixture = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE sessions (
      workspace_id TEXT, session_id TEXT, actor_kind TEXT, person_id TEXT,
      revoked_at TEXT, created_at TEXT, last_seen_at TEXT, idle_expires_at TEXT,
      absolute_expires_at TEXT
    )`
    yield* sql`CREATE TABLE governed_action_authorizations (
      workspace_id TEXT, action_id TEXT, authorization_id TEXT, session_id TEXT, authorized_at TEXT
    )`
    yield* sql`CREATE TABLE governed_action_attempts (
      workspace_id TEXT, action_id TEXT, attempt_id TEXT, started_at TEXT
    )`
    yield* sql`CREATE TABLE governed_actions (
      workspace_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      envelope_digest TEXT,
      created_at TEXT,
      state TEXT,
      lineage_json TEXT,
      lineage_kind TEXT,
      provider_operation_id TEXT,
      reconciliation_key TEXT,
      terminal_status TEXT,
      head_transition_id TEXT,
      head_sequence INTEGER,
      updated_at TEXT,
      PRIMARY KEY (workspace_id, action_id)
    )`
    yield* sql`CREATE TABLE governed_action_transitions (
      workspace_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      transition_id TEXT NOT NULL,
      previous_transition_id TEXT,
      sequence INTEGER,
      command_tag TEXT,
      authorization_id TEXT,
      attempt_id TEXT,
      outcome_source_kind TEXT,
      command_provider_operation_id TEXT,
      command_reconciliation_key TEXT,
      command_terminal_status TEXT,
      command_unknown_kind TEXT,
      command_digest TEXT,
      envelope_digest TEXT,
      from_state TEXT,
      to_state TEXT,
      result_lineage_json TEXT,
      result_lineage_kind TEXT,
      result_provider_operation_id TEXT,
      result_reconciliation_key TEXT,
      result_terminal_status TEXT,
      cause_kind TEXT,
      cause_actor_id TEXT,
      cause_session_id TEXT,
      occurred_at TEXT,
      PRIMARY KEY (workspace_id, action_id, transition_id)
    )`
    yield* sql`CREATE TABLE governed_action_provider_outcomes (
      workspace_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      source_kind TEXT,
      result_kind TEXT,
      expected_command_digest TEXT,
      observed_at TEXT,
      received_at TEXT,
      PRIMARY KEY (workspace_id, action_id, outcome_id)
    )`
    yield* sql`CREATE TABLE governed_action_provider_outcome_folds (
      workspace_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      transition_id TEXT NOT NULL,
      folded_at TEXT NOT NULL
    )`
    yield* sql`CREATE TRIGGER governed_action_transition_exact_append
      BEFORE INSERT ON governed_action_transitions WHEN 0
      BEGIN SELECT 1; END`
    yield* sql`CREATE TRIGGER governed_action_provider_outcome_fold_order
      BEFORE INSERT ON governed_action_provider_outcome_folds WHEN 0
      BEGIN SELECT 1; END`
  })

const withFixture = <Success, Failure>(
  use: Effect.Effect<Success, Failure, FileSystem.FileSystem | Scope.Scope | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-idempotency-recovery-migration-")
    return yield* use.pipe(
      Effect.provide(LibsqlClient.layer({ url: config.databaseUrl })),
      Effect.scoped
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

describe("governed action idempotency recovery migration", () => {
  it.effect("preserves only historical recovery-unavailable recordUnknown folds", () =>
    withFixture(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* createVersionFourteenFixture(sql)
      yield* sql`INSERT INTO governed_actions (
        workspace_id, action_id, envelope_digest, created_at, state, lineage_json,
        lineage_kind, provider_operation_id, reconciliation_key, terminal_status,
        head_transition_id, head_sequence, updated_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'envelope-1', '2026-07-15T10:00:00.000Z',
        'unknown', '{}', 'manual', NULL, NULL, NULL,
        ${LEGACY_TRANSITION_ID}, 1, '2026-07-15T10:03:00.000Z'
      )`
      yield* sql`INSERT INTO governed_action_transitions (
        workspace_id, action_id, transition_id, command_tag, command_digest,
        outcome_source_kind, occurred_at
      ) VALUES
        (${WORKSPACE_ID}, ${ACTION_ID}, ${LEGACY_TRANSITION_ID},
          'recordUnknown', ${LEGACY_DIGEST}, NULL, '2026-07-15T10:03:00.000Z'),
        (${WORKSPACE_ID}, ${ACTION_ID}, ${PENDING_TRANSITION_ID},
          'reconciliationPending', ${PENDING_DIGEST}, NULL, '2026-07-15T10:04:00.000Z')`
      yield* sql`INSERT INTO governed_action_provider_outcomes (
        workspace_id, action_id, outcome_id, source_kind, result_kind,
        expected_command_digest, observed_at, received_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'legacy-unavailable', 'reconciliation',
        'recovery-unavailable', ${LEGACY_DIGEST},
        '2026-07-15T10:02:00.000Z', '2026-07-15T10:02:01.000Z'
      )`

      yield* migration0015GovernedActionIdempotencyRecovery
      yield* sql`INSERT INTO governed_action_provider_outcome_folds (
        workspace_id, action_id, outcome_id, transition_id, folded_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'legacy-unavailable',
        ${LEGACY_TRANSITION_ID}, '2026-07-15T10:03:00.000Z'
      )`

      yield* sql`INSERT INTO governed_action_provider_outcomes (
        workspace_id, action_id, outcome_id, source_kind, result_kind,
        expected_command_digest, observed_at, received_at
      ) VALUES
        (${WORKSPACE_ID}, ${ACTION_ID}, 'current-legacy-attempt', 'reconciliation',
          'recovery-unavailable', ${LEGACY_DIGEST},
          '2026-07-15T10:02:30.000Z', '2026-07-15T10:02:31.000Z'),
        (${WORKSPACE_ID}, ${ACTION_ID}, 'current-unavailable', 'reconciliation',
          'recovery-unavailable', ${PENDING_DIGEST},
          '2026-07-15T10:03:30.000Z', '2026-07-15T10:03:31.000Z')`
      const currentThroughLegacy = yield* sql`INSERT INTO governed_action_provider_outcome_folds (
        workspace_id, action_id, outcome_id, transition_id, folded_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'current-legacy-attempt',
        ${LEGACY_TRANSITION_ID}, '2026-07-15T10:04:00.000Z'
      )`.pipe(Effect.result)
      yield* sql`UPDATE governed_actions
        SET head_transition_id = ${PENDING_TRANSITION_ID}, updated_at = '2026-07-15T10:04:00.000Z'
        WHERE workspace_id = ${WORKSPACE_ID} AND action_id = ${ACTION_ID}`
      yield* sql`INSERT INTO governed_action_provider_outcome_folds (
        workspace_id, action_id, outcome_id, transition_id, folded_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'current-unavailable',
        ${PENDING_TRANSITION_ID}, '2026-07-15T10:04:00.000Z'
      )`

      assert.isTrue(Result.isFailure(currentThroughLegacy))
    })))

  it.effect("rejects reserved locator misuse and rolls back a collision upgrade", () =>
    withFixture(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* createVersionFourteenFixture(sql)
      yield* sql`INSERT INTO governed_actions (
        workspace_id, action_id, envelope_digest, created_at, state, lineage_json,
        lineage_kind, provider_operation_id, reconciliation_key, terminal_status,
        head_transition_id, head_sequence, updated_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'envelope-1', '2026-07-15T10:00:00.000Z',
        'started', '{}', 'none', NULL, NULL, NULL,
        ${LEGACY_TRANSITION_ID}, 1, '2026-07-15T10:01:00.000Z'
      )`
      yield* sql`INSERT INTO governed_action_transitions (
        workspace_id, action_id, transition_id, command_tag, command_digest,
        occurred_at, command_reconciliation_key
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, ${LEGACY_TRANSITION_ID}, 'start',
        ${LEGACY_DIGEST}, '2026-07-15T10:01:00.000Z', NULL
      )`
      yield* migration0015GovernedActionIdempotencyRecovery

      const reservedMisuse = yield* sql`INSERT INTO governed_action_transitions (
        workspace_id, action_id, transition_id, previous_transition_id, sequence,
        command_tag, command_provider_operation_id, command_reconciliation_key,
        envelope_digest, from_state, to_state, result_lineage_json,
        result_lineage_kind, result_provider_operation_id, result_reconciliation_key,
        cause_kind, occurred_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'misused-reserved-locator', ${LEGACY_TRANSITION_ID}, 2,
        'recordAccepted', 'provider-operation-1',
        ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}, 'envelope-1',
        'started', 'started', '{}', 'accepted', 'provider-operation-1',
        ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}, 'system',
        '2026-07-15T10:02:00.000Z'
      )`.pipe(Effect.result)
      const reservedUnknownMisuse = yield* sql`INSERT INTO governed_action_transitions (
        workspace_id, action_id, transition_id, previous_transition_id, sequence,
        command_tag, command_reconciliation_key, command_unknown_kind,
        envelope_digest, from_state, to_state, result_lineage_json,
        result_lineage_kind, result_reconciliation_key, cause_kind, occurred_at
      ) VALUES (
        ${WORKSPACE_ID}, ${ACTION_ID}, 'misused-reserved-unknown', ${LEGACY_TRANSITION_ID}, 2,
        'recordUnknown', ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}, 'reconcilable',
        'envelope-1', 'started', 'unknown', '{}', 'reconcilable',
        ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}, 'system',
        '2026-07-15T10:02:00.000Z'
      )`.pipe(Effect.result)
      assert.isTrue(Result.isFailure(reservedMisuse))
      assert.isTrue(Result.isFailure(reservedUnknownMisuse))

      const collisionConfig = yield* makePersistenceTestConfig("control-center-idempotency-collision-")
      const collision = yield* Effect.gen(function*() {
        const collisionSql = yield* SqlClient.SqlClient
        yield* createVersionFourteenFixture(collisionSql)
        const versionFourteen = LibsqlMigrator.fromRecord({ "0014_previous": Effect.void })
        yield* LibsqlMigrator.run({ loader: versionFourteen, table: "migration_ledger" })
        yield* collisionSql`INSERT INTO governed_action_transitions (
          workspace_id, action_id, transition_id, command_reconciliation_key
        ) VALUES (
          ${WORKSPACE_ID}, ${ACTION_ID}, 'colliding-transition',
          ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}
        )`
        const latest = LibsqlMigrator.fromRecord({
          "0014_previous": Effect.void,
          "0015_governed_action_idempotency_recovery": migration0015GovernedActionIdempotencyRecovery
        })
        const upgrade = yield* LibsqlMigrator.run({ loader: latest, table: "migration_ledger" }).pipe(
          Effect.exit
        )
        const ledger = yield* collisionSql<{ readonly migrationId: number }>`SELECT
          migration_id AS migrationId FROM migration_ledger ORDER BY migration_id`
        const schema = yield* collisionSql<{ readonly name: string }>`SELECT name FROM sqlite_master
          WHERE name IN (
            'governed_action_transition_exact_append',
            'governed_action_provider_outcome_fold_order',
            'governed_action_transition_reserved_reconciliation_locator',
            'governed_action_legacy_recovery_unavailable_outcomes'
          ) ORDER BY name`
        return { ledger, schema, upgrade }
      }).pipe(
        Effect.provide(LibsqlClient.layer({ url: collisionConfig.databaseUrl })),
        Effect.scoped
      )

      assert.isTrue(Exit.isFailure(collision.upgrade))
      assert.deepStrictEqual(collision.ledger, [{ migrationId: 14 }])
      assert.deepStrictEqual(collision.schema, [
        { name: "governed_action_provider_outcome_fold_order" },
        { name: "governed_action_transition_exact_append" }
      ])
    })))
})
