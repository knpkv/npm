import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add opaque-token sessions and single-use pairing-code state. */
export const migration0003Auth = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE sessions (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK(
      length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    csrf_hash TEXT NOT NULL CHECK(
      length(csrf_hash) = 64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'
    ),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent')),
    person_id TEXT,
    agent_id TEXT,
    permission TEXT NOT NULL CHECK(permission IN (
      'workspace-owner', 'workspace-approver', 'release-owner', 'release-approver',
      'change-owner', 'issue-owner', 'issue-assignee', 'page-owner', 'author',
      'contributor', 'reviewer', 'operator', 'deployment-approver', 'merge-approver',
      'watcher'
    )),
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    idle_expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY (workspace_id, session_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    CHECK(
      (actor_kind = 'human' AND person_id IS NOT NULL AND agent_id IS NULL) OR
      (actor_kind = 'agent' AND agent_id IS NOT NULL AND person_id IS NULL)
    ),
    CHECK(created_at <= last_seen_at),
    CHECK(last_seen_at <= idle_expires_at),
    CHECK(idle_expires_at <= absolute_expires_at),
    CHECK(revoked_at IS NULL OR created_at <= revoked_at)
  )`

  yield* sql`CREATE TABLE pairing_codes (
    workspace_id TEXT NOT NULL,
    pairing_code_id TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE CHECK(
      length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'
    ),
    purpose TEXT NOT NULL CHECK(purpose IN ('first-run', 'device', 'recovery')),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent')),
    person_id TEXT,
    agent_id TEXT,
    permission TEXT NOT NULL CHECK(permission IN (
      'workspace-owner', 'workspace-approver', 'release-owner', 'release-approver',
      'change-owner', 'issue-owner', 'issue-assignee', 'page-owner', 'author',
      'contributor', 'reviewer', 'operator', 'deployment-approver', 'merge-approver',
      'watcher'
    )),
    issued_by_session_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_by_session_id TEXT,
    revoked_at TEXT,
    PRIMARY KEY (workspace_id, pairing_code_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    FOREIGN KEY (workspace_id, issued_by_session_id)
      REFERENCES sessions(workspace_id, session_id),
    FOREIGN KEY (workspace_id, consumed_by_session_id)
      REFERENCES sessions(workspace_id, session_id),
    CHECK(
      (actor_kind = 'human' AND person_id IS NOT NULL AND agent_id IS NULL) OR
      (actor_kind = 'agent' AND agent_id IS NOT NULL AND person_id IS NULL)
    ),
    CHECK(created_at < expires_at),
    CHECK(consumed_at IS NULL OR created_at <= consumed_at),
    CHECK(revoked_at IS NULL OR created_at <= revoked_at),
    CHECK((consumed_at IS NULL) = (consumed_by_session_id IS NULL)),
    CHECK(consumed_at IS NULL OR revoked_at IS NULL)
  )`

  yield* sql`CREATE UNIQUE INDEX pairing_codes_first_run_idx
    ON pairing_codes(workspace_id)
    WHERE purpose = 'first-run'`
  yield* sql`CREATE INDEX pairing_codes_active_idx
    ON pairing_codes(workspace_id, expires_at)
    WHERE consumed_at IS NULL AND revoked_at IS NULL`
  yield* sql`CREATE INDEX sessions_active_idx
    ON sessions(workspace_id, absolute_expires_at)
    WHERE revoked_at IS NULL`

  yield* sql`CREATE TABLE recovery_audit_events (
    workspace_id TEXT NOT NULL,
    pairing_code_id TEXT NOT NULL,
    event_kind TEXT NOT NULL CHECK(event_kind = 'owner-recovery-issued'),
    revoked_owner_sessions INTEGER NOT NULL CHECK(revoked_owner_sessions IN (0, 1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, pairing_code_id),
    FOREIGN KEY (workspace_id, pairing_code_id)
      REFERENCES pairing_codes(workspace_id, pairing_code_id)
  )`

  yield* sql`CREATE INDEX recovery_audit_events_created_idx
    ON recovery_audit_events(workspace_id, created_at DESC)`
})
