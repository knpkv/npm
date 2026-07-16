import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** Add immutable entity projections, graph nodes, relationships, and evidence ledgers. */
export const migration0008DeliveryGraph = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE release_targets
    ADD COLUMN lifecycle_kind TEXT NOT NULL DEFAULT 'active'
      CHECK(lifecycle_kind IN ('active', 'ended'))`
  yield* sql`ALTER TABLE release_targets
    ADD COLUMN ended_at TEXT`
  yield* sql`CREATE TRIGGER release_targets_lifecycle_insert
    BEFORE INSERT ON release_targets
    WHEN NOT (
      (NEW.lifecycle_kind = 'active' AND NEW.ended_at IS NULL) OR
      (NEW.lifecycle_kind = 'ended' AND NEW.ended_at IS NOT NULL AND
        NEW.created_at <= NEW.ended_at)
    )
    BEGIN
      SELECT RAISE(ABORT, 'release target lifecycle is invalid');
    END`
  yield* sql`CREATE TRIGGER release_targets_lifecycle_update
    BEFORE UPDATE ON release_targets
    WHEN NOT (
      (NEW.lifecycle_kind = 'active' AND NEW.ended_at IS NULL) OR
      (NEW.lifecycle_kind = 'ended' AND NEW.ended_at IS NOT NULL AND
        NEW.created_at <= NEW.ended_at)
    )
    BEGIN
      SELECT RAISE(ABORT, 'release target lifecycle is invalid');
    END`
  yield* sql`CREATE TRIGGER release_targets_no_delete
    BEFORE DELETE ON release_targets
    BEGIN
      SELECT RAISE(ABORT, 'release target identity is durable');
    END`

  yield* sql`CREATE TABLE entity_projection_revisions (
    workspace_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    projection_revision INTEGER NOT NULL CHECK(projection_revision >= 1),
    source_entity_revision INTEGER NOT NULL CHECK(source_entity_revision >= 1),
    supersedes_projection_revision INTEGER,
    projection_schema_version INTEGER NOT NULL CHECK(projection_schema_version >= 1),
    entity_state TEXT NOT NULL CHECK(entity_state IN ('present', 'deleted')),
    display_key TEXT NOT NULL CHECK(length(display_key) BETWEEN 1 AND 200),
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
    extension_json TEXT NOT NULL CHECK(length(extension_json) BETWEEN 2 AND 65536),
    extension_digest TEXT NOT NULL CHECK(
      length(extension_digest) = 64 AND
      extension_digest NOT GLOB '*[^0-9a-f]*'
    ),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, entity_id, projection_revision),
    FOREIGN KEY (workspace_id, entity_id, source_entity_revision)
      REFERENCES entity_revisions(workspace_id, entity_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, entity_id, supersedes_projection_revision)
      REFERENCES entity_projection_revisions(workspace_id, entity_id, projection_revision)
      ON DELETE RESTRICT,
    CHECK(
      (projection_revision = 1 AND supersedes_projection_revision IS NULL) OR
      (projection_revision > 1 AND supersedes_projection_revision = projection_revision - 1)
    )
  )`

  yield* sql`CREATE TABLE delivery_nodes (
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_key_digest TEXT NOT NULL CHECK(
      length(node_key_digest) = 64 AND
      node_key_digest NOT GLOB '*[^0-9a-f]*'
    ),
    node_kind TEXT NOT NULL CHECK(node_kind IN ('entity', 'release', 'environment')),
    endpoint_kind TEXT NOT NULL CHECK(endpoint_kind IN (
      'issue', 'pull-request', 'page', 'pipeline-execution',
      'deployment', 'time-entry', 'release', 'environment'
    )),
    resolution_state TEXT NOT NULL CHECK(resolution_state IN ('resolved', 'missing')),
    entity_id TEXT,
    release_id TEXT,
    environment_id TEXT,
    expected_entity_kind TEXT CHECK(
      expected_entity_kind IS NULL OR expected_entity_kind IN (
        'issue', 'pull-request', 'page', 'pipeline-execution',
        'deployment', 'time-entry'
      )
    ),
    missing_key TEXT CHECK(missing_key IS NULL OR length(missing_key) BETWEEN 1 AND 512),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, node_id),
    UNIQUE (workspace_id, node_id, endpoint_kind),
    UNIQUE (workspace_id, node_key_digest),
    FOREIGN KEY (workspace_id, entity_id)
      REFERENCES entities(workspace_id, entity_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id, environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id)
      ON DELETE RESTRICT,
    CHECK(
      (
        resolution_state = 'resolved' AND
        expected_entity_kind IS NULL AND missing_key IS NULL AND
        (
          (node_kind = 'entity' AND endpoint_kind IN (
            'issue', 'pull-request', 'page', 'pipeline-execution', 'deployment', 'time-entry'
          ) AND entity_id IS NOT NULL AND release_id IS NULL AND environment_id IS NULL) OR
          (node_kind = 'release' AND endpoint_kind = 'release' AND
            entity_id IS NULL AND release_id IS NOT NULL AND environment_id IS NULL) OR
          (node_kind = 'environment' AND endpoint_kind = 'environment' AND
            entity_id IS NULL AND release_id IS NOT NULL AND environment_id IS NOT NULL)
        )
      ) OR (
        resolution_state = 'missing' AND
        entity_id IS NULL AND release_id IS NULL AND environment_id IS NULL AND
        missing_key IS NOT NULL AND
        (
          (node_kind = 'entity' AND expected_entity_kind IS NOT NULL AND
            endpoint_kind = expected_entity_kind) OR
          (node_kind IN ('release', 'environment') AND expected_entity_kind IS NULL AND
            endpoint_kind = node_kind)
        )
      )
    )
  )`

  yield* sql`CREATE TABLE evidence_items (
    workspace_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
    evidence_digest TEXT NOT NULL CHECK(
      length(evidence_digest) = 64 AND
      evidence_digest NOT GLOB '*[^0-9a-f]*'
    ),
    origin_kind TEXT NOT NULL CHECK(origin_kind IN ('plugin', 'human', 'agent', 'system')),
    plugin_connection_id TEXT,
    source_entity_id TEXT,
    source_entity_revision INTEGER,
    person_id TEXT,
    agent_id TEXT,
    system_component TEXT CHECK(
      system_component IS NULL OR length(system_component) BETWEEN 1 AND 200
    ),
    verifier_kind TEXT NOT NULL CHECK(verifier_kind IN ('human', 'agent', 'system')),
    verifier_person_id TEXT,
    verifier_agent_id TEXT,
    verifier_component TEXT CHECK(
      verifier_component IS NULL OR length(verifier_component) BETWEEN 1 AND 200
    ),
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    valid_until TEXT,
    freshness_json TEXT NOT NULL CHECK(length(freshness_json) BETWEEN 2 AND 65536),
    freshness_digest TEXT NOT NULL CHECK(
      length(freshness_digest) = 64 AND
      freshness_digest NOT GLOB '*[^0-9a-f]*'
    ),
    retention_class TEXT NOT NULL CHECK(
      retention_class IN ('audit', 'evidence', 'normalized-cache')
    ),
    retain_until TEXT,
    legal_hold INTEGER NOT NULL CHECK(legal_hold IN (0, 1)),
    PRIMARY KEY (workspace_id, evidence_id),
    UNIQUE (workspace_id, evidence_digest),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    FOREIGN KEY (workspace_id, plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, source_entity_id, source_entity_revision)
      REFERENCES entity_revisions(workspace_id, entity_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, person_id)
      REFERENCES persons(workspace_id, person_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, verifier_person_id)
      REFERENCES persons(workspace_id, person_id)
      ON DELETE RESTRICT,
    CHECK(observed_at <= recorded_at),
    CHECK(valid_until IS NULL OR observed_at < valid_until),
    CHECK(retain_until IS NULL OR recorded_at <= retain_until),
    CHECK(
      (origin_kind = 'plugin' AND plugin_connection_id IS NOT NULL AND
        source_entity_id IS NOT NULL AND source_entity_revision IS NOT NULL AND
        person_id IS NULL AND agent_id IS NULL AND system_component IS NULL) OR
      (origin_kind = 'human' AND plugin_connection_id IS NULL AND
        source_entity_id IS NULL AND source_entity_revision IS NULL AND
        person_id IS NOT NULL AND agent_id IS NULL AND system_component IS NULL) OR
      (origin_kind = 'agent' AND plugin_connection_id IS NULL AND
        source_entity_id IS NULL AND source_entity_revision IS NULL AND
        person_id IS NULL AND agent_id IS NOT NULL AND system_component IS NULL) OR
      (origin_kind = 'system' AND plugin_connection_id IS NULL AND
        source_entity_id IS NULL AND source_entity_revision IS NULL AND
        person_id IS NULL AND agent_id IS NULL AND system_component IS NOT NULL)
    ),
    CHECK(
      (verifier_kind = 'human' AND verifier_person_id IS NOT NULL AND
        verifier_agent_id IS NULL AND verifier_component IS NULL) OR
      (verifier_kind = 'agent' AND verifier_person_id IS NULL AND
        verifier_agent_id IS NOT NULL AND verifier_component IS NULL) OR
      (verifier_kind = 'system' AND verifier_person_id IS NULL AND
        verifier_agent_id IS NULL AND verifier_component IS NOT NULL)
    )
  )`

  yield* sql`CREATE TABLE evidence_claims (
    workspace_id TEXT NOT NULL,
    evidence_claim_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    subject_node_id TEXT NOT NULL,
    predicate TEXT NOT NULL CHECK(predicate IN (
      'relationship-observed', 'status-observed', 'approval-recorded',
      'check-observed', 'execution-observed', 'deployment-observed',
      'documentation-observed', 'time-observed'
    )),
    value_schema_version INTEGER NOT NULL CHECK(value_schema_version >= 1),
    value_json TEXT NOT NULL CHECK(length(value_json) BETWEEN 2 AND 8192),
    value_digest TEXT NOT NULL CHECK(
      length(value_digest) = 64 AND
      value_digest NOT GLOB '*[^0-9a-f]*'
    ),
    supersedes_claim_id TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, evidence_claim_id),
    FOREIGN KEY (workspace_id, evidence_id)
      REFERENCES evidence_items(workspace_id, evidence_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, subject_node_id)
      REFERENCES delivery_nodes(workspace_id, node_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, supersedes_claim_id)
      REFERENCES evidence_claims(workspace_id, evidence_claim_id)
      ON DELETE RESTRICT,
    CHECK(evidence_claim_id <> supersedes_claim_id)
  )`

  yield* sql`CREATE UNIQUE INDEX evidence_claim_single_successor_idx
    ON evidence_claims(workspace_id, supersedes_claim_id)
    WHERE supersedes_claim_id IS NOT NULL`

  yield* sql`CREATE TABLE relationship_heads (
    workspace_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK(current_revision >= 1),
    edge_digest TEXT NOT NULL CHECK(
      length(edge_digest) = 64 AND
      edge_digest NOT GLOB '*[^0-9a-f]*'
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, relationship_id),
    UNIQUE (workspace_id, edge_digest),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
    CHECK(created_at <= updated_at)
  )`

  yield* sql`CREATE TABLE relationship_revisions (
    workspace_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    supersedes_revision INTEGER,
    schema_version INTEGER NOT NULL CHECK(schema_version >= 1),
    kind TEXT NOT NULL CHECK(kind IN (
      'contains', 'implements', 'depends-on', 'verified-by',
      'delivered-by', 'documented-by', 'tracks-time-for'
    )),
    source_node_id TEXT NOT NULL,
    source_node_kind TEXT NOT NULL CHECK(source_node_kind IN (
      'issue', 'pull-request', 'page', 'pipeline-execution',
      'deployment', 'time-entry', 'release', 'environment'
    )),
    target_node_id TEXT NOT NULL,
    target_node_kind TEXT NOT NULL CHECK(target_node_kind IN (
      'issue', 'pull-request', 'page', 'pipeline-execution',
      'deployment', 'time-entry', 'release', 'environment'
    )),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN (
      'missing', 'inferred', 'proposed', 'verified',
      'governed', 'rejected', 'superseded'
    )),
    lifecycle_reason TEXT CHECK(
      lifecycle_reason IS NULL OR length(lifecycle_reason) BETWEEN 1 AND 1000
    ),
    release_id TEXT,
    environment_id TEXT,
    confidence_kind TEXT NOT NULL CHECK(
      confidence_kind IN ('unknown', 'inferred', 'confirmed')
    ),
    confidence_score REAL CHECK(
      confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1
    ),
    confidence_rationale TEXT CHECK(
      confidence_rationale IS NULL OR length(confidence_rationale) BETWEEN 1 AND 1000
    ),
    provenance_kind TEXT NOT NULL CHECK(
      provenance_kind IN ('plugin', 'human', 'agent', 'rule')
    ),
    provenance_plugin_connection_id TEXT,
    provenance_source_entity_id TEXT,
    provenance_source_entity_revision INTEGER,
    provenance_person_id TEXT,
    provenance_agent_id TEXT,
    provenance_rule_id TEXT CHECK(
      provenance_rule_id IS NULL OR length(provenance_rule_id) BETWEEN 1 AND 200
    ),
    provenance_rule_version INTEGER CHECK(
      provenance_rule_version IS NULL OR provenance_rule_version >= 1
    ),
    provenance_rationale TEXT CHECK(
      provenance_rationale IS NULL OR length(provenance_rationale) BETWEEN 1 AND 1000
    ),
    recorded_by_kind TEXT NOT NULL CHECK(
      recorded_by_kind IN ('human', 'agent', 'system')
    ),
    recorded_by_person_id TEXT,
    recorded_by_agent_id TEXT,
    recorded_by_component TEXT CHECK(
      recorded_by_component IS NULL OR length(recorded_by_component) BETWEEN 1 AND 200
    ),
    effective_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    revision_digest TEXT NOT NULL CHECK(
      length(revision_digest) = 64 AND
      revision_digest NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (workspace_id, relationship_id, revision),
    UNIQUE (workspace_id, relationship_id, revision_digest),
    FOREIGN KEY (workspace_id, relationship_id)
      REFERENCES relationship_heads(workspace_id, relationship_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, relationship_id, supersedes_revision)
      REFERENCES relationship_revisions(workspace_id, relationship_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, source_node_id, source_node_kind)
      REFERENCES delivery_nodes(workspace_id, node_id, endpoint_kind)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, target_node_id, target_node_kind)
      REFERENCES delivery_nodes(workspace_id, node_id, endpoint_kind)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id)
      REFERENCES releases(workspace_id, release_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, release_id, environment_id)
      REFERENCES release_targets(workspace_id, release_id, environment_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, provenance_plugin_connection_id)
      REFERENCES plugin_connections(workspace_id, plugin_connection_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (
      workspace_id,
      provenance_source_entity_id,
      provenance_source_entity_revision
    ) REFERENCES entity_revisions(workspace_id, entity_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, provenance_person_id)
      REFERENCES persons(workspace_id, person_id)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, recorded_by_person_id)
      REFERENCES persons(workspace_id, person_id)
      ON DELETE RESTRICT,
    CHECK(source_node_id <> target_node_id),
    CHECK(
      (kind = 'contains' AND source_node_kind = 'release' AND target_node_kind IN (
        'issue', 'pull-request', 'page', 'pipeline-execution', 'deployment', 'time-entry'
      )) OR
      (kind = 'implements' AND source_node_kind = 'pull-request' AND target_node_kind = 'issue') OR
      kind = 'depends-on' OR
      (kind IN ('verified-by', 'delivered-by') AND
        source_node_kind = 'pull-request' AND target_node_kind = 'pipeline-execution') OR
      (kind = 'documented-by' AND source_node_kind IN ('issue', 'release') AND
        target_node_kind = 'page') OR
      (kind = 'tracks-time-for' AND source_node_kind = 'time-entry' AND target_node_kind = 'issue')
    ),
    CHECK(effective_at <= recorded_at),
    CHECK(
      (revision = 1 AND supersedes_revision IS NULL) OR
      (revision > 1 AND supersedes_revision = revision - 1)
    ),
    CHECK(
      (environment_id IS NULL) OR
      (release_id IS NOT NULL)
    ),
    CHECK(kind <> 'contains' OR release_id IS NOT NULL),
    CHECK(
      (confidence_kind = 'inferred' AND confidence_score IS NOT NULL) OR
      (confidence_kind IN ('unknown', 'confirmed') AND confidence_score IS NULL)
    ),
    CHECK(lifecycle <> 'inferred' OR confidence_kind <> 'confirmed'),
    CHECK(
      confidence_kind = 'confirmed' OR confidence_rationale IS NOT NULL
    ),
    CHECK(
      lifecycle NOT IN ('missing', 'rejected', 'superseded') OR
      lifecycle_reason IS NOT NULL
    ),
    CHECK(
      (provenance_kind = 'plugin' AND provenance_plugin_connection_id IS NOT NULL AND
        provenance_source_entity_id IS NOT NULL AND provenance_source_entity_revision IS NOT NULL AND
        provenance_person_id IS NULL AND provenance_agent_id IS NULL AND
        provenance_rule_id IS NULL AND provenance_rule_version IS NULL) OR
      (provenance_kind = 'human' AND provenance_plugin_connection_id IS NULL AND
        provenance_source_entity_id IS NULL AND provenance_source_entity_revision IS NULL AND
        provenance_person_id IS NOT NULL AND provenance_agent_id IS NULL AND
        provenance_rule_id IS NULL AND provenance_rule_version IS NULL) OR
      (provenance_kind = 'agent' AND provenance_plugin_connection_id IS NULL AND
        provenance_source_entity_id IS NULL AND provenance_source_entity_revision IS NULL AND
        provenance_person_id IS NULL AND provenance_agent_id IS NOT NULL AND
        provenance_rule_id IS NULL AND provenance_rule_version IS NULL) OR
      (provenance_kind = 'rule' AND provenance_plugin_connection_id IS NULL AND
        provenance_source_entity_id IS NULL AND provenance_source_entity_revision IS NULL AND
        provenance_person_id IS NULL AND provenance_agent_id IS NULL AND
        provenance_rule_id IS NOT NULL AND provenance_rule_version IS NOT NULL)
    ),
    CHECK(
      (recorded_by_kind = 'human' AND recorded_by_person_id IS NOT NULL AND
        recorded_by_agent_id IS NULL AND recorded_by_component IS NULL) OR
      (recorded_by_kind = 'agent' AND recorded_by_person_id IS NULL AND
        recorded_by_agent_id IS NOT NULL AND recorded_by_component IS NULL) OR
      (recorded_by_kind = 'system' AND recorded_by_person_id IS NULL AND
        recorded_by_agent_id IS NULL AND recorded_by_component IS NOT NULL)
    )
  )`

  yield* sql`CREATE TABLE relationship_revision_evidence (
    workspace_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    relationship_revision INTEGER NOT NULL,
    evidence_claim_id TEXT NOT NULL,
    PRIMARY KEY (
      workspace_id,
      relationship_id,
      relationship_revision,
      evidence_claim_id
    ),
    FOREIGN KEY (workspace_id, relationship_id, relationship_revision)
      REFERENCES relationship_revisions(workspace_id, relationship_id, revision)
      ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, evidence_claim_id)
      REFERENCES evidence_claims(workspace_id, evidence_claim_id)
      ON DELETE RESTRICT
  )`

  yield* sql`CREATE INDEX entity_projection_state_idx
    ON entity_projection_revisions(workspace_id, entity_state, recorded_at DESC)`
  yield* sql`CREATE INDEX delivery_nodes_entity_idx
    ON delivery_nodes(workspace_id, entity_id)
    WHERE entity_id IS NOT NULL`
  yield* sql`CREATE INDEX delivery_nodes_release_idx
    ON delivery_nodes(workspace_id, release_id, environment_id)
    WHERE release_id IS NOT NULL`
  yield* sql`CREATE INDEX delivery_nodes_missing_idx
    ON delivery_nodes(workspace_id, expected_entity_kind, created_at DESC)
    WHERE resolution_state = 'missing'`
  yield* sql`CREATE INDEX evidence_retention_idx
    ON evidence_items(workspace_id, legal_hold, retain_until)
    WHERE retain_until IS NOT NULL`
  yield* sql`CREATE INDEX evidence_source_revision_idx
    ON evidence_items(workspace_id, source_entity_id, source_entity_revision)
    WHERE source_entity_id IS NOT NULL`
  yield* sql`CREATE INDEX evidence_claim_subject_idx
    ON evidence_claims(workspace_id, subject_node_id, predicate, recorded_at DESC)`
  yield* sql`CREATE INDEX relationship_revision_source_idx
    ON relationship_revisions(workspace_id, source_node_id, kind, recorded_at DESC)`
  yield* sql`CREATE INDEX relationship_revision_target_idx
    ON relationship_revisions(workspace_id, target_node_id, kind, recorded_at DESC)`
  yield* sql`CREATE INDEX relationship_revision_scope_idx
    ON relationship_revisions(workspace_id, release_id, environment_id, recorded_at DESC)`

  yield* sql`CREATE TRIGGER entity_projection_revisions_entity_kind
    BEFORE INSERT ON entity_projection_revisions
    WHEN NOT EXISTS (
      SELECT 1
      FROM entities
      WHERE workspace_id = NEW.workspace_id
        AND entity_id = NEW.entity_id
        AND CASE entity_type
          WHEN 'pipeline' THEN 'pipeline-execution'
          ELSE entity_type
        END = json_extract(NEW.extension_json, '$._tag')
    )
    BEGIN
      SELECT RAISE(ABORT, 'entity projection kind must match its canonical entity');
    END`
  yield* sql`CREATE TRIGGER delivery_nodes_entity_kind
    BEFORE INSERT ON delivery_nodes
    WHEN NEW.resolution_state = 'resolved' AND NEW.node_kind = 'entity' AND NOT EXISTS (
      SELECT 1
      FROM entities
      WHERE workspace_id = NEW.workspace_id
        AND entity_id = NEW.entity_id
        AND CASE entity_type
          WHEN 'pipeline' THEN 'pipeline-execution'
          ELSE entity_type
        END = NEW.endpoint_kind
    )
    BEGIN
      SELECT RAISE(ABORT, 'delivery node kind must match its canonical entity');
    END`
  yield* sql`CREATE TRIGGER evidence_items_plugin_source_owner
    BEFORE INSERT ON evidence_items
    WHEN NEW.origin_kind = 'plugin' AND NOT EXISTS (
      SELECT 1
      FROM entities
      WHERE workspace_id = NEW.workspace_id
        AND entity_id = NEW.source_entity_id
        AND plugin_connection_id = NEW.plugin_connection_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'plugin evidence must reference an entity owned by the same connection');
    END`
  yield* sql`CREATE TRIGGER evidence_items_freshness_connection
    BEFORE INSERT ON evidence_items
    WHEN NEW.origin_kind = 'plugin' AND NOT EXISTS (
      SELECT 1
      FROM entities entity
      INNER JOIN entity_revisions revision
        ON revision.workspace_id = entity.workspace_id
       AND revision.entity_id = entity.entity_id
      WHERE entity.workspace_id = NEW.workspace_id
        AND entity.entity_id = NEW.source_entity_id
        AND revision.revision = NEW.source_entity_revision
        AND json_extract(NEW.freshness_json, '$.provenance._tag') IN ('provider', 'cache')
        AND entity.plugin_connection_id =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.pluginConnectionId')
        AND entity.provider_id =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.providerId')
        AND entity.vendor_immutable_id =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.vendorImmutableId')
        AND revision.source_revision =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.revision')
        AND revision.source_url IS
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.sourceUrl')
        AND revision.first_observed_at =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.firstObservedAt')
        AND revision.last_observed_at =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.lastObservedAt')
        AND revision.synchronized_at =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.synchronizedAt')
        AND revision.normalization_schema_version =
          json_extract(NEW.freshness_json, '$.provenance.sourceRevision.normalizationSchemaVersion')
    )
    BEGIN
      SELECT RAISE(ABORT, 'plugin evidence attribution must match its exact freshness source revision');
    END`
  yield* sql`CREATE TRIGGER relationship_revisions_plugin_source_owner
    BEFORE INSERT ON relationship_revisions
    WHEN NEW.provenance_kind = 'plugin' AND NOT EXISTS (
      SELECT 1
      FROM entities
      WHERE workspace_id = NEW.workspace_id
        AND entity_id = NEW.provenance_source_entity_id
        AND plugin_connection_id = NEW.provenance_plugin_connection_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'plugin relationship provenance must reference an entity owned by the same connection');
    END`
  yield* sql`CREATE TRIGGER relationship_revisions_contains_release_scope
    BEFORE INSERT ON relationship_revisions
    WHEN NEW.kind = 'contains' AND NOT EXISTS (
      SELECT 1
      FROM delivery_nodes
      WHERE workspace_id = NEW.workspace_id
        AND node_id = NEW.source_node_id
        AND node_kind = 'release'
        AND resolution_state = 'resolved'
        AND release_id = NEW.release_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'release containment scope must match its resolved release source');
    END`

  yield* sql`CREATE TRIGGER entity_projection_revisions_chronological
    BEFORE INSERT ON entity_projection_revisions
    WHEN NEW.supersedes_projection_revision IS NOT NULL AND NEW.recorded_at < (
      SELECT recorded_at
      FROM entity_projection_revisions
      WHERE workspace_id = NEW.workspace_id
        AND entity_id = NEW.entity_id
        AND projection_revision = NEW.supersedes_projection_revision
    )
    BEGIN
      SELECT RAISE(ABORT, 'entity projection revisions must be chronological');
    END`
  yield* sql`CREATE TRIGGER entity_projection_revisions_source_monotonic
    BEFORE INSERT ON entity_projection_revisions
    WHEN NEW.supersedes_projection_revision IS NOT NULL AND
      NEW.source_entity_revision < (
        SELECT source_entity_revision
        FROM entity_projection_revisions
        WHERE workspace_id = NEW.workspace_id
          AND entity_id = NEW.entity_id
          AND projection_revision = NEW.supersedes_projection_revision
      )
    BEGIN
      SELECT RAISE(ABORT, 'entity projection source revisions must not regress');
    END`
  yield* sql`CREATE TRIGGER evidence_claims_after_evidence
    BEFORE INSERT ON evidence_claims
    WHEN NOT EXISTS (
      SELECT 1
      FROM evidence_items
      WHERE workspace_id = NEW.workspace_id
        AND evidence_id = NEW.evidence_id
        AND recorded_at <= NEW.recorded_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'evidence claims must not predate their evidence');
    END`
  yield* sql`CREATE TRIGGER evidence_claims_chronological
    BEFORE INSERT ON evidence_claims
    WHEN NEW.supersedes_claim_id IS NOT NULL AND NEW.recorded_at < (
      SELECT recorded_at
      FROM evidence_claims
      WHERE workspace_id = NEW.workspace_id
        AND evidence_claim_id = NEW.supersedes_claim_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'evidence claim supersession must be chronological');
    END`
  yield* sql`CREATE TRIGGER evidence_claims_same_fact
    BEFORE INSERT ON evidence_claims
    WHEN NEW.supersedes_claim_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM evidence_claims
      WHERE workspace_id = NEW.workspace_id
        AND evidence_claim_id = NEW.supersedes_claim_id
        AND subject_node_id = NEW.subject_node_id
        AND predicate = NEW.predicate
    )
    BEGIN
      SELECT RAISE(ABORT, 'evidence claim supersession must preserve fact identity');
    END`
  yield* sql`CREATE TRIGGER relationship_revisions_chronological
    BEFORE INSERT ON relationship_revisions
    WHEN NEW.supersedes_revision IS NOT NULL AND NEW.recorded_at < (
      SELECT recorded_at
      FROM relationship_revisions
      WHERE workspace_id = NEW.workspace_id
        AND relationship_id = NEW.relationship_id
        AND revision = NEW.supersedes_revision
    )
    BEGIN
      SELECT RAISE(ABORT, 'relationship revisions must be chronological');
    END`
  yield* sql`CREATE TRIGGER relationship_revision_evidence_causal
    BEFORE INSERT ON relationship_revision_evidence
    WHEN NOT EXISTS (
      SELECT 1
      FROM relationship_revisions relationship
      INNER JOIN evidence_claims claim
        ON claim.workspace_id = relationship.workspace_id
       AND claim.evidence_claim_id = NEW.evidence_claim_id
      WHERE relationship.workspace_id = NEW.workspace_id
        AND relationship.relationship_id = NEW.relationship_id
        AND relationship.revision = NEW.relationship_revision
        AND claim.recorded_at <= relationship.recorded_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'relationships must not predate their evidence claims');
    END`

  yield* sql`CREATE TRIGGER entity_projection_revisions_no_update
    BEFORE UPDATE ON entity_projection_revisions
    BEGIN
      SELECT RAISE(ABORT, 'entity projection revisions are immutable');
    END`
  yield* sql`CREATE TRIGGER entity_projection_revisions_no_delete
    BEFORE DELETE ON entity_projection_revisions
    BEGIN
      SELECT RAISE(ABORT, 'entity projection revisions are immutable');
    END`
  yield* sql`CREATE TRIGGER delivery_nodes_no_update
    BEFORE UPDATE ON delivery_nodes
    BEGIN
      SELECT RAISE(ABORT, 'delivery nodes are immutable');
    END`
  yield* sql`CREATE TRIGGER delivery_nodes_no_delete
    BEFORE DELETE ON delivery_nodes
    BEGIN
      SELECT RAISE(ABORT, 'delivery nodes are immutable');
    END`
  yield* sql`CREATE TRIGGER evidence_items_no_update
    BEFORE UPDATE ON evidence_items
    BEGIN
      SELECT RAISE(ABORT, 'evidence items are immutable');
    END`
  yield* sql`CREATE TRIGGER evidence_items_no_delete
    BEFORE DELETE ON evidence_items
    BEGIN
      SELECT RAISE(ABORT, 'evidence items are immutable');
    END`
  yield* sql`CREATE TRIGGER evidence_claims_no_update
    BEFORE UPDATE ON evidence_claims
    BEGIN
      SELECT RAISE(ABORT, 'evidence claims are immutable');
    END`
  yield* sql`CREATE TRIGGER evidence_claims_no_delete
    BEFORE DELETE ON evidence_claims
    BEGIN
      SELECT RAISE(ABORT, 'evidence claims are immutable');
    END`
  yield* sql`CREATE TRIGGER relationship_revisions_no_update
    BEFORE UPDATE ON relationship_revisions
    BEGIN
      SELECT RAISE(ABORT, 'relationship revisions are immutable');
    END`
  yield* sql`CREATE TRIGGER relationship_revisions_no_delete
    BEFORE DELETE ON relationship_revisions
    BEGIN
      SELECT RAISE(ABORT, 'relationship revisions are immutable');
    END`
  yield* sql`CREATE TRIGGER relationship_revision_evidence_no_update
    BEFORE UPDATE ON relationship_revision_evidence
    BEGIN
      SELECT RAISE(ABORT, 'relationship evidence bindings are immutable');
    END`
  yield* sql`CREATE TRIGGER relationship_revision_evidence_no_delete
    BEFORE DELETE ON relationship_revision_evidence
    BEGIN
      SELECT RAISE(ABORT, 'relationship evidence bindings are immutable');
    END`
})
