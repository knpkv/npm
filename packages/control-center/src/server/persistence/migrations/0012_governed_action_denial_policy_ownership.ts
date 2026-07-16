import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add forward-only ownership from a deny transition to its exact policy evaluation. */
export const migration0012GovernedActionDenialPolicyOwnership = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE governed_action_denial_policy_evaluations (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    transition_id TEXT NOT NULL,
    policy_evaluation_digest TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id, transition_id),
    UNIQUE (workspace_id, action_id, policy_evaluation_digest),
    FOREIGN KEY (workspace_id, action_id, transition_id)
      REFERENCES governed_action_transitions(workspace_id, action_id, transition_id),
    FOREIGN KEY (workspace_id, action_id, policy_evaluation_digest)
      REFERENCES governed_action_policy_evaluations(workspace_id, action_id, evaluation_digest)
  )`

  yield* sql`CREATE TRIGGER governed_action_denial_policy_exact_owner
    BEFORE INSERT ON governed_action_denial_policy_evaluations
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_action_transitions transition_record
      JOIN governed_action_policy_evaluations evaluation
        ON evaluation.workspace_id = NEW.workspace_id
        AND evaluation.action_id = NEW.action_id
        AND evaluation.evaluation_digest = NEW.policy_evaluation_digest
      WHERE transition_record.workspace_id = NEW.workspace_id
        AND transition_record.action_id = NEW.action_id
        AND transition_record.transition_id = NEW.transition_id
        AND transition_record.command_tag = 'deny'
        AND evaluation.decision = 'denied'
        AND evaluation.evaluated_at <= transition_record.occurred_at
        AND NOT EXISTS (
          SELECT 1
          FROM audit_events audit
          WHERE audit.workspace_id = transition_record.workspace_id
            AND audit.action_id = transition_record.action_id
            AND audit.transition_id = transition_record.transition_id
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'denial policy evaluation must belong to its exact deny transition');
    END`

  yield* sql`CREATE TRIGGER governed_action_denial_policy_evaluations_no_update
    BEFORE UPDATE ON governed_action_denial_policy_evaluations
    BEGIN
      SELECT RAISE(ABORT, 'governed action denial policy ownership is immutable');
    END`
  yield* sql`CREATE TRIGGER governed_action_denial_policy_evaluations_no_delete
    BEFORE DELETE ON governed_action_denial_policy_evaluations
    BEGIN
      SELECT RAISE(ABORT, 'governed action denial policy ownership is immutable');
    END`
})
