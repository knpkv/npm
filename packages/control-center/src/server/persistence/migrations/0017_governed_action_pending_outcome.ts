import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Give a durably received dispatch result ownership before provider reconciliation may start. */
export const migration0017GovernedActionPendingOutcome = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TRIGGER governed_action_recovery_claim_after_pending_outcome
    BEFORE INSERT ON governed_action_recovery_claims
    WHEN EXISTS (
      SELECT 1
      FROM governed_action_provider_outcomes outcome
      LEFT JOIN governed_action_provider_outcome_folds fold
        ON fold.workspace_id = outcome.workspace_id
        AND fold.action_id = outcome.action_id
        AND fold.outcome_id = outcome.outcome_id
      WHERE outcome.workspace_id = NEW.workspace_id
        AND outcome.action_id = NEW.action_id
        AND outcome.source_kind = 'dispatch'
        AND fold.outcome_id IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action pending dispatch outcome must fold before recovery');
    END`
})
