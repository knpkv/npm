import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Persist pending relationship-repair proposals with exact session and graph authority. */
export const migration0019RelationshipRepairProposals = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE relationship_repair_proposals (
    workspace_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    release_id TEXT NOT NULL,
    environment_id TEXT,
    relationship_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK(expected_revision >= 1),
    disposition TEXT NOT NULL CHECK(disposition IN ('link', 'verify', 'reject')),
    rationale TEXT NOT NULL CHECK(length(rationale) BETWEEN 1 AND 1000),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent')),
    person_id TEXT,
    agent_id TEXT,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status = 'pending'),
    proposed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, proposal_id),
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id, environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, relationship_id, expected_revision)
      REFERENCES relationship_revisions(workspace_id, relationship_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, session_id)
      REFERENCES sessions(workspace_id, session_id)
      ON DELETE RESTRICT,
    CHECK(
      (actor_kind = 'human' AND person_id IS NOT NULL AND agent_id IS NULL) OR
      (actor_kind = 'agent' AND agent_id IS NOT NULL AND person_id IS NULL)
    )
  )`

  yield* sql`CREATE UNIQUE INDEX relationship_repair_one_pending_revision_idx
    ON relationship_repair_proposals(workspace_id, relationship_id, expected_revision)
    WHERE status = 'pending'`

  yield* sql`CREATE INDEX relationship_repair_release_pending_idx
    ON relationship_repair_proposals(workspace_id, release_id, status, proposed_at DESC)`

  yield* sql`CREATE TRIGGER relationship_repair_proposal_current_candidate
    BEFORE INSERT ON relationship_repair_proposals
    WHEN NOT EXISTS (
      SELECT 1
      FROM relationship_heads head
      JOIN relationship_revisions revision
        ON revision.workspace_id = head.workspace_id
        AND revision.relationship_id = head.relationship_id
        AND revision.revision = head.current_revision
      WHERE head.workspace_id = NEW.workspace_id
        AND head.relationship_id = NEW.relationship_id
        AND head.current_revision = NEW.expected_revision
        AND revision.release_id = NEW.release_id
        AND (
          (NEW.environment_id IS NULL AND revision.environment_id IS NULL) OR
          revision.environment_id = NEW.environment_id
        )
        AND revision.lifecycle IN ('missing', 'inferred', 'proposed')
    )
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair proposal requires the current scoped candidate');
    END`

  yield* sql`CREATE TRIGGER relationship_repair_proposal_authenticated_origin
    BEFORE INSERT ON relationship_repair_proposals
    WHEN NOT EXISTS (
      SELECT 1
      FROM sessions session
      WHERE session.workspace_id = NEW.workspace_id
        AND session.session_id = NEW.session_id
        AND session.actor_kind = NEW.actor_kind
        AND session.person_id IS NEW.person_id
        AND session.agent_id IS NEW.agent_id
        AND session.permission = 'workspace-owner'
        AND session.revoked_at IS NULL
        AND session.created_at <= NEW.proposed_at
        AND session.idle_expires_at > NEW.proposed_at
        AND session.absolute_expires_at > NEW.proposed_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair proposal requires current owner authority');
    END`
})
