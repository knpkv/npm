import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add immutable exact-entity grants and separate owner-authored revocations. */
export const migration0022AuthorizedShares = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE authorized_share_grants (
    workspace_id TEXT NOT NULL,
    share_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    entity_id TEXT NOT NULL,
    grantee_person_id TEXT NOT NULL,
    created_by_person_id TEXT NOT NULL,
    created_by_session_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, share_id),
    FOREIGN KEY (workspace_id, entity_id)
      REFERENCES entities(workspace_id, entity_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, grantee_person_id)
      REFERENCES persons(workspace_id, person_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, created_by_person_id)
      REFERENCES persons(workspace_id, person_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, created_by_session_id)
      REFERENCES sessions(workspace_id, session_id)
      ON DELETE RESTRICT,
    CHECK(created_at < expires_at)
  )`

  yield* sql`CREATE INDEX authorized_share_grantee_expiry_idx
    ON authorized_share_grants(workspace_id, grantee_person_id, expires_at)`

  yield* sql`CREATE TRIGGER authorized_share_current_present_target
    BEFORE INSERT ON authorized_share_grants
    WHEN NOT EXISTS (
      SELECT 1
      FROM entity_projection_revisions projection
      JOIN entities entity
        ON entity.workspace_id = projection.workspace_id
        AND entity.entity_id = projection.entity_id
      WHERE projection.workspace_id = NEW.workspace_id
        AND projection.entity_id = NEW.entity_id
        AND projection.projection_revision = (
          SELECT MAX(current_projection.projection_revision)
          FROM entity_projection_revisions current_projection
          WHERE current_projection.workspace_id = NEW.workspace_id
            AND current_projection.entity_id = NEW.entity_id
        )
        AND projection.source_entity_revision = entity.current_revision
        AND projection.entity_state = 'present'
    )
    BEGIN
      SELECT RAISE(ABORT, 'authorized share requires a current present entity');
    END`

  yield* sql`CREATE TRIGGER authorized_share_owner_origin
    BEFORE INSERT ON authorized_share_grants
    WHEN NOT EXISTS (
      SELECT 1
      FROM sessions session
      WHERE session.workspace_id = NEW.workspace_id
        AND session.session_id = NEW.created_by_session_id
        AND session.actor_kind = 'human'
        AND session.person_id = NEW.created_by_person_id
        AND session.agent_id IS NULL
        AND session.permission = 'workspace-owner'
        AND session.revoked_at IS NULL
        AND session.created_at <= NEW.created_at
        AND session.idle_expires_at > NEW.created_at
        AND session.absolute_expires_at > NEW.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'authorized share requires current human owner authority');
    END`

  yield* sql`CREATE TABLE authorized_share_revocations (
    workspace_id TEXT NOT NULL,
    share_id TEXT NOT NULL,
    revoked_by_person_id TEXT NOT NULL,
    revoked_by_session_id TEXT NOT NULL,
    revoked_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, share_id),
    FOREIGN KEY (workspace_id, share_id)
      REFERENCES authorized_share_grants(workspace_id, share_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, revoked_by_person_id)
      REFERENCES persons(workspace_id, person_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, revoked_by_session_id)
      REFERENCES sessions(workspace_id, session_id)
      ON DELETE RESTRICT
  )`

  yield* sql`CREATE TRIGGER authorized_share_revocation_owner_authority
    BEFORE INSERT ON authorized_share_revocations
    WHEN NOT EXISTS (
      SELECT 1
      FROM authorized_share_grants grant_record
      JOIN sessions session
        ON session.workspace_id = NEW.workspace_id
        AND session.session_id = NEW.revoked_by_session_id
      WHERE grant_record.workspace_id = NEW.workspace_id
        AND grant_record.share_id = NEW.share_id
        AND grant_record.created_at <= NEW.revoked_at
        AND session.actor_kind = 'human'
        AND session.person_id = NEW.revoked_by_person_id
        AND session.agent_id IS NULL
        AND session.permission = 'workspace-owner'
        AND session.revoked_at IS NULL
        AND session.created_at <= NEW.revoked_at
        AND session.idle_expires_at > NEW.revoked_at
        AND session.absolute_expires_at > NEW.revoked_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'authorized share revocation requires current human owner authority');
    END`

  yield* sql`CREATE TRIGGER authorized_share_grants_no_update
    BEFORE UPDATE ON authorized_share_grants
    BEGIN
      SELECT RAISE(ABORT, 'authorized share grants are immutable');
    END`
  yield* sql`CREATE TRIGGER authorized_share_grants_no_delete
    BEFORE DELETE ON authorized_share_grants
    BEGIN
      SELECT RAISE(ABORT, 'authorized share grants are immutable');
    END`
  yield* sql`CREATE TRIGGER authorized_share_revocations_no_update
    BEFORE UPDATE ON authorized_share_revocations
    BEGIN
      SELECT RAISE(ABORT, 'authorized share revocations are immutable');
    END`
  yield* sql`CREATE TRIGGER authorized_share_revocations_no_delete
    BEFORE DELETE ON authorized_share_revocations
    BEGIN
      SELECT RAISE(ABORT, 'authorized share revocations are immutable');
    END`
})
