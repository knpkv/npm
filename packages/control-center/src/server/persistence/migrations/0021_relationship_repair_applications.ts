import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Record immutable, owner-authorized applications of approved repair proposals. */
export const migration0021RelationshipRepairApplications = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE relationship_repair_applications (
    workspace_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    applied_revision INTEGER NOT NULL CHECK(applied_revision >= 2),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent')),
    person_id TEXT,
    agent_id TEXT,
    session_id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, proposal_id),
    UNIQUE (workspace_id, relationship_id, applied_revision),
    FOREIGN KEY (workspace_id, proposal_id)
      REFERENCES relationship_repair_proposals(workspace_id, proposal_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, relationship_id, applied_revision)
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

  yield* sql`CREATE TRIGGER relationship_repair_application_authority
    BEFORE INSERT ON relationship_repair_applications
    WHEN NOT EXISTS (
      SELECT 1
      FROM relationship_repair_proposals proposal
      JOIN relationship_repair_reviews review
        ON review.workspace_id = proposal.workspace_id
        AND review.proposal_id = proposal.proposal_id
      JOIN relationship_heads head
        ON head.workspace_id = proposal.workspace_id
        AND head.relationship_id = proposal.relationship_id
      JOIN relationship_revisions revision
        ON revision.workspace_id = proposal.workspace_id
        AND revision.relationship_id = proposal.relationship_id
        AND revision.revision = NEW.applied_revision
      JOIN sessions session
        ON session.workspace_id = NEW.workspace_id
        AND session.session_id = NEW.session_id
      WHERE proposal.workspace_id = NEW.workspace_id
        AND proposal.proposal_id = NEW.proposal_id
        AND proposal.status = 'approved'
        AND review.decision = 'approved'
        AND review.reviewed_at <= NEW.applied_at
        AND proposal.relationship_id = NEW.relationship_id
        AND NEW.applied_revision = proposal.expected_revision + 1
        AND revision.supersedes_revision = proposal.expected_revision
        AND head.current_revision = NEW.applied_revision
        AND (
          (proposal.disposition = 'link' AND revision.lifecycle = 'governed') OR
          (proposal.disposition = 'verify' AND revision.lifecycle = 'verified') OR
          (proposal.disposition = 'reject' AND revision.lifecycle = 'rejected'
            AND revision.lifecycle_reason = proposal.rationale)
        )
        AND revision.provenance_kind = NEW.actor_kind
        AND revision.provenance_person_id IS NEW.person_id
        AND revision.provenance_agent_id IS NEW.agent_id
        AND revision.provenance_rationale = proposal.rationale
        AND revision.recorded_by_kind = NEW.actor_kind
        AND revision.recorded_by_person_id IS NEW.person_id
        AND revision.recorded_by_agent_id IS NEW.agent_id
        AND revision.recorded_at = NEW.applied_at
        AND session.actor_kind = NEW.actor_kind
        AND session.person_id IS NEW.person_id
        AND session.agent_id IS NEW.agent_id
        AND session.permission = 'workspace-owner'
        AND session.revoked_at IS NULL
        AND session.created_at <= NEW.applied_at
        AND session.idle_expires_at > NEW.applied_at
        AND session.absolute_expires_at > NEW.applied_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair application requires approved current owner authority');
    END`

  yield* sql`CREATE TRIGGER relationship_repair_applications_no_update
    BEFORE UPDATE ON relationship_repair_applications
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair applications are immutable');
    END`
  yield* sql`CREATE TRIGGER relationship_repair_applications_no_delete
    BEFORE DELETE ON relationship_repair_applications
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair applications are immutable');
    END`
})
