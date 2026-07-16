import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const immutableTable = (sql: SqlClient.SqlClient, table: string) =>
  Effect.forEach(["UPDATE", "DELETE"], (operation) =>
    sql.unsafe(`CREATE TRIGGER ${table}_no_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} is immutable');
      END`), { discard: true })

/** Add append-only governed-action authority, intent, transition, and lifecycle storage. */
export const migration0011GovernedActions = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE UNIQUE INDEX entities_governed_action_scope_idx
    ON entities(workspace_id, entity_id, plugin_connection_id, provider_id)`

  yield* sql`CREATE TABLE governed_actions (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL CHECK(provider_id IN (
      'codecommit', 'codepipeline', 'jira', 'confluence', 'clockify'
    )),
    target_entity_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
    envelope_digest TEXT NOT NULL CHECK(
      length(envelope_digest) = 71 AND envelope_digest GLOB 'sha256:*'
        AND substr(envelope_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    envelope_json TEXT NOT NULL CHECK(length(envelope_json) BETWEEN 2 AND 1048576),
    state TEXT CHECK(state IN (
      'proposed', 'authorized', 'denied', 'expired', 'cancelled', 'started',
      'cancel-requested', 'cancel-requested-unknown', 'succeeded', 'failed', 'unknown'
    )),
    lineage_json TEXT CHECK(lineage_json IS NULL OR length(lineage_json) BETWEEN 2 AND 65536),
    lineage_kind TEXT CHECK(lineage_kind IS NULL OR lineage_kind IN (
      'none', 'accepted', 'reconcilable', 'manual', 'terminal'
    )),
    provider_operation_id TEXT CHECK(
      provider_operation_id IS NULL OR length(provider_operation_id) BETWEEN 1 AND 512
    ),
    reconciliation_key TEXT CHECK(
      reconciliation_key IS NULL OR length(reconciliation_key) BETWEEN 1 AND 512
    ),
    terminal_status TEXT CHECK(
      terminal_status IS NULL OR terminal_status IN ('succeeded', 'failed', 'cancelled')
    ),
    head_transition_id TEXT,
    head_sequence INTEGER CHECK(head_sequence IS NULL OR head_sequence >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id),
    UNIQUE (workspace_id, plugin_connection_id, idempotency_key),
    UNIQUE (workspace_id, action_id, envelope_digest),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    FOREIGN KEY (workspace_id, plugin_connection_id, provider_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id, provider_id),
    FOREIGN KEY (workspace_id, target_entity_id, plugin_connection_id, provider_id)
      REFERENCES entities(workspace_id, entity_id, plugin_connection_id, provider_id),
    CHECK(created_at <= updated_at),
    CHECK(
      (state IS NULL AND lineage_json IS NULL AND lineage_kind IS NULL
        AND provider_operation_id IS NULL AND reconciliation_key IS NULL AND terminal_status IS NULL
        AND head_transition_id IS NULL AND head_sequence IS NULL) OR
      (state IS NOT NULL AND lineage_json IS NOT NULL AND lineage_kind IS NOT NULL
        AND head_transition_id IS NOT NULL AND head_sequence IS NOT NULL)
    ),
    CHECK(
      lineage_kind IS NULL OR
      (lineage_kind = 'none' AND provider_operation_id IS NULL
        AND reconciliation_key IS NULL AND terminal_status IS NULL) OR
      (lineage_kind = 'accepted' AND provider_operation_id IS NOT NULL
        AND reconciliation_key IS NOT NULL AND terminal_status IS NULL) OR
      (lineage_kind = 'reconcilable' AND reconciliation_key IS NOT NULL
        AND terminal_status IS NULL) OR
      (lineage_kind = 'manual' AND reconciliation_key IS NULL AND terminal_status IS NULL) OR
      (lineage_kind = 'terminal' AND provider_operation_id IS NOT NULL
        AND reconciliation_key IS NULL AND terminal_status IS NOT NULL)
    ),
    CHECK(
      state IS NULL OR
      (state IN ('proposed', 'authorized', 'denied', 'expired') AND lineage_kind = 'none') OR
      (state = 'cancelled' AND (
        lineage_kind = 'none' OR (lineage_kind = 'terminal' AND terminal_status = 'cancelled')
      )) OR
      (state IN ('started', 'cancel-requested') AND lineage_kind IN ('none', 'accepted')) OR
      (state IN ('unknown', 'cancel-requested-unknown')
        AND lineage_kind IN ('reconcilable', 'manual')) OR
      (state = 'succeeded' AND lineage_kind = 'terminal' AND terminal_status = 'succeeded') OR
      (state = 'failed' AND lineage_kind = 'terminal' AND terminal_status = 'failed')
    )
  )`

  yield* sql`CREATE TRIGGER governed_action_initial_head_empty
    BEFORE INSERT ON governed_actions
    WHEN NEW.state IS NOT NULL OR NEW.lineage_json IS NOT NULL OR NEW.lineage_kind IS NOT NULL
      OR NEW.provider_operation_id IS NOT NULL OR NEW.reconciliation_key IS NOT NULL
      OR NEW.terminal_status IS NOT NULL OR NEW.head_transition_id IS NOT NULL
      OR NEW.head_sequence IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'governed action must begin without a fabricated head');
    END`

  yield* sql`CREATE TABLE governed_action_policy_evaluations (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    evaluation_digest TEXT NOT NULL CHECK(
      length(evaluation_digest) = 71 AND evaluation_digest GLOB 'sha256:*'
        AND substr(evaluation_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    evaluation_json TEXT NOT NULL CHECK(length(evaluation_json) BETWEEN 2 AND 262144),
    decision TEXT NOT NULL CHECK(decision IN ('allowed', 'denied')),
    evaluated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, action_id, evaluation_digest),
    FOREIGN KEY (workspace_id, action_id)
      REFERENCES governed_actions(workspace_id, action_id)
  )`

  yield* sql`CREATE TABLE governed_action_authorizations (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    authorization_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    envelope_digest TEXT NOT NULL,
    authorization_digest TEXT NOT NULL CHECK(
      length(authorization_digest) = 71 AND authorization_digest GLOB 'sha256:*'
        AND substr(authorization_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    authorization_json TEXT NOT NULL CHECK(length(authorization_json) BETWEEN 2 AND 262144),
    authorized_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, authorization_id),
    UNIQUE (workspace_id, action_id),
    UNIQUE (workspace_id, action_id, authorization_id),
    FOREIGN KEY (workspace_id, action_id, envelope_digest)
      REFERENCES governed_actions(workspace_id, action_id, envelope_digest),
    FOREIGN KEY (workspace_id, session_id)
      REFERENCES sessions(workspace_id, session_id),
    CHECK(authorized_at < expires_at)
  )`

  yield* sql`CREATE TRIGGER governed_action_authorization_current_human_session
    BEFORE INSERT ON governed_action_authorizations
    WHEN NOT EXISTS (
      SELECT 1 FROM sessions session
      WHERE session.workspace_id = NEW.workspace_id
        AND session.session_id = NEW.session_id
        AND session.actor_kind = 'human'
        AND session.revoked_at IS NULL
        AND session.created_at <= NEW.authorized_at
        AND session.last_seen_at <= NEW.authorized_at
        AND NEW.authorized_at < session.idle_expires_at
        AND NEW.authorized_at < session.absolute_expires_at
        AND NEW.expires_at <= session.idle_expires_at
        AND NEW.expires_at <= session.absolute_expires_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action authorization requires a current human session');
    END`

  yield* sql`CREATE TABLE governed_action_attempts (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    authorization_id TEXT NOT NULL,
    policy_evaluation_digest TEXT NOT NULL,
    attempt_digest TEXT NOT NULL CHECK(
      length(attempt_digest) = 71 AND attempt_digest GLOB 'sha256:*'
        AND substr(attempt_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    attempt_number INTEGER NOT NULL CHECK(attempt_number = 1),
    attempt_json TEXT NOT NULL CHECK(length(attempt_json) BETWEEN 2 AND 262144),
    started_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, attempt_id),
    UNIQUE (workspace_id, action_id),
    UNIQUE (workspace_id, action_id, attempt_id),
    UNIQUE (workspace_id, authorization_id),
    FOREIGN KEY (workspace_id, action_id)
      REFERENCES governed_actions(workspace_id, action_id),
    FOREIGN KEY (workspace_id, action_id, authorization_id)
      REFERENCES governed_action_authorizations(workspace_id, action_id, authorization_id),
    FOREIGN KEY (workspace_id, action_id, policy_evaluation_digest)
      REFERENCES governed_action_policy_evaluations(workspace_id, action_id, evaluation_digest)
  )`

  yield* sql`CREATE TABLE governed_action_transitions (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    transition_id TEXT NOT NULL,
    previous_transition_id TEXT,
    sequence INTEGER NOT NULL CHECK(sequence >= 1),
    command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 512),
    command_tag TEXT NOT NULL CHECK(command_tag IN (
      'propose', 'authorize', 'deny', 'expire', 'cancel', 'start',
      'requestCancellation', 'recordAccepted', 'recordSucceeded', 'recordFailed',
      'recordUnknown', 'recordCancelled', 'reconciliationPending'
    )),
    authorization_id TEXT,
    attempt_id TEXT,
    outcome_source_kind TEXT CHECK(
      outcome_source_kind IS NULL OR outcome_source_kind IN (
        'direct', 'providerOperation', 'reconciliation'
      )
    ),
    command_provider_operation_id TEXT CHECK(
      command_provider_operation_id IS NULL OR length(command_provider_operation_id) BETWEEN 1 AND 512
    ),
    command_reconciliation_key TEXT CHECK(
      command_reconciliation_key IS NULL OR length(command_reconciliation_key) BETWEEN 1 AND 512
    ),
    command_terminal_status TEXT CHECK(
      command_terminal_status IS NULL OR command_terminal_status IN ('succeeded', 'failed', 'cancelled')
    ),
    command_unknown_kind TEXT CHECK(
      command_unknown_kind IS NULL OR command_unknown_kind IN ('reconcilable', 'manual')
    ),
    command_digest TEXT NOT NULL CHECK(
      length(command_digest) = 71 AND command_digest GLOB 'sha256:*'
        AND substr(command_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    transition_digest TEXT NOT NULL CHECK(
      length(transition_digest) = 71 AND transition_digest GLOB 'sha256:*'
        AND substr(transition_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    envelope_digest TEXT NOT NULL,
    from_state TEXT CHECK(from_state IS NULL OR from_state IN (
      'proposed', 'authorized', 'denied', 'expired', 'cancelled', 'started',
      'cancel-requested', 'cancel-requested-unknown', 'succeeded', 'failed', 'unknown'
    )),
    to_state TEXT NOT NULL CHECK(to_state IN (
      'proposed', 'authorized', 'denied', 'expired', 'cancelled', 'started',
      'cancel-requested', 'cancel-requested-unknown', 'succeeded', 'failed', 'unknown'
    )),
    result_lineage_json TEXT NOT NULL CHECK(length(result_lineage_json) BETWEEN 2 AND 65536),
    result_lineage_kind TEXT NOT NULL CHECK(result_lineage_kind IN (
      'none', 'accepted', 'reconcilable', 'manual', 'terminal'
    )),
    result_provider_operation_id TEXT CHECK(
      result_provider_operation_id IS NULL OR length(result_provider_operation_id) BETWEEN 1 AND 512
    ),
    result_reconciliation_key TEXT CHECK(
      result_reconciliation_key IS NULL OR length(result_reconciliation_key) BETWEEN 1 AND 512
    ),
    result_terminal_status TEXT CHECK(
      result_terminal_status IS NULL OR result_terminal_status IN ('succeeded', 'failed', 'cancelled')
    ),
    cause_kind TEXT NOT NULL CHECK(cause_kind IN ('human', 'agent', 'system')),
    cause_actor_id TEXT CHECK(cause_actor_id IS NULL OR length(cause_actor_id) BETWEEN 1 AND 512),
    cause_session_id TEXT,
    cause_job_id TEXT CHECK(cause_job_id IS NULL OR length(cause_job_id) BETWEEN 1 AND 512),
    cause_system_component TEXT CHECK(
      cause_system_component IS NULL OR length(cause_system_component) BETWEEN 1 AND 200
    ),
    causation_id TEXT,
    correlation_id TEXT CHECK(
      correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128
    ),
    transition_json TEXT NOT NULL CHECK(length(transition_json) BETWEEN 2 AND 262144),
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, transition_id),
    UNIQUE (workspace_id, action_id, transition_id),
    UNIQUE (workspace_id, action_id, sequence),
    UNIQUE (workspace_id, action_id, command_id),
    FOREIGN KEY (workspace_id, action_id, envelope_digest)
      REFERENCES governed_actions(workspace_id, action_id, envelope_digest),
    FOREIGN KEY (workspace_id, action_id, previous_transition_id)
      REFERENCES governed_action_transitions(workspace_id, action_id, transition_id),
    FOREIGN KEY (workspace_id, action_id, authorization_id)
      REFERENCES governed_action_authorizations(workspace_id, action_id, authorization_id),
    FOREIGN KEY (workspace_id, action_id, attempt_id)
      REFERENCES governed_action_attempts(workspace_id, action_id, attempt_id),
    FOREIGN KEY (workspace_id, cause_session_id)
      REFERENCES sessions(workspace_id, session_id),
    CHECK(
      (sequence = 1 AND previous_transition_id IS NULL AND from_state IS NULL) OR
      (sequence > 1 AND previous_transition_id IS NOT NULL AND from_state IS NOT NULL)
    ),
    CHECK(
      (command_tag = 'authorize' AND authorization_id IS NOT NULL AND attempt_id IS NULL) OR
      (command_tag = 'start' AND authorization_id IS NULL AND attempt_id IS NOT NULL) OR
      (command_tag NOT IN ('authorize', 'start') AND authorization_id IS NULL AND attempt_id IS NULL)
    ),
    CHECK(COALESCE((
      (command_tag IN (
        'propose', 'authorize', 'deny', 'expire', 'cancel', 'start', 'requestCancellation'
      ) AND outcome_source_kind IS NULL AND command_provider_operation_id IS NULL
        AND command_reconciliation_key IS NULL AND command_terminal_status IS NULL
        AND command_unknown_kind IS NULL) OR
      (command_tag = 'recordAccepted' AND outcome_source_kind IS NULL
        AND command_provider_operation_id IS NOT NULL AND command_reconciliation_key IS NOT NULL
        AND command_terminal_status IS NULL AND command_unknown_kind IS NULL) OR
      (command_tag = 'recordUnknown' AND outcome_source_kind IS NULL
        AND command_provider_operation_id IS NULL AND command_terminal_status IS NULL
        AND command_unknown_kind IS NOT NULL AND (
          (command_unknown_kind = 'reconcilable' AND command_reconciliation_key IS NOT NULL) OR
          (command_unknown_kind = 'manual' AND command_reconciliation_key IS NULL)
        )) OR
      (command_tag = 'reconciliationPending' AND outcome_source_kind IS NULL
        AND command_provider_operation_id IS NULL AND command_reconciliation_key IS NOT NULL
        AND command_terminal_status IS NULL AND command_unknown_kind IS NULL) OR
      (command_tag IN ('recordSucceeded', 'recordFailed', 'recordCancelled')
        AND outcome_source_kind IS NOT NULL AND command_provider_operation_id IS NOT NULL
        AND command_terminal_status = CASE command_tag
          WHEN 'recordSucceeded' THEN 'succeeded'
          WHEN 'recordFailed' THEN 'failed'
          ELSE 'cancelled'
        END
        AND command_unknown_kind IS NULL
        AND (
          (outcome_source_kind IN ('direct', 'providerOperation')
            AND command_reconciliation_key IS NULL) OR
          (outcome_source_kind = 'reconciliation' AND command_reconciliation_key IS NOT NULL)
        ))
    ), 0)),
    CHECK(
      (cause_kind = 'human' AND cause_actor_id IS NOT NULL AND cause_session_id IS NOT NULL
        AND cause_job_id IS NULL AND cause_system_component IS NULL) OR
      (cause_kind = 'agent' AND cause_actor_id IS NOT NULL AND cause_session_id IS NULL
        AND cause_job_id IS NOT NULL AND cause_system_component IS NULL) OR
      (cause_kind = 'system' AND cause_actor_id IS NULL AND cause_session_id IS NULL
        AND cause_job_id IS NULL AND cause_system_component IS NOT NULL)
    ),
    CHECK(COALESCE((
      (cause_kind = 'agent' AND command_tag = 'propose') OR
      (cause_kind = 'human' AND command_tag IN (
        'propose', 'authorize', 'deny', 'cancel', 'requestCancellation'
      )) OR
      (cause_kind = 'system' AND command_tag IN (
        'deny', 'expire', 'cancel', 'start', 'requestCancellation', 'recordAccepted',
        'recordSucceeded', 'recordFailed', 'recordUnknown', 'recordCancelled',
        'reconciliationPending'
      ))
    ), 0)),
    CHECK(
      causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 512
    ),
    CHECK(COALESCE((
      (command_tag = 'propose' AND from_state IS NULL AND to_state = 'proposed') OR
      (command_tag = 'authorize' AND from_state = 'proposed' AND to_state = 'authorized') OR
      (command_tag = 'deny' AND from_state IN ('proposed', 'authorized') AND to_state = 'denied') OR
      (command_tag = 'expire' AND from_state IN ('proposed', 'authorized') AND to_state = 'expired') OR
      (command_tag = 'cancel' AND from_state IN ('proposed', 'authorized') AND to_state = 'cancelled') OR
      (command_tag = 'start' AND from_state = 'authorized' AND to_state = 'started') OR
      (command_tag = 'requestCancellation' AND (
        (from_state = 'started' AND to_state = 'cancel-requested') OR
        (from_state = 'unknown' AND to_state = 'cancel-requested-unknown')
      )) OR
      (command_tag = 'recordAccepted' AND from_state = to_state
        AND from_state IN ('started', 'cancel-requested')) OR
      (command_tag = 'recordUnknown' AND (
        (from_state = 'started' AND to_state = 'unknown') OR
        (from_state = 'cancel-requested' AND to_state = 'cancel-requested-unknown')
      )) OR
      (command_tag IN ('recordSucceeded', 'recordFailed', 'recordCancelled')
        AND to_state = CASE command_tag
          WHEN 'recordSucceeded' THEN 'succeeded'
          WHEN 'recordFailed' THEN 'failed'
          ELSE 'cancelled'
        END
        AND (
          from_state IN ('started', 'cancel-requested') OR
          (from_state IN ('unknown', 'cancel-requested-unknown')
            AND outcome_source_kind = 'reconciliation')
        )) OR
      (command_tag = 'reconciliationPending' AND from_state = to_state
        AND from_state IN ('started', 'cancel-requested', 'unknown', 'cancel-requested-unknown'))
    ), 0)),
    CHECK(
      (result_lineage_kind = 'none' AND result_provider_operation_id IS NULL
        AND result_reconciliation_key IS NULL AND result_terminal_status IS NULL) OR
      (result_lineage_kind = 'accepted' AND result_provider_operation_id IS NOT NULL
        AND result_reconciliation_key IS NOT NULL AND result_terminal_status IS NULL) OR
      (result_lineage_kind = 'reconcilable' AND result_reconciliation_key IS NOT NULL
        AND result_terminal_status IS NULL) OR
      (result_lineage_kind = 'manual' AND result_reconciliation_key IS NULL
        AND result_terminal_status IS NULL) OR
      (result_lineage_kind = 'terminal' AND result_provider_operation_id IS NOT NULL
        AND result_reconciliation_key IS NULL AND result_terminal_status IS NOT NULL)
    ),
    CHECK(
      (to_state IN ('proposed', 'authorized', 'denied', 'expired') AND result_lineage_kind = 'none') OR
      (to_state = 'cancelled' AND (
        result_lineage_kind = 'none' OR
        (result_lineage_kind = 'terminal' AND result_terminal_status = 'cancelled')
      )) OR
      (to_state IN ('started', 'cancel-requested') AND result_lineage_kind IN ('none', 'accepted')) OR
      (to_state IN ('unknown', 'cancel-requested-unknown')
        AND result_lineage_kind IN ('reconcilable', 'manual')) OR
      (to_state = 'succeeded' AND result_lineage_kind = 'terminal'
        AND result_terminal_status = 'succeeded') OR
      (to_state = 'failed' AND result_lineage_kind = 'terminal'
        AND result_terminal_status = 'failed')
    )
  )`

  yield* sql`CREATE TRIGGER governed_action_transition_exact_append
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
            AND NEW.command_reconciliation_key = action.reconciliation_key
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
              (NEW.outcome_source_kind = 'reconciliation'
                AND action.lineage_kind IN ('accepted', 'reconcilable')
                AND action.reconciliation_key = NEW.command_reconciliation_key
                AND (action.provider_operation_id IS NULL
                  OR action.provider_operation_id = NEW.command_provider_operation_id))
            ))
        )
        AND (
          (NEW.sequence = 1 AND action.head_transition_id IS NULL AND action.head_sequence IS NULL AND action.state IS NULL) OR
          (NEW.sequence = action.head_sequence + 1
            AND NEW.previous_transition_id = action.head_transition_id
            AND NEW.from_state = action.state
            AND NEW.occurred_at >= action.updated_at)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action transition must append to the exact head');
    END`

  yield* sql`CREATE TRIGGER governed_action_attempt_allowed_policy
    BEFORE INSERT ON governed_action_attempts
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_action_policy_evaluations evaluation
      JOIN governed_action_authorizations authorization
        ON authorization.workspace_id = NEW.workspace_id
        AND authorization.action_id = NEW.action_id
        AND authorization.authorization_id = NEW.authorization_id
      JOIN sessions session
        ON session.workspace_id = authorization.workspace_id
        AND session.session_id = authorization.session_id
      WHERE evaluation.workspace_id = NEW.workspace_id
        AND evaluation.action_id = NEW.action_id
        AND evaluation.evaluation_digest = NEW.policy_evaluation_digest
        AND evaluation.decision = 'allowed'
        AND evaluation.evaluated_at <= NEW.started_at
        AND authorization.authorized_at <= NEW.started_at
        AND NEW.started_at < authorization.expires_at
        AND session.actor_kind = 'human'
        AND session.revoked_at IS NULL
        AND session.created_at <= NEW.started_at
        AND session.last_seen_at <= NEW.started_at
        AND NEW.started_at < session.idle_expires_at
        AND NEW.started_at < session.absolute_expires_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action attempt requires an exact allowed policy evaluation');
    END`

  yield* sql`CREATE TRIGGER governed_action_identity_immutable
    BEFORE UPDATE ON governed_actions
    WHEN OLD.workspace_id <> NEW.workspace_id OR OLD.action_id <> NEW.action_id
      OR OLD.plugin_connection_id <> NEW.plugin_connection_id OR OLD.provider_id <> NEW.provider_id
      OR OLD.target_entity_id <> NEW.target_entity_id OR OLD.idempotency_key <> NEW.idempotency_key
      OR OLD.envelope_digest <> NEW.envelope_digest OR OLD.envelope_json <> NEW.envelope_json
      OR OLD.created_at <> NEW.created_at
    BEGIN
      SELECT RAISE(ABORT, 'governed action identity is immutable');
    END`

  yield* sql`CREATE TRIGGER governed_action_head_exact_update
    BEFORE UPDATE ON governed_actions
    WHEN NOT EXISTS (
      SELECT 1 FROM governed_action_transitions transition_record
      WHERE transition_record.workspace_id = NEW.workspace_id
        AND transition_record.action_id = NEW.action_id
        AND transition_record.transition_id = NEW.head_transition_id
        AND transition_record.sequence = NEW.head_sequence
        AND transition_record.to_state = NEW.state
        AND transition_record.result_lineage_json = NEW.lineage_json
        AND transition_record.result_lineage_kind = NEW.lineage_kind
        AND transition_record.result_provider_operation_id IS NEW.provider_operation_id
        AND transition_record.result_reconciliation_key IS NEW.reconciliation_key
        AND transition_record.result_terminal_status IS NEW.terminal_status
        AND NEW.updated_at = transition_record.occurred_at
        AND NEW.updated_at >= OLD.updated_at
        AND EXISTS (
          SELECT 1 FROM audit_events audit
          WHERE audit.workspace_id = NEW.workspace_id
            AND audit.action_id = NEW.action_id
            AND audit.transition_id = NEW.head_transition_id
        )
        AND (
          (OLD.head_sequence IS NULL AND NEW.head_sequence = 1
            AND transition_record.previous_transition_id IS NULL AND transition_record.from_state IS NULL) OR
          (OLD.head_sequence IS NOT NULL AND NEW.head_sequence = OLD.head_sequence + 1
            AND transition_record.previous_transition_id = OLD.head_transition_id
            AND transition_record.from_state = OLD.state)
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'governed action head must advance to its exact transition');
    END`

  yield* sql`CREATE TABLE audit_events (
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    transition_id TEXT NOT NULL,
    audit_event_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK(event_kind IN (
      'proposed', 'authorized', 'denied', 'expired', 'cancelled', 'started',
      'cancel-requested', 'cancel-requested-unknown', 'succeeded', 'failed', 'unknown'
    )),
    cause_kind TEXT NOT NULL CHECK(cause_kind IN ('human', 'agent', 'system')),
    actor_id TEXT CHECK(actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 512),
    session_id TEXT,
    job_id TEXT CHECK(job_id IS NULL OR length(job_id) BETWEEN 1 AND 512),
    system_component TEXT CHECK(
      system_component IS NULL OR length(system_component) BETWEEN 1 AND 200
    ),
    causation_id TEXT,
    correlation_id TEXT CHECK(
      correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128
    ),
    payload_digest TEXT NOT NULL CHECK(
      length(payload_digest) = 71 AND payload_digest GLOB 'sha256:*'
        AND substr(payload_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 262144),
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, audit_event_id),
    UNIQUE (workspace_id, action_id, transition_id),
    FOREIGN KEY (workspace_id, action_id, transition_id)
      REFERENCES governed_action_transitions(workspace_id, action_id, transition_id),
    FOREIGN KEY (workspace_id, session_id)
      REFERENCES sessions(workspace_id, session_id),
    CHECK(
      (cause_kind = 'human' AND actor_id IS NOT NULL AND session_id IS NOT NULL
        AND job_id IS NULL AND system_component IS NULL) OR
      (cause_kind = 'agent' AND actor_id IS NOT NULL AND session_id IS NULL
        AND job_id IS NOT NULL AND system_component IS NULL) OR
      (cause_kind = 'system' AND actor_id IS NULL AND session_id IS NULL
        AND job_id IS NULL AND system_component IS NOT NULL)
    )
  )`

  yield* sql`CREATE TRIGGER governed_action_audit_exact_transition
    BEFORE INSERT ON audit_events
    WHEN NOT EXISTS (
      SELECT 1
      FROM governed_action_transitions transition_record
      LEFT JOIN sessions session
        ON session.workspace_id = NEW.workspace_id AND session.session_id = NEW.session_id
      WHERE transition_record.workspace_id = NEW.workspace_id
        AND transition_record.action_id = NEW.action_id
        AND transition_record.transition_id = NEW.transition_id
        AND transition_record.to_state = NEW.event_kind
        AND transition_record.occurred_at = NEW.occurred_at
        AND transition_record.cause_kind = NEW.cause_kind
        AND transition_record.cause_actor_id IS NEW.actor_id
        AND transition_record.cause_session_id IS NEW.session_id
        AND transition_record.cause_job_id IS NEW.job_id
        AND transition_record.cause_system_component IS NEW.system_component
        AND transition_record.causation_id IS NEW.causation_id
        AND transition_record.correlation_id IS NEW.correlation_id
        AND transition_record.transition_digest = NEW.payload_digest
        AND (NEW.cause_kind <> 'human' OR
          (session.actor_kind = 'human' AND session.person_id = NEW.actor_id))
    )
    BEGIN
      SELECT RAISE(ABORT, 'audit event must attribute its exact governed action transition');
    END`

  yield* sql`CREATE TRIGGER governed_actions_no_delete
    BEFORE DELETE ON governed_actions
    BEGIN
      SELECT RAISE(ABORT, 'governed actions are immutable audit roots');
    END`

  yield* immutableTable(sql, "governed_action_policy_evaluations")
  yield* immutableTable(sql, "governed_action_authorizations")
  yield* immutableTable(sql, "governed_action_attempts")
  yield* immutableTable(sql, "governed_action_transitions")
  yield* immutableTable(sql, "audit_events")

  yield* sql`CREATE INDEX governed_actions_state_idx
    ON governed_actions(workspace_id, state, updated_at DESC)`
  yield* sql`CREATE INDEX governed_action_transitions_history_idx
    ON governed_action_transitions(workspace_id, action_id, sequence DESC)`
  yield* sql`CREATE INDEX governed_action_audit_history_idx
    ON audit_events(workspace_id, action_id, occurred_at DESC)`
})
