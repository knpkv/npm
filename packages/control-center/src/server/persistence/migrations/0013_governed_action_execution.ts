import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const immutableTable = (sql: SqlClient.SqlClient, table: string) =>
  Effect.forEach(["UPDATE", "DELETE"], (operation) =>
    sql.unsafe(`CREATE TRIGGER ${table}_no_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} is immutable');
      END`), { discard: true })

/** Add durable preparation, dispatch-lease, recovery-claim, and provider-outcome coordination. */
export const migration0013GovernedActionExecution = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE governed_action_execution_preparations (
    preparation_token_digest TEXT PRIMARY KEY CHECK(
      length(preparation_token_digest) = 64
        AND preparation_token_digest NOT GLOB '*[^0-9a-f]*'
    ),
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    expected_head_transition_id TEXT NOT NULL,
    expected_envelope_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (workspace_id, action_id, preparation_token_digest),
    FOREIGN KEY (workspace_id, action_id, expected_head_transition_id)
      REFERENCES governed_action_transitions(workspace_id, action_id, transition_id),
    FOREIGN KEY (workspace_id, action_id, expected_envelope_digest)
      REFERENCES governed_actions(workspace_id, action_id, envelope_digest),
    CHECK(created_at < expires_at)
  )`

  yield* sql`CREATE INDEX governed_action_execution_preparations_expiry_idx
    ON governed_action_execution_preparations(expires_at, workspace_id, action_id)`

  yield* sql`CREATE TRIGGER governed_action_execution_preparation_exact_head
    BEFORE INSERT ON governed_action_execution_preparations
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_actions action
      JOIN governed_action_transitions transition_record
        ON transition_record.workspace_id = action.workspace_id
        AND transition_record.action_id = action.action_id
        AND transition_record.transition_id = action.head_transition_id
      WHERE action.workspace_id = NEW.workspace_id
        AND action.action_id = NEW.action_id
        AND action.state = 'authorized'
        AND action.head_transition_id = NEW.expected_head_transition_id
        AND action.envelope_digest = NEW.expected_envelope_digest
        AND transition_record.to_state = 'authorized'
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action execution preparation requires the current authorized head');
    END`

  yield* sql`CREATE TABLE governed_action_execution_leases (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    start_transition_id TEXT NOT NULL,
    permit_token_digest TEXT NOT NULL CHECK(
      length(permit_token_digest) = 64 AND permit_token_digest NOT GLOB '*[^0-9a-f]*'
    ),
    runtime_authority_token TEXT NOT NULL CHECK(length(runtime_authority_token) BETWEEN 1 AND 512),
    recovery_capability_version INTEGER NOT NULL CHECK(recovery_capability_version = 1),
    created_at TEXT NOT NULL,
    dispatch_deadline TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    recovery_eligible_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id),
    UNIQUE (workspace_id, action_id, attempt_id),
    UNIQUE (permit_token_digest),
    UNIQUE (workspace_id, action_id, permit_token_digest),
    FOREIGN KEY (workspace_id, action_id, attempt_id)
      REFERENCES governed_action_attempts(workspace_id, action_id, attempt_id),
    FOREIGN KEY (workspace_id, action_id, start_transition_id)
      REFERENCES governed_action_transitions(workspace_id, action_id, transition_id),
    CHECK(created_at <= dispatch_deadline),
    CHECK(dispatch_deadline < lease_expires_at),
    CHECK(lease_expires_at < recovery_eligible_at)
  )`

  yield* sql`CREATE INDEX governed_action_execution_recovery_idx
    ON governed_action_execution_leases(recovery_eligible_at, workspace_id, action_id)`

  yield* sql`CREATE TRIGGER governed_action_execution_lease_exact_start
    BEFORE INSERT ON governed_action_execution_leases
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_actions action
      JOIN governed_action_transitions transition_record
        ON transition_record.workspace_id = action.workspace_id
        AND transition_record.action_id = action.action_id
        AND transition_record.transition_id = NEW.start_transition_id
      WHERE action.workspace_id = NEW.workspace_id
        AND action.action_id = NEW.action_id
        AND action.state = 'started'
        AND action.head_transition_id = NEW.start_transition_id
        AND transition_record.command_tag = 'start'
        AND transition_record.attempt_id = NEW.attempt_id
        AND transition_record.occurred_at = NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action execution lease requires its exact start transition');
    END`

  yield* sql`CREATE TABLE governed_action_recovery_claims (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    claim_sequence INTEGER NOT NULL CHECK(claim_sequence >= 1),
    claim_token_digest TEXT NOT NULL CHECK(
      length(claim_token_digest) = 64 AND claim_token_digest NOT GLOB '*[^0-9a-f]*'
    ),
    claimed_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id, claim_sequence),
    UNIQUE (claim_token_digest),
    UNIQUE (workspace_id, action_id, claim_token_digest),
    FOREIGN KEY (workspace_id, action_id)
      REFERENCES governed_action_execution_leases(workspace_id, action_id),
    CHECK(claimed_at < lease_expires_at)
  )`

  yield* sql`CREATE TRIGGER governed_action_recovery_claim_exact_sequence
    BEFORE INSERT ON governed_action_recovery_claims
    WHEN NOT (
      (NEW.claim_sequence = 1 AND NOT EXISTS (
        SELECT 1 FROM governed_action_recovery_claims existing
        WHERE existing.workspace_id = NEW.workspace_id AND existing.action_id = NEW.action_id
      )) OR
      EXISTS (
        SELECT 1 FROM governed_action_recovery_claims previous
        WHERE previous.workspace_id = NEW.workspace_id
          AND previous.action_id = NEW.action_id
          AND previous.claim_sequence = NEW.claim_sequence - 1
          AND previous.lease_expires_at <= NEW.claimed_at
          AND NOT EXISTS (
            SELECT 1 FROM governed_action_recovery_claims later
            WHERE later.workspace_id = NEW.workspace_id
              AND later.action_id = NEW.action_id
              AND later.claim_sequence >= NEW.claim_sequence
          )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action recovery claim must follow the expired latest claim');
    END`

  yield* sql`CREATE TRIGGER governed_action_recovery_claim_after_safety_interval
    BEFORE INSERT ON governed_action_recovery_claims
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_action_execution_leases execution
      JOIN governed_actions action
        ON action.workspace_id = execution.workspace_id
        AND action.action_id = execution.action_id
      WHERE execution.workspace_id = NEW.workspace_id
        AND execution.action_id = NEW.action_id
        AND execution.recovery_eligible_at <= NEW.claimed_at
        AND action.state IN ('started', 'cancel-requested', 'unknown', 'cancel-requested-unknown')
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action recovery cannot begin before its safety interval');
    END`

  yield* sql`CREATE INDEX governed_action_recovery_claim_expiry_idx
    ON governed_action_recovery_claims(lease_expires_at, workspace_id, action_id, claim_sequence)`

  yield* sql`CREATE TABLE governed_action_provider_outcomes (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    outcome_id TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('dispatch', 'reconciliation')),
    permit_token_digest TEXT,
    recovery_claim_token_digest TEXT,
    result_kind TEXT NOT NULL CHECK(result_kind IN (
      'accepted', 'succeeded', 'failed', 'cancelled', 'unknown', 'manual-unknown',
      'pending', 'recovery-unavailable'
    )),
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    outcome_json TEXT NOT NULL CHECK(length(outcome_json) BETWEEN 2 AND 262144),
    outcome_digest TEXT NOT NULL CHECK(
      length(outcome_digest) = 64 AND outcome_digest NOT GLOB '*[^0-9a-f]*'
    ),
    expected_command_digest TEXT NOT NULL CHECK(
      length(expected_command_digest) = 71
        AND expected_command_digest GLOB 'sha256:*'
        AND substr(expected_command_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id, outcome_id),
    UNIQUE (permit_token_digest),
    UNIQUE (recovery_claim_token_digest),
    FOREIGN KEY (workspace_id, action_id)
      REFERENCES governed_actions(workspace_id, action_id),
    FOREIGN KEY (workspace_id, action_id, permit_token_digest)
      REFERENCES governed_action_execution_leases(workspace_id, action_id, permit_token_digest),
    FOREIGN KEY (workspace_id, action_id, recovery_claim_token_digest)
      REFERENCES governed_action_recovery_claims(workspace_id, action_id, claim_token_digest),
    CHECK(observed_at <= received_at),
    CHECK(
      (source_kind = 'dispatch' AND permit_token_digest IS NOT NULL
        AND recovery_claim_token_digest IS NULL
        AND result_kind IN (
          'accepted', 'succeeded', 'failed', 'cancelled', 'unknown', 'manual-unknown'
        )) OR
      (source_kind = 'reconciliation' AND permit_token_digest IS NULL
        AND recovery_claim_token_digest IS NOT NULL
        AND result_kind IN (
          'pending', 'succeeded', 'failed', 'cancelled', 'recovery-unavailable'
        ))
    )
  )`

  yield* sql`CREATE INDEX governed_action_provider_outcomes_received_idx
    ON governed_action_provider_outcomes(received_at, workspace_id, action_id)`

  yield* sql`CREATE TABLE governed_action_provider_outcome_folds (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    outcome_id TEXT NOT NULL,
    transition_id TEXT NOT NULL,
    folded_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id, outcome_id),
    UNIQUE (workspace_id, action_id, transition_id),
    FOREIGN KEY (workspace_id, action_id, outcome_id)
      REFERENCES governed_action_provider_outcomes(workspace_id, action_id, outcome_id),
    FOREIGN KEY (workspace_id, action_id, transition_id)
      REFERENCES governed_action_transitions(workspace_id, action_id, transition_id)
  )`

  yield* sql`CREATE TRIGGER governed_action_provider_outcome_fold_order
    BEFORE INSERT ON governed_action_provider_outcome_folds
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_action_provider_outcomes outcome
      JOIN governed_actions action
        ON action.workspace_id = outcome.workspace_id
        AND action.action_id = outcome.action_id
      JOIN governed_action_transitions transition_record
        ON transition_record.workspace_id = outcome.workspace_id
        AND transition_record.action_id = outcome.action_id
        AND transition_record.transition_id = NEW.transition_id
      WHERE outcome.workspace_id = NEW.workspace_id
        AND outcome.action_id = NEW.action_id
        AND outcome.outcome_id = NEW.outcome_id
        AND action.head_transition_id = NEW.transition_id
        AND outcome.received_at <= NEW.folded_at
        AND outcome.observed_at <= transition_record.occurred_at
        AND transition_record.occurred_at <= NEW.folded_at
        AND outcome.expected_command_digest = transition_record.command_digest
        AND (
          (outcome.result_kind = 'accepted' AND transition_record.command_tag = 'recordAccepted') OR
          (outcome.result_kind = 'succeeded' AND transition_record.command_tag = 'recordSucceeded') OR
          (outcome.result_kind = 'failed' AND transition_record.command_tag = 'recordFailed') OR
          (outcome.result_kind = 'cancelled' AND transition_record.command_tag = 'recordCancelled') OR
          (outcome.result_kind IN ('unknown', 'manual-unknown', 'recovery-unavailable')
            AND transition_record.command_tag = 'recordUnknown') OR
          (outcome.result_kind = 'pending'
            AND transition_record.command_tag = 'reconciliationPending')
        )
        AND (
          outcome.result_kind NOT IN ('succeeded', 'failed', 'cancelled') OR
          (outcome.source_kind = 'reconciliation'
            AND transition_record.outcome_source_kind = 'reconciliation') OR
          (outcome.source_kind = 'dispatch'
            AND transition_record.outcome_source_kind IN ('direct', 'providerOperation'))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action provider outcome cannot fold before receipt and transition');
    END`

  yield* sql`CREATE TRIGGER governed_action_execution_preparations_no_update
    BEFORE UPDATE ON governed_action_execution_preparations
    BEGIN
      SELECT RAISE(ABORT, 'governed action execution preparation is immutable');
    END`

  yield* immutableTable(sql, "governed_action_execution_leases")
  yield* immutableTable(sql, "governed_action_recovery_claims")
  yield* immutableTable(sql, "governed_action_provider_outcomes")
  yield* immutableTable(sql, "governed_action_provider_outcome_folds")
})
