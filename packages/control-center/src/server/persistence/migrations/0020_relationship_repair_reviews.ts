import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add immutable proposal reviews and a guarded pending-to-final status transition. */
export const migration0020RelationshipRepairReviews = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`DROP TRIGGER relationship_repair_proposal_current_candidate`
  yield* sql`DROP TRIGGER relationship_repair_proposal_authenticated_origin`
  yield* sql`DROP INDEX relationship_repair_one_pending_revision_idx`
  yield* sql`DROP INDEX relationship_repair_release_pending_idx`
  yield* sql`ALTER TABLE relationship_repair_proposals
    RENAME TO relationship_repair_proposals_v1`

  yield* sql`CREATE TABLE relationship_repair_proposals (
    workspace_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version = 2),
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
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
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

  yield* sql`INSERT INTO relationship_repair_proposals (
    workspace_id, proposal_id, schema_version, release_id, environment_id,
    relationship_id, expected_revision, disposition, rationale, actor_kind,
    person_id, agent_id, session_id, status, proposed_at
  ) SELECT
    workspace_id, proposal_id, 2, release_id, environment_id,
    relationship_id, expected_revision, disposition, rationale, actor_kind,
    person_id, agent_id, session_id, status, proposed_at
  FROM relationship_repair_proposals_v1`
  yield* sql`DROP TABLE relationship_repair_proposals_v1`

  yield* sql`CREATE UNIQUE INDEX relationship_repair_one_pending_revision_idx
    ON relationship_repair_proposals(workspace_id, relationship_id, expected_revision)
    WHERE status = 'pending'`
  yield* sql`CREATE INDEX relationship_repair_release_status_idx
    ON relationship_repair_proposals(workspace_id, release_id, status, proposed_at DESC, proposal_id DESC)`

  yield* sql`CREATE TRIGGER relationship_repair_proposal_pending_insert
    BEFORE INSERT ON relationship_repair_proposals
    WHEN NEW.status <> 'pending'
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair proposals must begin pending');
    END`

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

  yield* sql`CREATE TABLE relationship_repair_reviews (
    workspace_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
    rationale TEXT NOT NULL CHECK(length(rationale) BETWEEN 1 AND 1000),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'agent')),
    person_id TEXT,
    agent_id TEXT,
    session_id TEXT NOT NULL,
    reviewed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, proposal_id),
    UNIQUE (workspace_id, review_id),
    FOREIGN KEY (workspace_id, proposal_id)
      REFERENCES relationship_repair_proposals(workspace_id, proposal_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, session_id)
      REFERENCES sessions(workspace_id, session_id)
      ON DELETE RESTRICT,
    CHECK(
      (actor_kind = 'human' AND person_id IS NOT NULL AND agent_id IS NULL) OR
      (actor_kind = 'agent' AND agent_id IS NOT NULL AND person_id IS NULL)
    )
  )`

  yield* sql`CREATE TRIGGER relationship_repair_review_authority
    BEFORE INSERT ON relationship_repair_reviews
    WHEN NOT EXISTS (
      SELECT 1
      FROM relationship_repair_proposals proposal
      JOIN sessions session
        ON session.workspace_id = NEW.workspace_id
        AND session.session_id = NEW.session_id
      WHERE proposal.workspace_id = NEW.workspace_id
        AND proposal.proposal_id = NEW.proposal_id
        AND proposal.status = 'pending'
        AND proposal.proposed_at <= NEW.reviewed_at
        AND session.actor_kind = NEW.actor_kind
        AND session.person_id IS NEW.person_id
        AND session.agent_id IS NEW.agent_id
        AND session.permission IN ('workspace-owner', 'workspace-approver')
        AND session.revoked_at IS NULL
        AND session.created_at <= NEW.reviewed_at
        AND session.idle_expires_at > NEW.reviewed_at
        AND session.absolute_expires_at > NEW.reviewed_at
        AND NOT (
          proposal.actor_kind = NEW.actor_kind
          AND proposal.person_id IS NEW.person_id
          AND proposal.agent_id IS NEW.agent_id
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair review requires current independent authority');
    END`

  yield* sql`CREATE TRIGGER relationship_repair_proposal_review_transition
    BEFORE UPDATE ON relationship_repair_proposals
    WHEN NOT (
      OLD.status = 'pending'
      AND NEW.status IN ('approved', 'rejected')
      AND OLD.workspace_id = NEW.workspace_id
      AND OLD.proposal_id = NEW.proposal_id
      AND OLD.schema_version = NEW.schema_version
      AND OLD.release_id = NEW.release_id
      AND OLD.environment_id IS NEW.environment_id
      AND OLD.relationship_id = NEW.relationship_id
      AND OLD.expected_revision = NEW.expected_revision
      AND OLD.disposition = NEW.disposition
      AND OLD.rationale = NEW.rationale
      AND OLD.actor_kind = NEW.actor_kind
      AND OLD.person_id IS NEW.person_id
      AND OLD.agent_id IS NEW.agent_id
      AND OLD.session_id = NEW.session_id
      AND OLD.proposed_at = NEW.proposed_at
      AND EXISTS (
        SELECT 1
        FROM relationship_repair_reviews review
        WHERE review.workspace_id = NEW.workspace_id
          AND review.proposal_id = NEW.proposal_id
          AND review.decision = NEW.status
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair proposal status requires its immutable review');
    END`

  yield* sql`CREATE TRIGGER relationship_repair_review_finalize_proposal
    AFTER INSERT ON relationship_repair_reviews
    BEGIN
      UPDATE relationship_repair_proposals
      SET status = NEW.decision
      WHERE workspace_id = NEW.workspace_id
        AND proposal_id = NEW.proposal_id
        AND status = 'pending';
    END`

  yield* sql`CREATE TRIGGER relationship_repair_proposals_no_delete
    BEFORE DELETE ON relationship_repair_proposals
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair proposals are immutable');
    END`
  yield* sql`CREATE TRIGGER relationship_repair_reviews_no_update
    BEFORE UPDATE ON relationship_repair_reviews
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair reviews are immutable');
    END`
  yield* sql`CREATE TRIGGER relationship_repair_reviews_no_delete
    BEFORE DELETE ON relationship_repair_reviews
    BEGIN
      SELECT RAISE(ABORT, 'relationship repair reviews are immutable');
    END`
})
