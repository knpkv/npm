import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR } from "../governedActionReconciliationLocator.js"

const idempotencyLocatorSql = `'${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}'`

/** Permit reconciliation by immutable action idempotency identity without weakening provider-key matching. */
export const migration0015GovernedActionIdempotencyRecovery = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TEMP TABLE governed_action_idempotency_locator_preflight (
    valid INTEGER NOT NULL CHECK(valid = 1)
  )`
  yield* sql`INSERT INTO governed_action_idempotency_locator_preflight (valid)
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM governed_actions
      WHERE reconciliation_key = ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}
      UNION ALL
      SELECT 1 FROM governed_action_transitions
      WHERE command_reconciliation_key = ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}
        OR result_reconciliation_key = ${PERSISTED_IDEMPOTENCY_RECONCILIATION_LOCATOR}
    ) THEN 0 ELSE 1 END`
  yield* sql`DROP TABLE governed_action_idempotency_locator_preflight`

  yield* sql`CREATE TABLE governed_action_legacy_recovery_unavailable_outcomes (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    outcome_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id, outcome_id),
    FOREIGN KEY (workspace_id, action_id, outcome_id)
      REFERENCES governed_action_provider_outcomes(workspace_id, action_id, outcome_id)
  )`
  yield* sql`INSERT INTO governed_action_legacy_recovery_unavailable_outcomes (
    workspace_id, action_id, outcome_id
  ) SELECT workspace_id, action_id, outcome_id
    FROM governed_action_provider_outcomes
    WHERE result_kind = 'recovery-unavailable'`
  yield* sql`CREATE TRIGGER governed_action_legacy_recovery_unavailable_outcomes_no_insert
    BEFORE INSERT ON governed_action_legacy_recovery_unavailable_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'legacy recovery outcome markers are migration-owned');
    END`
  yield* sql`CREATE TRIGGER governed_action_legacy_recovery_unavailable_outcomes_no_update
    BEFORE UPDATE ON governed_action_legacy_recovery_unavailable_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'legacy recovery outcome markers are immutable');
    END`
  yield* sql`CREATE TRIGGER governed_action_legacy_recovery_unavailable_outcomes_no_delete
    BEFORE DELETE ON governed_action_legacy_recovery_unavailable_outcomes
    BEGIN
      SELECT RAISE(ABORT, 'legacy recovery outcome markers are immutable');
    END`

  yield* sql`DROP TRIGGER governed_action_transition_exact_append`
  yield* sql.unsafe(`CREATE TRIGGER governed_action_transition_exact_append
    BEFORE INSERT ON governed_action_transitions
    WHEN NOT EXISTS (
      SELECT 1 FROM governed_actions action
      WHERE action.workspace_id = NEW.workspace_id
        AND action.action_id = NEW.action_id
        AND action.envelope_digest = NEW.envelope_digest
        AND NEW.occurred_at >= action.created_at
        AND (
          (NEW.cause_kind = 'human' AND EXISTS (
            SELECT 1 FROM sessions session
            WHERE session.workspace_id = NEW.workspace_id
              AND session.session_id = NEW.cause_session_id
              AND session.actor_kind = 'human'
              AND session.person_id = NEW.cause_actor_id
              AND session.revoked_at IS NULL
              AND session.created_at <= NEW.occurred_at
              AND session.last_seen_at <= NEW.occurred_at
              AND NEW.occurred_at < session.idle_expires_at
              AND NEW.occurred_at < session.absolute_expires_at
          )) OR NEW.cause_kind IN ('agent', 'system')
        )
        AND (
          NEW.command_tag <> 'authorize' OR EXISTS (
            SELECT 1 FROM governed_action_authorizations authorization
            WHERE authorization.workspace_id = NEW.workspace_id
              AND authorization.action_id = NEW.action_id
              AND authorization.authorization_id = NEW.authorization_id
              AND authorization.session_id = NEW.cause_session_id
              AND authorization.authorized_at = NEW.occurred_at
          )
        )
        AND (
          NEW.command_tag <> 'start' OR EXISTS (
            SELECT 1 FROM governed_action_attempts attempt
            WHERE attempt.workspace_id = NEW.workspace_id
              AND attempt.action_id = NEW.action_id
              AND attempt.attempt_id = NEW.attempt_id
              AND attempt.started_at = NEW.occurred_at
          )
        )
        AND (
          (NEW.command_tag = 'propose' AND NEW.result_lineage_kind = 'none') OR
          (NEW.command_tag IN (
            'authorize', 'deny', 'expire', 'cancel', 'start', 'requestCancellation'
          )
            AND NEW.result_lineage_json IS action.lineage_json
            AND NEW.result_lineage_kind IS action.lineage_kind
            AND NEW.result_provider_operation_id IS action.provider_operation_id
            AND NEW.result_reconciliation_key IS action.reconciliation_key
            AND NEW.result_terminal_status IS action.terminal_status) OR
          (NEW.command_tag = 'recordAccepted'
            AND NEW.result_lineage_kind = 'accepted'
            AND NEW.result_provider_operation_id = NEW.command_provider_operation_id
            AND NEW.result_reconciliation_key = NEW.command_reconciliation_key
            AND NEW.result_terminal_status IS NULL
            AND (
              action.lineage_kind = 'none' OR
              (action.lineage_kind = 'accepted'
                AND action.provider_operation_id = NEW.command_provider_operation_id
                AND action.reconciliation_key = NEW.command_reconciliation_key)
            )) OR
          (NEW.command_tag = 'recordUnknown'
            AND NEW.result_provider_operation_id IS action.provider_operation_id
            AND NEW.result_terminal_status IS NULL
            AND (
              (NEW.command_unknown_kind = 'reconcilable'
                AND NEW.result_lineage_kind = 'reconcilable'
                AND NEW.result_reconciliation_key = NEW.command_reconciliation_key) OR
              (NEW.command_unknown_kind = 'manual'
                AND (
                  (action.reconciliation_key IS NULL
                    AND NEW.result_lineage_kind = 'manual'
                    AND NEW.result_reconciliation_key IS NULL) OR
                  (action.reconciliation_key IS NOT NULL
                    AND NEW.result_lineage_kind = 'reconcilable'
                    AND NEW.result_reconciliation_key = action.reconciliation_key)
                ))
            )) OR
          (NEW.command_tag = 'reconciliationPending'
            AND (
              (NEW.command_reconciliation_key = ${idempotencyLocatorSql}
                AND action.lineage_kind IN ('none', 'manual')
                AND action.reconciliation_key IS NULL) OR
              (NEW.command_reconciliation_key <> ${idempotencyLocatorSql}
                AND action.lineage_kind IN ('accepted', 'reconcilable')
                AND NEW.command_reconciliation_key = action.reconciliation_key)
            )
            AND NEW.result_lineage_json = action.lineage_json
            AND NEW.result_lineage_kind = action.lineage_kind
            AND NEW.result_provider_operation_id IS action.provider_operation_id
            AND NEW.result_reconciliation_key IS action.reconciliation_key
            AND NEW.result_terminal_status IS action.terminal_status) OR
          (NEW.command_tag IN ('recordSucceeded', 'recordFailed', 'recordCancelled')
            AND NEW.result_lineage_kind = 'terminal'
            AND NEW.result_provider_operation_id = NEW.command_provider_operation_id
            AND NEW.result_terminal_status = NEW.command_terminal_status
            AND NEW.result_reconciliation_key IS NULL
            AND (
              (NEW.outcome_source_kind = 'direct' AND action.lineage_kind = 'none') OR
              (NEW.outcome_source_kind = 'providerOperation'
                AND action.lineage_kind = 'accepted'
                AND action.provider_operation_id = NEW.command_provider_operation_id) OR
              (NEW.outcome_source_kind = 'reconciliation' AND (
                (NEW.command_reconciliation_key = ${idempotencyLocatorSql}
                  AND action.lineage_kind IN ('none', 'manual')
                  AND action.reconciliation_key IS NULL
                  AND (action.provider_operation_id IS NULL
                    OR action.provider_operation_id = NEW.command_provider_operation_id)) OR
                (NEW.command_reconciliation_key <> ${idempotencyLocatorSql}
                  AND action.lineage_kind IN ('accepted', 'reconcilable')
                  AND action.reconciliation_key = NEW.command_reconciliation_key
                  AND (action.provider_operation_id IS NULL
                    OR action.provider_operation_id = NEW.command_provider_operation_id))
              ))
            ))
        )
        AND (
          (NEW.sequence = 1 AND action.head_transition_id IS NULL
            AND action.head_sequence IS NULL AND action.state IS NULL) OR
          (NEW.sequence = action.head_sequence + 1
            AND NEW.previous_transition_id = action.head_transition_id
            AND NEW.from_state = action.state
            AND NEW.occurred_at >= action.updated_at)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action transition must append to the exact head');
    END`)

  yield* sql.unsafe(`CREATE TRIGGER governed_action_transition_reserved_reconciliation_locator
    BEFORE INSERT ON governed_action_transitions
    WHEN NEW.command_reconciliation_key = ${idempotencyLocatorSql}
      AND NOT (
        NEW.command_tag = 'reconciliationPending' OR
        (NEW.command_tag IN ('recordSucceeded', 'recordFailed', 'recordCancelled')
          AND NEW.outcome_source_kind = 'reconciliation')
      )
    BEGIN
      SELECT RAISE(ABORT, 'reserved reconciliation locator is execution-owned');
    END`)

  yield* sql`DROP TRIGGER governed_action_provider_outcome_fold_order`
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
          (outcome.result_kind IN ('unknown', 'manual-unknown')
            AND transition_record.command_tag = 'recordUnknown') OR
          (outcome.result_kind = 'pending'
            AND transition_record.command_tag = 'reconciliationPending') OR
          (outcome.result_kind = 'recovery-unavailable' AND (
            (EXISTS (
              SELECT 1 FROM governed_action_legacy_recovery_unavailable_outcomes legacy
              WHERE legacy.workspace_id = outcome.workspace_id
                AND legacy.action_id = outcome.action_id
                AND legacy.outcome_id = outcome.outcome_id
            ) AND transition_record.command_tag = 'recordUnknown') OR
            (NOT EXISTS (
              SELECT 1 FROM governed_action_legacy_recovery_unavailable_outcomes legacy
              WHERE legacy.workspace_id = outcome.workspace_id
                AND legacy.action_id = outcome.action_id
                AND legacy.outcome_id = outcome.outcome_id
            ) AND transition_record.command_tag = 'reconciliationPending')
          ))
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
})
