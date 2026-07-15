import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Retain immutable head revisions and commit instants for truthful readiness history. */
export const migration0010ReadinessHeadHistory = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const advancedHeads = yield* sql<{ readonly headRevision: number; readonly scopeKind: string }>`
    SELECT head_revision AS headRevision, 'environment' AS scopeKind
    FROM readiness_environment_heads
    WHERE head_revision > 1
    UNION ALL
    SELECT head_revision AS headRevision, 'release' AS scopeKind
    FROM readiness_release_heads
    WHERE head_revision > 1
    LIMIT 1`

  if (advancedHeads.length > 0) {
    return yield* Effect.fail(
      "readiness head history cannot truthfully reconstruct a version 9 head above revision 1"
    )
  }

  yield* sql`ALTER TABLE readiness_environment_queue ADD COLUMN claim_token TEXT`
  yield* sql`ALTER TABLE readiness_release_queue ADD COLUMN claim_token TEXT`
  yield* sql`UPDATE readiness_environment_queue
    SET claim_owner = NULL, claim_expires_at = NULL
    WHERE claim_token IS NULL`
  yield* sql`UPDATE readiness_release_queue
    SET claim_owner = NULL, claim_expires_at = NULL
    WHERE claim_token IS NULL`

  for (const table of ["readiness_environment_queue", "readiness_release_queue"]) {
    for (const operation of ["INSERT", "UPDATE"]) {
      yield* sql.unsafe(`CREATE TRIGGER ${table}_lease_shape_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN NOT (
          (NEW.claim_owner IS NULL AND NEW.claim_token IS NULL AND NEW.claim_expires_at IS NULL) OR
          (NEW.claim_owner IS NOT NULL AND length(NEW.claim_owner) BETWEEN 1 AND 200
            AND NEW.claim_token IS NOT NULL AND length(NEW.claim_token) BETWEEN 1 AND 200
            AND NEW.claim_expires_at IS NOT NULL)
        )
        BEGIN
          SELECT RAISE(ABORT, 'readiness lease fields must be all null or all populated');
        END`)
    }
  }

  yield* sql`CREATE TABLE readiness_head_history (
    workspace_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('environment', 'release')),
    release_id TEXT NOT NULL,
    environment_key TEXT NOT NULL,
    head_revision INTEGER NOT NULL CHECK(head_revision >= 1),
    assessment_id TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, scope_kind, release_id, environment_key, head_revision),
    UNIQUE (workspace_id, assessment_id),
    FOREIGN KEY (workspace_id, assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    CHECK(
      (scope_kind = 'environment' AND length(environment_key) > 0) OR
      (scope_kind = 'release' AND environment_key = '')
    )
  )`

  yield* sql`CREATE INDEX readiness_head_history_assessment_idx
    ON readiness_head_history(workspace_id, assessment_id)`

  yield* sql`CREATE TRIGGER readiness_head_history_exact_insert
    BEFORE INSERT ON readiness_head_history
    WHEN NOT EXISTS (
      SELECT 1
      FROM readiness_assessments assessment
      WHERE assessment.workspace_id = NEW.workspace_id
        AND assessment.assessment_id = NEW.assessment_id
        AND assessment.scope_kind = NEW.scope_kind
        AND assessment.release_id = NEW.release_id
        AND COALESCE(assessment.environment_id, '') = NEW.environment_key
        AND assessment.evaluated_at <= NEW.committed_at
        AND (
          (NEW.head_revision = 1 AND assessment.previous_assessment_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM readiness_head_history previous
            WHERE previous.workspace_id = NEW.workspace_id
              AND previous.scope_kind = NEW.scope_kind
              AND previous.release_id = NEW.release_id
              AND previous.environment_key = NEW.environment_key
          )) OR
          (NEW.head_revision > 1 AND EXISTS (
            SELECT 1 FROM readiness_head_history previous
            WHERE previous.workspace_id = NEW.workspace_id
              AND previous.scope_kind = NEW.scope_kind
              AND previous.release_id = NEW.release_id
              AND previous.environment_key = NEW.environment_key
              AND previous.head_revision = NEW.head_revision - 1
              AND previous.assessment_id = assessment.previous_assessment_id
              AND previous.committed_at <= NEW.committed_at
          ))
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'readiness head history must be exact and contiguous');
    END`

  yield* sql`INSERT INTO readiness_head_history (
      workspace_id, scope_kind, release_id, environment_key,
      head_revision, assessment_id, committed_at
    )
    SELECT workspace_id, 'environment', release_id, environment_id,
           head_revision, assessment_id, updated_at
    FROM readiness_environment_heads`

  yield* sql`INSERT INTO readiness_head_history (
      workspace_id, scope_kind, release_id, environment_key,
      head_revision, assessment_id, committed_at
    )
    SELECT workspace_id, 'release', release_id, '',
           head_revision, assessment_id, updated_at
    FROM readiness_release_heads`

  yield* sql`CREATE TRIGGER readiness_environment_heads_history_insert
    BEFORE INSERT ON readiness_environment_heads
    WHEN NOT EXISTS (
      SELECT 1 FROM readiness_head_history history
      WHERE history.workspace_id = NEW.workspace_id
        AND history.scope_kind = 'environment'
        AND history.release_id = NEW.release_id
        AND history.environment_key = NEW.environment_id
        AND history.head_revision = NEW.head_revision
        AND history.assessment_id = NEW.assessment_id
        AND history.committed_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'environment readiness head must have exact immutable history');
    END`

  yield* sql`CREATE TRIGGER readiness_environment_heads_history_update
    BEFORE UPDATE ON readiness_environment_heads
    WHEN NOT EXISTS (
      SELECT 1 FROM readiness_head_history history
      WHERE history.workspace_id = NEW.workspace_id
        AND history.scope_kind = 'environment'
        AND history.release_id = NEW.release_id
        AND history.environment_key = NEW.environment_id
        AND history.head_revision = NEW.head_revision
        AND history.assessment_id = NEW.assessment_id
        AND history.committed_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'environment readiness head must have exact immutable history');
    END`

  yield* sql`CREATE TRIGGER readiness_release_heads_history_insert
    BEFORE INSERT ON readiness_release_heads
    WHEN NOT EXISTS (
      SELECT 1 FROM readiness_head_history history
      WHERE history.workspace_id = NEW.workspace_id
        AND history.scope_kind = 'release'
        AND history.release_id = NEW.release_id
        AND history.environment_key = ''
        AND history.head_revision = NEW.head_revision
        AND history.assessment_id = NEW.assessment_id
        AND history.committed_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'release readiness head must have exact immutable history');
    END`

  yield* sql`CREATE TRIGGER readiness_release_heads_history_update
    BEFORE UPDATE ON readiness_release_heads
    WHEN NOT EXISTS (
      SELECT 1 FROM readiness_head_history history
      WHERE history.workspace_id = NEW.workspace_id
        AND history.scope_kind = 'release'
        AND history.release_id = NEW.release_id
        AND history.environment_key = ''
        AND history.head_revision = NEW.head_revision
        AND history.assessment_id = NEW.assessment_id
        AND history.committed_at = NEW.updated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'release readiness head must have exact immutable history');
    END`

  for (const operation of ["UPDATE", "DELETE"]) {
    yield* sql.unsafe(`CREATE TRIGGER readiness_head_history_no_${operation.toLowerCase()}
      BEFORE ${operation} ON readiness_head_history
      BEGIN
        SELECT RAISE(ABORT, 'readiness head history is immutable');
      END`)
  }
})
