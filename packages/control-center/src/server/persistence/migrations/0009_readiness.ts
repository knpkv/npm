import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add immutable readiness rules/assessments, current heads, dependencies, and split work queues. */
export const migration0009Readiness = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE TABLE readiness_rule_snapshots (
    workspace_id TEXT NOT NULL,
    rule_id TEXT NOT NULL CHECK(length(rule_id) BETWEEN 1 AND 200),
    rule_version INTEGER NOT NULL CHECK(rule_version >= 1),
    rule_digest TEXT NOT NULL CHECK(
      length(rule_digest) = 71 AND
      rule_digest GLOB 'sha256:*' AND
      substr(rule_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    material_json TEXT NOT NULL CHECK(length(material_json) BETWEEN 2 AND 262144),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, rule_id, rule_version),
    UNIQUE (workspace_id, rule_id, rule_version, rule_digest),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE RESTRICT
  )`

  yield* sql`CREATE TABLE readiness_assessments (
    workspace_id TEXT NOT NULL,
    assessment_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('environment', 'release')),
    release_id TEXT NOT NULL,
    environment_id TEXT,
    release_revision INTEGER NOT NULL CHECK(release_revision >= 1),
    artifact_revision TEXT NOT NULL CHECK(length(artifact_revision) BETWEEN 1 AND 512),
    candidate_digest TEXT NOT NULL CHECK(
      length(candidate_digest) = 71 AND
      candidate_digest GLOB 'sha256:*' AND
      substr(candidate_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    rule_id TEXT NOT NULL CHECK(length(rule_id) BETWEEN 1 AND 200),
    rule_version INTEGER NOT NULL CHECK(rule_version >= 1),
    rule_digest TEXT NOT NULL CHECK(
      length(rule_digest) = 71 AND
      rule_digest GLOB 'sha256:*' AND
      substr(rule_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    derivation_version INTEGER NOT NULL CHECK(derivation_version >= 1),
    previous_assessment_id TEXT,
    verdict TEXT NOT NULL CHECK(verdict IN (
      'blocked', 'ready', 'deploying', 'building', 'shipped', 'held'
    )),
    evaluated_at TEXT NOT NULL,
    next_evaluation_at TEXT,
    assessment_json TEXT NOT NULL CHECK(length(assessment_json) BETWEEN 2 AND 1048576),
    assessment_digest TEXT NOT NULL CHECK(
      length(assessment_digest) = 64 AND
      assessment_digest NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (workspace_id, assessment_id),
    UNIQUE (workspace_id, assessment_id, scope_kind),
    UNIQUE (workspace_id, assessment_id, candidate_digest),
    FOREIGN KEY (workspace_id, release_id, release_revision)
      REFERENCES release_revisions(workspace_id, release_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id, environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, rule_id, rule_version, rule_digest)
      REFERENCES readiness_rule_snapshots(workspace_id, rule_id, rule_version, rule_digest)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, previous_assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    CHECK(
      (scope_kind = 'environment' AND environment_id IS NOT NULL) OR
      (scope_kind = 'release' AND environment_id IS NULL)
    ),
    CHECK(previous_assessment_id IS NULL OR previous_assessment_id <> assessment_id),
    CHECK(next_evaluation_at IS NULL OR evaluated_at <= next_evaluation_at)
  )`

  yield* sql`CREATE TABLE readiness_assessment_evidence (
    workspace_id TEXT NOT NULL,
    assessment_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, assessment_id, evidence_id),
    FOREIGN KEY (workspace_id, assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, evidence_id)
      REFERENCES evidence_items(workspace_id, evidence_id)
      ON DELETE RESTRICT
  )`

  yield* sql`CREATE TABLE readiness_assessment_sources (
    workspace_id TEXT NOT NULL,
    assessment_id TEXT NOT NULL,
    plugin_connection_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, assessment_id, plugin_connection_id),
    FOREIGN KEY (workspace_id, assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id)
      ON DELETE RESTRICT
  )`

  yield* sql`CREATE TABLE readiness_release_children (
    workspace_id TEXT NOT NULL,
    release_assessment_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    environment_assessment_id TEXT NOT NULL,
    environment_candidate_digest TEXT NOT NULL CHECK(
      length(environment_candidate_digest) = 71 AND
      environment_candidate_digest GLOB 'sha256:*' AND
      substr(environment_candidate_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (workspace_id, release_assessment_id, environment_id),
    UNIQUE (workspace_id, release_assessment_id, environment_assessment_id),
    FOREIGN KEY (workspace_id, release_assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, environment_assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, environment_assessment_id, environment_candidate_digest)
      REFERENCES readiness_assessments(workspace_id, assessment_id, candidate_digest)
      ON DELETE RESTRICT
  )`

  yield* sql`CREATE TABLE readiness_environment_heads (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    head_revision INTEGER NOT NULL CHECK(head_revision >= 1),
    assessment_id TEXT NOT NULL,
    candidate_digest TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL CHECK(rule_version >= 1),
    rule_digest TEXT NOT NULL,
    derivation_version INTEGER NOT NULL CHECK(derivation_version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, release_id, environment_id),
    UNIQUE (workspace_id, release_id, environment_id, assessment_id),
    FOREIGN KEY (workspace_id, assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id, environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id)
      ON DELETE RESTRICT,
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE readiness_release_heads (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    head_revision INTEGER NOT NULL CHECK(head_revision >= 1),
    assessment_id TEXT NOT NULL,
    candidate_digest TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL CHECK(rule_version >= 1),
    rule_digest TEXT NOT NULL,
    derivation_version INTEGER NOT NULL CHECK(derivation_version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, release_id),
    UNIQUE (workspace_id, release_id, assessment_id),
    FOREIGN KEY (workspace_id, assessment_id)
      REFERENCES readiness_assessments(workspace_id, assessment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id)
      ON DELETE RESTRICT,
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE readiness_environment_queue (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    invalidation_revision INTEGER NOT NULL CHECK(invalidation_revision >= 1),
    reason TEXT NOT NULL CHECK(reason IN (
      'evidence-changed', 'plugin-health-changed', 'rule-changed',
      'candidate-changed', 'scheduled'
    )),
    source_evidence_id TEXT,
    source_plugin_connection_id TEXT,
    queued_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    claim_owner TEXT,
    claim_expires_at TEXT,
    PRIMARY KEY (workspace_id, release_id, environment_id),
    FOREIGN KEY (workspace_id, release_id, environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, source_evidence_id)
      REFERENCES evidence_items(workspace_id, evidence_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, source_plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id)
      ON DELETE RESTRICT,
    CHECK(queued_at <= available_at),
    CHECK(
      (claim_owner IS NULL AND claim_expires_at IS NULL) OR
      (claim_owner IS NOT NULL AND length(claim_owner) BETWEEN 1 AND 200 AND claim_expires_at IS NOT NULL)
    )
  )`

  yield* sql`CREATE TABLE readiness_release_queue (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    invalidation_revision INTEGER NOT NULL CHECK(invalidation_revision >= 1),
    reason TEXT NOT NULL CHECK(reason IN (
      'environment-assessment-changed', 'rule-changed', 'candidate-changed'
    )),
    source_environment_id TEXT,
    queued_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    claim_owner TEXT,
    claim_expires_at TEXT,
    PRIMARY KEY (workspace_id, release_id),
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id, source_environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id)
      ON DELETE RESTRICT,
    CHECK(queued_at <= available_at),
    CHECK(
      (claim_owner IS NULL AND claim_expires_at IS NULL) OR
      (claim_owner IS NOT NULL AND length(claim_owner) BETWEEN 1 AND 200 AND claim_expires_at IS NOT NULL)
    )
  )`

  yield* sql`CREATE TABLE readiness_evaluation_schedules (
    workspace_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    assessment_id TEXT NOT NULL,
    due_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, release_id, environment_id),
    FOREIGN KEY (workspace_id, release_id, environment_id, assessment_id)
      REFERENCES readiness_environment_heads(workspace_id, release_id, environment_id, assessment_id)
      ON DELETE RESTRICT
  )`

  yield* sql`CREATE INDEX readiness_assessment_scope_idx
    ON readiness_assessments(workspace_id, release_id, environment_id, evaluated_at DESC)`
  yield* sql`CREATE INDEX readiness_assessment_rule_idx
    ON readiness_assessments(workspace_id, rule_id, rule_version, derivation_version)`
  yield* sql`CREATE INDEX readiness_evidence_dependency_idx
    ON readiness_assessment_evidence(workspace_id, evidence_id, assessment_id)`
  yield* sql`CREATE INDEX readiness_source_dependency_idx
    ON readiness_assessment_sources(workspace_id, plugin_connection_id, assessment_id)`
  yield* sql`CREATE INDEX readiness_environment_queue_available_idx
    ON readiness_environment_queue(available_at, claim_expires_at)`
  yield* sql`CREATE INDEX readiness_release_queue_available_idx
    ON readiness_release_queue(available_at, claim_expires_at)`
  yield* sql`CREATE INDEX readiness_schedule_due_idx
    ON readiness_evaluation_schedules(due_at)`

  yield* sql`CREATE VIEW readiness_assessment_dependency_integrity AS
    SELECT assessment.workspace_id, assessment.assessment_id
    FROM readiness_assessments assessment
    WHERE json_type(assessment.assessment_json, '$.evidenceIds') = 'array'
      AND json_type(assessment.assessment_json, '$.sourceFreshness') = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(assessment.assessment_json, '$.evidenceIds') expected
        WHERE NOT EXISTS (
          SELECT 1 FROM readiness_assessment_evidence dependency
          WHERE dependency.workspace_id = assessment.workspace_id
            AND dependency.assessment_id = assessment.assessment_id
            AND dependency.evidence_id = expected.value
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM readiness_assessment_evidence dependency
        WHERE dependency.workspace_id = assessment.workspace_id
          AND dependency.assessment_id = assessment.assessment_id
          AND NOT EXISTS (
            SELECT 1 FROM json_each(assessment.assessment_json, '$.evidenceIds') expected
            WHERE expected.value = dependency.evidence_id
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(assessment.assessment_json, '$.sourceFreshness') expected
        WHERE NOT EXISTS (
          SELECT 1 FROM readiness_assessment_sources dependency
          WHERE dependency.workspace_id = assessment.workspace_id
            AND dependency.assessment_id = assessment.assessment_id
            AND dependency.plugin_connection_id = json_extract(expected.value, '$.pluginConnectionId')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM readiness_assessment_sources dependency
        WHERE dependency.workspace_id = assessment.workspace_id
          AND dependency.assessment_id = assessment.assessment_id
          AND NOT EXISTS (
            SELECT 1 FROM json_each(assessment.assessment_json, '$.sourceFreshness') expected
            WHERE json_extract(expected.value, '$.pluginConnectionId') = dependency.plugin_connection_id
          )
      )`

  yield* sql`CREATE VIEW readiness_release_child_integrity AS
    SELECT assessment.workspace_id, assessment.assessment_id
    FROM readiness_assessments assessment
    WHERE assessment.scope_kind = 'release'
      AND json_type(assessment.assessment_json, '$.environments') = 'array'
      AND json_array_length(assessment.assessment_json, '$.environments') > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(assessment.assessment_json, '$.environments') expected
        WHERE NOT EXISTS (
          SELECT 1 FROM readiness_release_children child
          WHERE child.workspace_id = assessment.workspace_id
            AND child.release_assessment_id = assessment.assessment_id
            AND child.environment_id = json_extract(expected.value, '$.environmentId')
            AND child.environment_assessment_id = json_extract(expected.value, '$.assessmentId')
            AND child.environment_candidate_digest = json_extract(expected.value, '$.candidateDigest')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM readiness_release_children child
        WHERE child.workspace_id = assessment.workspace_id
          AND child.release_assessment_id = assessment.assessment_id
          AND NOT EXISTS (
            SELECT 1 FROM json_each(assessment.assessment_json, '$.environments') expected
            WHERE json_extract(expected.value, '$.environmentId') = child.environment_id
              AND json_extract(expected.value, '$.assessmentId') = child.environment_assessment_id
              AND json_extract(expected.value, '$.candidateDigest') = child.environment_candidate_digest
          )
      )`

  yield* sql`CREATE TRIGGER readiness_assessments_previous_scope
    BEFORE INSERT ON readiness_assessments
    WHEN NEW.previous_assessment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM readiness_assessments previous
      WHERE previous.workspace_id = NEW.workspace_id
        AND previous.assessment_id = NEW.previous_assessment_id
        AND previous.scope_kind = NEW.scope_kind
        AND previous.release_id = NEW.release_id
        AND previous.environment_id IS NEW.environment_id
        AND previous.evaluated_at <= NEW.evaluated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'readiness assessment supersession must preserve scope and chronology');
    END`

  yield* sql`CREATE TRIGGER readiness_release_children_match
    BEFORE INSERT ON readiness_release_children
    WHEN NOT EXISTS (
      SELECT 1
      FROM readiness_assessments release_assessment
      INNER JOIN readiness_assessments environment_assessment
        ON environment_assessment.workspace_id = release_assessment.workspace_id
       AND environment_assessment.assessment_id = NEW.environment_assessment_id
      WHERE release_assessment.workspace_id = NEW.workspace_id
        AND release_assessment.assessment_id = NEW.release_assessment_id
        AND release_assessment.scope_kind = 'release'
        AND environment_assessment.scope_kind = 'environment'
        AND environment_assessment.release_id = release_assessment.release_id
        AND environment_assessment.environment_id = NEW.environment_id
        AND environment_assessment.release_revision = release_assessment.release_revision
        AND environment_assessment.artifact_revision = release_assessment.artifact_revision
        AND environment_assessment.rule_id = release_assessment.rule_id
        AND environment_assessment.rule_version = release_assessment.rule_version
        AND environment_assessment.rule_digest = release_assessment.rule_digest
        AND environment_assessment.derivation_version = release_assessment.derivation_version
        AND environment_assessment.candidate_digest = NEW.environment_candidate_digest
        AND environment_assessment.evaluated_at <= release_assessment.evaluated_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'release readiness child must match its exact release candidate and policy');
    END`

  yield* sql`CREATE TRIGGER readiness_environment_heads_match_insert
    BEFORE INSERT ON readiness_environment_heads
    WHEN NEW.head_revision <> 1 OR NOT EXISTS (
      SELECT 1 FROM readiness_assessments assessment
      INNER JOIN releases release
        ON release.workspace_id = assessment.workspace_id
       AND release.release_id = assessment.release_id
      INNER JOIN release_targets target
        ON target.workspace_id = assessment.workspace_id
       AND target.release_id = assessment.release_id
       AND target.environment_id = assessment.environment_id
       AND target.lifecycle_kind = 'active'
      WHERE assessment.workspace_id = NEW.workspace_id
        AND assessment.assessment_id = NEW.assessment_id
        AND assessment.scope_kind = 'environment'
        AND assessment.release_id = NEW.release_id
        AND assessment.environment_id = NEW.environment_id
        AND assessment.candidate_digest = NEW.candidate_digest
        AND assessment.rule_id = NEW.rule_id
        AND assessment.rule_version = NEW.rule_version
        AND assessment.rule_digest = NEW.rule_digest
        AND assessment.derivation_version = NEW.derivation_version
        AND assessment.previous_assessment_id IS NULL
        AND assessment.release_revision = release.current_revision
        AND EXISTS (
          SELECT 1 FROM readiness_assessment_dependency_integrity integrity
          WHERE integrity.workspace_id = assessment.workspace_id
            AND integrity.assessment_id = assessment.assessment_id
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'environment readiness head must match its exact assessment');
    END`
  yield* sql`CREATE TRIGGER readiness_environment_heads_match_update
    BEFORE UPDATE ON readiness_environment_heads
    WHEN NEW.workspace_id <> OLD.workspace_id
      OR NEW.release_id <> OLD.release_id
      OR NEW.environment_id <> OLD.environment_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.head_revision <> OLD.head_revision + 1 OR NOT EXISTS (
      SELECT 1 FROM readiness_assessments assessment
      INNER JOIN releases release
        ON release.workspace_id = assessment.workspace_id
       AND release.release_id = assessment.release_id
      INNER JOIN release_targets target
        ON target.workspace_id = assessment.workspace_id
       AND target.release_id = assessment.release_id
       AND target.environment_id = assessment.environment_id
       AND target.lifecycle_kind = 'active'
      WHERE assessment.workspace_id = NEW.workspace_id
        AND assessment.assessment_id = NEW.assessment_id
        AND assessment.scope_kind = 'environment'
        AND assessment.release_id = NEW.release_id
        AND assessment.environment_id = NEW.environment_id
        AND assessment.candidate_digest = NEW.candidate_digest
        AND assessment.rule_id = NEW.rule_id
        AND assessment.rule_version = NEW.rule_version
        AND assessment.rule_digest = NEW.rule_digest
        AND assessment.derivation_version = NEW.derivation_version
        AND assessment.previous_assessment_id = OLD.assessment_id
        AND assessment.release_revision = release.current_revision
        AND EXISTS (
          SELECT 1 FROM readiness_assessment_dependency_integrity integrity
          WHERE integrity.workspace_id = assessment.workspace_id
            AND integrity.assessment_id = assessment.assessment_id
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'environment readiness head must advance once to an exact assessment');
    END`

  yield* sql`CREATE TRIGGER readiness_release_heads_match_insert
    BEFORE INSERT ON readiness_release_heads
    WHEN NEW.head_revision <> 1 OR NOT EXISTS (
      SELECT 1 FROM readiness_assessments assessment
      INNER JOIN releases release
        ON release.workspace_id = assessment.workspace_id
       AND release.release_id = assessment.release_id
      WHERE assessment.workspace_id = NEW.workspace_id
        AND assessment.assessment_id = NEW.assessment_id
        AND assessment.scope_kind = 'release'
        AND assessment.release_id = NEW.release_id
        AND assessment.candidate_digest = NEW.candidate_digest
        AND assessment.rule_id = NEW.rule_id
        AND assessment.rule_version = NEW.rule_version
        AND assessment.rule_digest = NEW.rule_digest
        AND assessment.derivation_version = NEW.derivation_version
        AND assessment.previous_assessment_id IS NULL
        AND assessment.release_revision = release.current_revision
        AND EXISTS (
          SELECT 1 FROM readiness_assessment_dependency_integrity integrity
          WHERE integrity.workspace_id = assessment.workspace_id
            AND integrity.assessment_id = assessment.assessment_id
        )
        AND EXISTS (
          SELECT 1 FROM readiness_release_child_integrity integrity
          WHERE integrity.workspace_id = assessment.workspace_id
            AND integrity.assessment_id = assessment.assessment_id
        )
    ) OR NOT EXISTS (
      SELECT 1 FROM readiness_release_children child
      WHERE child.workspace_id = NEW.workspace_id
        AND child.release_assessment_id = NEW.assessment_id
    ) OR EXISTS (
      SELECT 1
      FROM readiness_release_children child
      LEFT JOIN release_targets target
        ON target.workspace_id = child.workspace_id
       AND target.release_id = NEW.release_id
       AND target.environment_id = child.environment_id
       AND target.lifecycle_kind = 'active'
      LEFT JOIN readiness_environment_heads head
        ON head.workspace_id = target.workspace_id
       AND head.release_id = target.release_id
       AND head.environment_id = target.environment_id
      WHERE child.workspace_id = NEW.workspace_id
        AND child.release_assessment_id = NEW.assessment_id
        AND (target.environment_id IS NULL OR head.assessment_id IS NULL OR
          head.assessment_id <> child.environment_assessment_id)
    ) OR EXISTS (
      SELECT 1
      FROM release_targets target
      LEFT JOIN readiness_environment_heads head
        ON head.workspace_id = target.workspace_id
       AND head.release_id = target.release_id
       AND head.environment_id = target.environment_id
      LEFT JOIN readiness_release_children child
        ON child.workspace_id = target.workspace_id
       AND child.release_assessment_id = NEW.assessment_id
       AND child.environment_id = target.environment_id
      WHERE target.workspace_id = NEW.workspace_id
        AND target.release_id = NEW.release_id
        AND target.lifecycle_kind = 'active'
        AND (head.assessment_id IS NULL OR child.environment_assessment_id IS NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'release readiness head must match exact current environment children');
    END`
  yield* sql`CREATE TRIGGER readiness_release_heads_match_update
    BEFORE UPDATE ON readiness_release_heads
    WHEN NEW.workspace_id <> OLD.workspace_id
      OR NEW.release_id <> OLD.release_id
      OR NEW.created_at <> OLD.created_at
      OR NEW.head_revision <> OLD.head_revision + 1 OR NOT EXISTS (
      SELECT 1 FROM readiness_assessments assessment
      INNER JOIN releases release
        ON release.workspace_id = assessment.workspace_id
       AND release.release_id = assessment.release_id
      WHERE assessment.workspace_id = NEW.workspace_id
        AND assessment.assessment_id = NEW.assessment_id
        AND assessment.scope_kind = 'release'
        AND assessment.release_id = NEW.release_id
        AND assessment.candidate_digest = NEW.candidate_digest
        AND assessment.rule_id = NEW.rule_id
        AND assessment.rule_version = NEW.rule_version
        AND assessment.rule_digest = NEW.rule_digest
        AND assessment.derivation_version = NEW.derivation_version
        AND assessment.previous_assessment_id = OLD.assessment_id
        AND assessment.release_revision = release.current_revision
        AND EXISTS (
          SELECT 1 FROM readiness_assessment_dependency_integrity integrity
          WHERE integrity.workspace_id = assessment.workspace_id
            AND integrity.assessment_id = assessment.assessment_id
        )
        AND EXISTS (
          SELECT 1 FROM readiness_release_child_integrity integrity
          WHERE integrity.workspace_id = assessment.workspace_id
            AND integrity.assessment_id = assessment.assessment_id
        )
    ) OR NOT EXISTS (
      SELECT 1 FROM readiness_release_children child
      WHERE child.workspace_id = NEW.workspace_id
        AND child.release_assessment_id = NEW.assessment_id
    ) OR EXISTS (
      SELECT 1
      FROM readiness_release_children child
      LEFT JOIN release_targets target
        ON target.workspace_id = child.workspace_id
       AND target.release_id = NEW.release_id
       AND target.environment_id = child.environment_id
       AND target.lifecycle_kind = 'active'
      LEFT JOIN readiness_environment_heads head
        ON head.workspace_id = target.workspace_id
       AND head.release_id = target.release_id
       AND head.environment_id = target.environment_id
      WHERE child.workspace_id = NEW.workspace_id
        AND child.release_assessment_id = NEW.assessment_id
        AND (target.environment_id IS NULL OR head.assessment_id IS NULL OR
          head.assessment_id <> child.environment_assessment_id)
    ) OR EXISTS (
      SELECT 1
      FROM release_targets target
      LEFT JOIN readiness_environment_heads head
        ON head.workspace_id = target.workspace_id
       AND head.release_id = target.release_id
       AND head.environment_id = target.environment_id
      LEFT JOIN readiness_release_children child
        ON child.workspace_id = target.workspace_id
       AND child.release_assessment_id = NEW.assessment_id
       AND child.environment_id = target.environment_id
      WHERE target.workspace_id = NEW.workspace_id
        AND target.release_id = NEW.release_id
        AND target.lifecycle_kind = 'active'
        AND (head.assessment_id IS NULL OR child.environment_assessment_id IS NULL)
    )
    BEGIN
      SELECT RAISE(ABORT, 'release readiness head must advance once with current environment children');
    END`

  for (const table of ["readiness_assessment_evidence", "readiness_assessment_sources"]) {
    yield* sql`CREATE TRIGGER ${sql(`${table}_seal_published`)}
      BEFORE INSERT ON ${sql(table)}
      WHEN EXISTS (
        SELECT 1 FROM readiness_environment_heads head
        WHERE head.workspace_id = NEW.workspace_id
          AND head.assessment_id = NEW.assessment_id
        UNION ALL
        SELECT 1 FROM readiness_release_heads head
        WHERE head.workspace_id = NEW.workspace_id
          AND head.assessment_id = NEW.assessment_id
        UNION ALL
        SELECT 1 FROM readiness_assessments successor
        WHERE successor.workspace_id = NEW.workspace_id
          AND successor.previous_assessment_id = NEW.assessment_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'published readiness dependencies are sealed');
      END`
  }

  yield* sql`CREATE TRIGGER readiness_release_children_seal_published
    BEFORE INSERT ON readiness_release_children
    WHEN EXISTS (
      SELECT 1 FROM readiness_release_heads head
      WHERE head.workspace_id = NEW.workspace_id
        AND head.assessment_id = NEW.release_assessment_id
      UNION ALL
      SELECT 1 FROM readiness_assessments successor
      WHERE successor.workspace_id = NEW.workspace_id
        AND successor.previous_assessment_id = NEW.release_assessment_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'published release readiness children are sealed');
    END`

  yield* sql`CREATE TRIGGER readiness_schedules_exact_insert
    BEFORE INSERT ON readiness_evaluation_schedules
    WHEN NOT EXISTS (
      SELECT 1
      FROM readiness_environment_heads head
      INNER JOIN readiness_assessments assessment
        ON assessment.workspace_id = head.workspace_id
       AND assessment.assessment_id = head.assessment_id
      WHERE head.workspace_id = NEW.workspace_id
        AND head.release_id = NEW.release_id
        AND head.environment_id = NEW.environment_id
        AND head.assessment_id = NEW.assessment_id
        AND assessment.next_evaluation_at = NEW.due_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'readiness schedule must match the current assessment boundary');
    END`
  yield* sql`CREATE TRIGGER readiness_schedules_exact_update
    BEFORE UPDATE ON readiness_evaluation_schedules
    WHEN NOT EXISTS (
      SELECT 1
      FROM readiness_environment_heads head
      INNER JOIN readiness_assessments assessment
        ON assessment.workspace_id = head.workspace_id
       AND assessment.assessment_id = head.assessment_id
      WHERE head.workspace_id = NEW.workspace_id
        AND head.release_id = NEW.release_id
        AND head.environment_id = NEW.environment_id
        AND head.assessment_id = NEW.assessment_id
        AND assessment.next_evaluation_at = NEW.due_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'readiness schedule must match the current assessment boundary');
    END`

  for (
    const table of [
      "readiness_rule_snapshots",
      "readiness_assessments",
      "readiness_assessment_evidence",
      "readiness_assessment_sources",
      "readiness_release_children"
    ]
  ) {
    yield* sql`CREATE TRIGGER ${sql(`${table}_no_update`)}
      BEFORE UPDATE ON ${sql(table)}
      BEGIN
        SELECT RAISE(ABORT, 'readiness audit records are immutable');
      END`
    yield* sql`CREATE TRIGGER ${sql(`${table}_no_delete`)}
      BEFORE DELETE ON ${sql(table)}
      BEGIN
        SELECT RAISE(ABORT, 'readiness audit records are immutable');
      END`
  }

  yield* sql`CREATE TRIGGER readiness_environment_heads_no_delete
    BEFORE DELETE ON readiness_environment_heads
    BEGIN
      SELECT RAISE(ABORT, 'environment readiness heads are durable');
    END`
  yield* sql`CREATE TRIGGER readiness_release_heads_no_delete
    BEFORE DELETE ON readiness_release_heads
    BEGIN
      SELECT RAISE(ABORT, 'release readiness heads are durable');
    END`
})
