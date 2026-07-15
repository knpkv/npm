import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Fence provider outcomes to the active dispatch or latest recovery lease. */
export const migration0014GovernedActionActiveLease = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TRIGGER governed_action_provider_outcome_active_lease
    BEFORE INSERT ON governed_action_provider_outcomes
    WHEN NOT (
      (NEW.source_kind = 'dispatch' AND EXISTS (
        SELECT 1
        FROM governed_action_execution_leases execution
        WHERE execution.workspace_id = NEW.workspace_id
          AND execution.action_id = NEW.action_id
          AND execution.permit_token_digest = NEW.permit_token_digest
          AND execution.created_at <= NEW.observed_at
          AND NEW.received_at < execution.lease_expires_at
          AND (NEW.result_kind = 'manual-unknown'
            OR NEW.observed_at < execution.dispatch_deadline)
          AND NOT EXISTS (
            SELECT 1
            FROM governed_action_recovery_claims recovery
            WHERE recovery.workspace_id = execution.workspace_id
              AND recovery.action_id = execution.action_id
          )
      )) OR
      (NEW.source_kind = 'reconciliation' AND EXISTS (
        SELECT 1
        FROM governed_action_recovery_claims recovery
        WHERE recovery.workspace_id = NEW.workspace_id
          AND recovery.action_id = NEW.action_id
          AND recovery.claim_token_digest = NEW.recovery_claim_token_digest
          AND recovery.claimed_at <= NEW.observed_at
          AND NEW.received_at < recovery.lease_expires_at
          AND NOT EXISTS (
            SELECT 1
            FROM governed_action_recovery_claims later
            WHERE later.workspace_id = recovery.workspace_id
              AND later.action_id = recovery.action_id
              AND later.claim_sequence > recovery.claim_sequence
          )
      ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action provider outcome requires the active execution lease');
    END`
})
