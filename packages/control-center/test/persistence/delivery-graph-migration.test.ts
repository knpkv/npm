import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Result } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"

const WORKSPACE_A = "01890f6f-6d6a-7cc0-98d2-000000000101"
const WORKSPACE_B = "01890f6f-6d6a-7cc0-98d2-000000000102"
const PLUGIN_A = "01890f6f-6d6a-7cc0-98d2-000000000103"
const PLUGIN_B = "01890f6f-6d6a-7cc0-98d2-000000000104"
const PLUGIN_A_OTHER = "01890f6f-6d6a-7cc0-98d2-000000000110"
const RELEASE_A = "01890f6f-6d6a-7cc0-98d2-000000000105"
const RELEASE_B = "01890f6f-6d6a-7cc0-98d2-000000000111"
const ENVIRONMENT_A = "01890f6f-6d6a-7cc0-98d2-000000000106"
const ENTITY_A = "01890f6f-6d6a-7cc0-98d2-000000000107"
const ENTITY_B = "01890f6f-6d6a-7cc0-98d2-000000000108"
const RELEASE_NODE_A = "01890f6f-6d6a-7cc0-98d2-000000000109"
const MISSING_NODE_A = "01890f6f-6d6a-7cc0-98d2-00000000010a"
const ENTITY_NODE_B = "01890f6f-6d6a-7cc0-98d2-00000000010b"
const EVIDENCE_A = "01890f6f-6d6a-7cc0-98d2-00000000010c"
const CLAIM_A = "01890f6f-6d6a-7cc0-98d2-00000000010d"
const RELATIONSHIP_A = "01890f6f-6d6a-7cc0-98d2-00000000010e"
const RECORDED_AT = "2026-07-15T10:00:00.000Z"

const testConfig = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const root = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "control-center-delivery-graph-migration-"
  })
  return {
    blobRoot: `${root}/blobs`,
    busyTimeoutMilliseconds: 5_000,
    databaseUrl: `file:${root}/control-center.db`,
    maxConnections: 1
  }
})

const withDatabase = <Success, Failure>(use: Effect.Effect<Success, Failure, Database>) =>
  Effect.gen(function*() {
    const config = yield* testConfig
    return yield* use.pipe(Effect.provide(databaseLayer(config)))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const seedFoundations = Effect.gen(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO workspaces (
    workspace_id, display_name, revision, created_at, updated_at
  ) VALUES
    (${WORKSPACE_A}, 'Workspace A', 1, ${RECORDED_AT}, ${RECORDED_AT}),
    (${WORKSPACE_B}, 'Workspace B', 1, ${RECORDED_AT}, ${RECORDED_AT})`
  yield* sql`INSERT INTO plugin_connections (
    workspace_id, plugin_connection_id, provider_id, display_name,
    revision, is_enabled, created_at, updated_at
  ) VALUES
    (${WORKSPACE_A}, ${PLUGIN_A}, 'jira', 'Jira A', 1, 1, ${RECORDED_AT}, ${RECORDED_AT}),
    (${WORKSPACE_A}, ${PLUGIN_A_OTHER}, 'confluence', 'Confluence A', 1, 1, ${RECORDED_AT}, ${RECORDED_AT}),
    (${WORKSPACE_B}, ${PLUGIN_B}, 'jira', 'Jira B', 1, 1, ${RECORDED_AT}, ${RECORDED_AT})`
  yield* sql`INSERT INTO releases (
    workspace_id, release_id, current_revision, created_at, updated_at
  ) VALUES
    (${WORKSPACE_A}, ${RELEASE_A}, 1, ${RECORDED_AT}, ${RECORDED_AT}),
    (${WORKSPACE_A}, ${RELEASE_B}, 1, ${RECORDED_AT}, ${RECORDED_AT})`
  yield* sql`INSERT INTO release_targets (
    workspace_id, release_id, environment_id, created_at
  ) VALUES (${WORKSPACE_A}, ${RELEASE_A}, ${ENVIRONMENT_A}, ${RECORDED_AT})`
  yield* sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id,
    vendor_immutable_id, entity_type, current_revision, created_at, updated_at
  ) VALUES
    (${WORKSPACE_A}, ${ENTITY_A}, ${PLUGIN_A}, 'jira', 'ISSUE-A', 'issue', 1, ${RECORDED_AT}, ${RECORDED_AT}),
    (${WORKSPACE_B}, ${ENTITY_B}, ${PLUGIN_B}, 'jira', 'ISSUE-B', 'issue', 1, ${RECORDED_AT}, ${RECORDED_AT})`
  yield* sql`INSERT INTO entity_revisions (
    workspace_id, entity_id, revision, source_revision,
    normalization_schema_version, source_url, first_observed_at,
    last_observed_at, synchronized_at, created_at
  ) VALUES
    (${WORKSPACE_A}, ${ENTITY_A}, 1, 'revision-a', 1, NULL, ${RECORDED_AT}, ${RECORDED_AT}, ${RECORDED_AT}, ${RECORDED_AT}),
    (${WORKSPACE_B}, ${ENTITY_B}, 1, 'revision-b', 1, NULL, ${RECORDED_AT}, ${RECORDED_AT}, ${RECORDED_AT}, ${RECORDED_AT})`
})

const seedGraph = Effect.gen(function*() {
  const { sql } = yield* Database
  yield* sql`INSERT INTO entity_projection_revisions (
    workspace_id, entity_id, projection_revision, source_entity_revision,
    supersedes_projection_revision,
    projection_schema_version, entity_state, display_key, title,
    extension_json, extension_digest, recorded_at
  ) VALUES (
    ${WORKSPACE_A}, ${ENTITY_A}, 1, 1, NULL, 1, 'present', 'ISSUE-A',
    'Issue A', '{"_tag":"issue"}', ${"a".repeat(64)}, ${RECORDED_AT}
  )`
  yield* sql`INSERT INTO delivery_nodes (
    workspace_id, node_id, node_key_digest, node_kind, endpoint_kind, resolution_state,
    entity_id, release_id, environment_id, expected_entity_kind,
    missing_key, created_at
  ) VALUES
    (
      ${WORKSPACE_A}, ${RELEASE_NODE_A}, ${"b".repeat(64)}, 'release', 'release', 'resolved',
      NULL, ${RELEASE_A}, NULL, NULL, NULL, ${RECORDED_AT}
    ),
    (
      ${WORKSPACE_A}, ${MISSING_NODE_A}, ${"c".repeat(64)}, 'entity', 'pull-request', 'missing',
      NULL, NULL, NULL, 'pull-request', 'missing-pr-for-issue-a', ${RECORDED_AT}
    ),
    (
      ${WORKSPACE_B}, ${ENTITY_NODE_B}, ${"d".repeat(64)}, 'entity', 'issue', 'resolved',
      ${ENTITY_B}, NULL, NULL, NULL, NULL, ${RECORDED_AT}
    )`
  yield* sql`INSERT INTO evidence_items (
    workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
    plugin_connection_id, source_entity_id, source_entity_revision,
    person_id, agent_id, system_component, verifier_kind,
    verifier_person_id, verifier_agent_id, verifier_component,
    observed_at, recorded_at, valid_until, freshness_json, freshness_digest, retention_class,
    retain_until, legal_hold
  ) VALUES (
    ${WORKSPACE_A}, ${EVIDENCE_A}, 1, ${"e".repeat(64)}, 'system',
    NULL, NULL, NULL, NULL, NULL, 'fixture', 'system',
    NULL, NULL, 'fixture-verifier', ${RECORDED_AT}, ${RECORDED_AT},
    '2026-07-16T10:00:00.000Z', '{"_tag":"unavailable"}', ${"9".repeat(64)},
    'evidence', '2026-08-15T10:00:00.000Z', 0
  )`
  yield* sql`INSERT INTO evidence_claims (
    workspace_id, evidence_claim_id, evidence_id, subject_node_id,
    predicate, value_schema_version, value_json, value_digest,
    supersedes_claim_id, recorded_at
  ) VALUES (
    ${WORKSPACE_A}, ${CLAIM_A}, ${EVIDENCE_A}, ${MISSING_NODE_A},
    'relationship-observed', 1, '{"_tag":"flag","value":false}',
    ${"f".repeat(64)}, NULL, ${RECORDED_AT}
  )`
  yield* sql`INSERT INTO relationship_heads (
    workspace_id, relationship_id, current_revision, edge_digest,
    created_at, updated_at
  ) VALUES (
    ${WORKSPACE_A}, ${RELATIONSHIP_A}, 1, ${"1".repeat(64)},
    ${RECORDED_AT}, ${RECORDED_AT}
  )`
  yield* sql`INSERT INTO relationship_revisions (
    workspace_id, relationship_id, revision, supersedes_revision,
    schema_version, kind, source_node_id, source_node_kind,
    target_node_id, target_node_kind, lifecycle,
    lifecycle_reason, release_id, environment_id, confidence_kind,
    confidence_score, confidence_rationale, provenance_kind,
    provenance_plugin_connection_id, provenance_source_entity_id,
    provenance_source_entity_revision, provenance_person_id,
    provenance_agent_id, provenance_rule_id, provenance_rule_version,
    provenance_rationale, recorded_by_kind, recorded_by_person_id,
    recorded_by_agent_id, recorded_by_component, effective_at,
    recorded_at, revision_digest
  ) VALUES (
    ${WORKSPACE_A}, ${RELATIONSHIP_A}, 1, NULL, 1, 'contains',
    ${RELEASE_NODE_A}, 'release', ${MISSING_NODE_A}, 'pull-request',
    'missing', 'Pull request is missing',
    ${RELEASE_A}, NULL, 'unknown', NULL, 'No matching pull request found',
    'rule', NULL, NULL, NULL, NULL, NULL, 'missing-pr', 1,
    'Required release relationship', 'system', NULL, NULL, 'fixture',
    ${RECORDED_AT}, ${RECORDED_AT}, ${"2".repeat(64)}
  )`
  yield* sql`INSERT INTO relationship_revision_evidence (
    workspace_id, relationship_id, relationship_revision, evidence_claim_id
  ) VALUES (${WORKSPACE_A}, ${RELATIONSHIP_A}, 1, ${CLAIM_A})`
})

describe("delivery graph migration", () => {
  it.effect("persists explicit missing nodes and attributable relationship evidence", () =>
    withDatabase(
      Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedFoundations
        yield* seedGraph

        const rows = yield* sql<{
          readonly evidenceCount: number
          readonly missingNodeCount: number
          readonly relationshipCount: number
        }>`SELECT
          (SELECT count(*) FROM delivery_nodes WHERE resolution_state = 'missing') AS missingNodeCount,
          (SELECT count(*) FROM evidence_claims) AS evidenceCount,
          (SELECT count(*) FROM relationship_revisions) AS relationshipCount`

        assert.deepStrictEqual(rows, [
          { evidenceCount: 1, missingNodeCount: 1, relationshipCount: 1 }
        ])
      })
    ))

  it.effect("binds raw containment scope to the resolved release source", () =>
    withDatabase(
      Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedFoundations
        yield* seedGraph
        yield* sql`INSERT INTO relationship_heads (
          workspace_id, relationship_id, current_revision, edge_digest, created_at, updated_at
        ) VALUES
          (${WORKSPACE_A}, 'scope-release-mismatch', 1, ${"3".repeat(64)}, ${RECORDED_AT}, ${RECORDED_AT}),
          (${WORKSPACE_A}, 'scope-release-missing', 1, ${"4".repeat(64)}, ${RECORDED_AT}, ${RECORDED_AT}),
          (${WORKSPACE_A}, 'scope-contextual-dependency', 1, ${"5".repeat(64)}, ${RECORDED_AT}, ${RECORDED_AT})`

        const mismatchedRelease = yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle, lifecycle_reason,
          release_id, environment_id, confidence_kind, confidence_score,
          confidence_rationale, provenance_kind, provenance_plugin_connection_id,
          provenance_source_entity_id, provenance_source_entity_revision,
          provenance_person_id, provenance_agent_id, provenance_rule_id,
          provenance_rule_version, provenance_rationale, recorded_by_kind,
          recorded_by_person_id, recorded_by_agent_id, recorded_by_component,
          effective_at, recorded_at, revision_digest
        ) VALUES (
          ${WORKSPACE_A}, 'scope-release-mismatch', 1, NULL, 1, 'contains',
          ${RELEASE_NODE_A}, 'release', ${MISSING_NODE_A}, 'pull-request',
          'verified', NULL, ${RELEASE_B}, NULL, 'unknown', NULL,
          'Scope fixture', 'rule', NULL, NULL, NULL, NULL, NULL,
          'scope-check', 1, 'Scope fixture', 'system', NULL, NULL,
          'fixture', ${RECORDED_AT}, ${RECORDED_AT}, ${"6".repeat(64)}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedRelease))

        const missingScope = yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle, lifecycle_reason,
          release_id, environment_id, confidence_kind, confidence_score,
          confidence_rationale, provenance_kind, provenance_plugin_connection_id,
          provenance_source_entity_id, provenance_source_entity_revision,
          provenance_person_id, provenance_agent_id, provenance_rule_id,
          provenance_rule_version, provenance_rationale, recorded_by_kind,
          recorded_by_person_id, recorded_by_agent_id, recorded_by_component,
          effective_at, recorded_at, revision_digest
        ) VALUES (
          ${WORKSPACE_A}, 'scope-release-missing', 1, NULL, 1, 'contains',
          ${RELEASE_NODE_A}, 'release', ${MISSING_NODE_A}, 'pull-request',
          'verified', NULL, NULL, NULL, 'unknown', NULL,
          'Scope fixture', 'rule', NULL, NULL, NULL, NULL, NULL,
          'scope-check', 1, 'Scope fixture', 'system', NULL, NULL,
          'fixture', ${RECORDED_AT}, ${RECORDED_AT}, ${"7".repeat(64)}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(missingScope))

        yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle, lifecycle_reason,
          release_id, environment_id, confidence_kind, confidence_score,
          confidence_rationale, provenance_kind, provenance_plugin_connection_id,
          provenance_source_entity_id, provenance_source_entity_revision,
          provenance_person_id, provenance_agent_id, provenance_rule_id,
          provenance_rule_version, provenance_rationale, recorded_by_kind,
          recorded_by_person_id, recorded_by_agent_id, recorded_by_component,
          effective_at, recorded_at, revision_digest
        ) VALUES (
          ${WORKSPACE_A}, 'scope-contextual-dependency', 1, NULL, 1, 'depends-on',
          ${RELEASE_NODE_A}, 'release', ${MISSING_NODE_A}, 'pull-request',
          'verified', NULL, ${RELEASE_B}, NULL, 'unknown', NULL,
          'Cross-release dependency', 'rule', NULL, NULL, NULL, NULL, NULL,
          'dependency-check', 1, 'Cross-release dependency', 'system', NULL, NULL,
          'fixture', ${RECORDED_AT}, ${RECORDED_AT}, ${"8".repeat(64)}
        )`

        const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
          FROM relationship_revisions
          WHERE workspace_id = ${WORKSPACE_A}
            AND relationship_id LIKE 'scope-%'`
        assert.deepStrictEqual(rows, [{ count: 1 }])
      })
    ))

  it.effect("rejects cross-workspace graph references structurally", () =>
    withDatabase(
      Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedFoundations
        yield* seedGraph

        const foreignEntityNode = yield* sql`INSERT INTO delivery_nodes (
          workspace_id, node_id, node_key_digest, node_kind, endpoint_kind, resolution_state,
          entity_id, release_id, environment_id, expected_entity_kind,
          missing_key, created_at
        ) VALUES (
          ${WORKSPACE_A}, 'foreign-entity-node', ${"3".repeat(64)}, 'entity', 'issue',
          'resolved', ${ENTITY_B}, NULL, NULL, NULL, NULL, ${RECORDED_AT}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(foreignEntityNode))

        const foreignRelationshipTarget = yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle,
          lifecycle_reason, release_id, environment_id, confidence_kind,
          confidence_score, confidence_rationale, provenance_kind,
          provenance_plugin_connection_id, provenance_source_entity_id,
          provenance_source_entity_revision, provenance_person_id,
          provenance_agent_id, provenance_rule_id, provenance_rule_version,
          provenance_rationale, recorded_by_kind, recorded_by_person_id,
          recorded_by_agent_id, recorded_by_component, effective_at,
          recorded_at, revision_digest
        ) VALUES (
          ${WORKSPACE_A}, ${RELATIONSHIP_A}, 2, 1, 1, 'contains',
          ${RELEASE_NODE_A}, 'release', ${ENTITY_NODE_B}, 'issue',
          'superseded', 'Invalid foreign target',
          ${RELEASE_A}, NULL, 'unknown', NULL, 'Foreign target', 'rule',
          NULL, NULL, NULL, NULL, NULL, 'foreign-target', 1, NULL,
          'system', NULL, NULL, 'fixture', ${RECORDED_AT}, ${RECORDED_AT},
          ${"4".repeat(64)}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(foreignRelationshipTarget))
      })
    ))

  it.effect("rejects canonical-kind and plugin-attribution mismatches structurally", () =>
    withDatabase(
      Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedFoundations
        yield* seedGraph

        const mismatchedProjection = yield* sql`INSERT INTO entity_projection_revisions (
          workspace_id, entity_id, projection_revision, source_entity_revision,
          supersedes_projection_revision, projection_schema_version, entity_state,
          display_key, title, extension_json, extension_digest, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, ${ENTITY_A}, 2, 1, 1, 1, 'present', 'PR-42',
          'Wrong projection kind',
          '{"_tag":"pull-request","repository":"payments"}', ${"3".repeat(64)}, ${RECORDED_AT}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedProjection))

        const mismatchedNode = yield* sql`INSERT INTO delivery_nodes (
          workspace_id, node_id, node_key_digest, node_kind, endpoint_kind, resolution_state,
          entity_id, release_id, environment_id, expected_entity_kind, missing_key, created_at
        ) VALUES (
          ${WORKSPACE_A}, 'mismatched-entity-node', ${"4".repeat(64)}, 'entity',
          'pull-request', 'resolved', ${ENTITY_A}, NULL, NULL, NULL, NULL, ${RECORDED_AT}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedNode))

        const otherConnectionFreshness = JSON.stringify({
          _tag: "unavailable",
          provenance: { _tag: "none", pluginConnectionId: PLUGIN_A_OTHER }
        })
        const exactSourceFreshness = JSON.stringify({
          _tag: "current",
          provenance: {
            _tag: "provider",
            sourceRevision: {
              providerId: "jira",
              pluginConnectionId: PLUGIN_A,
              vendorImmutableId: "ISSUE-A",
              revision: "revision-a",
              sourceUrl: null,
              firstObservedAt: RECORDED_AT,
              lastObservedAt: RECORDED_AT,
              synchronizedAt: RECORDED_AT,
              normalizationSchemaVersion: 1
            }
          }
        })
        const wrongOwnerEvidence = yield* sql`INSERT INTO evidence_items (
          workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
          plugin_connection_id, source_entity_id, source_entity_revision,
          person_id, agent_id, system_component, verifier_kind,
          verifier_person_id, verifier_agent_id, verifier_component,
          observed_at, recorded_at, valid_until, freshness_json, freshness_digest,
          retention_class, retain_until, legal_hold
        ) VALUES (
          ${WORKSPACE_A}, 'wrong-owner-evidence', 1, ${"5".repeat(64)}, 'plugin',
          ${PLUGIN_A_OTHER}, ${ENTITY_A}, 1, NULL, NULL, NULL, 'system',
          NULL, NULL, 'fixture', ${RECORDED_AT}, ${RECORDED_AT}, NULL,
          ${otherConnectionFreshness}, ${"6".repeat(64)}, 'evidence', NULL, 0
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(wrongOwnerEvidence))

        const mismatchedFreshness = yield* sql`INSERT INTO evidence_items (
          workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
          plugin_connection_id, source_entity_id, source_entity_revision,
          person_id, agent_id, system_component, verifier_kind,
          verifier_person_id, verifier_agent_id, verifier_component,
          observed_at, recorded_at, valid_until, freshness_json, freshness_digest,
          retention_class, retain_until, legal_hold
        ) VALUES (
          ${WORKSPACE_A}, 'wrong-freshness-evidence', 1, ${"7".repeat(64)}, 'plugin',
          ${PLUGIN_A}, ${ENTITY_A}, 1, NULL, NULL, NULL, 'system',
          NULL, NULL, 'fixture', ${RECORDED_AT}, ${RECORDED_AT}, NULL,
          ${otherConnectionFreshness}, ${"8".repeat(64)}, 'evidence', NULL, 0
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedFreshness))

        const wrongObjectSameConnection = yield* sql`INSERT INTO evidence_items (
          workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
          plugin_connection_id, source_entity_id, source_entity_revision,
          person_id, agent_id, system_component, verifier_kind,
          verifier_person_id, verifier_agent_id, verifier_component,
          observed_at, recorded_at, valid_until, freshness_json, freshness_digest,
          retention_class, retain_until, legal_hold
        ) VALUES (
          ${WORKSPACE_A}, 'wrong-object-same-connection', 1, ${"a".repeat(64)}, 'plugin',
          ${PLUGIN_A}, ${ENTITY_A}, 1, NULL, NULL, NULL, 'system',
          NULL, NULL, 'fixture', ${RECORDED_AT}, ${RECORDED_AT}, NULL,
          ${exactSourceFreshness.replace("ISSUE-A", "ISSUE-OTHER")}, ${"b".repeat(64)},
          'evidence', NULL, 0
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(wrongObjectSameConnection))

        yield* sql`INSERT INTO evidence_items (
          workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
          plugin_connection_id, source_entity_id, source_entity_revision,
          person_id, agent_id, system_component, verifier_kind,
          verifier_person_id, verifier_agent_id, verifier_component,
          observed_at, recorded_at, valid_until, freshness_json, freshness_digest,
          retention_class, retain_until, legal_hold
        ) VALUES (
          ${WORKSPACE_A}, 'exact-source-evidence', 1, ${"c".repeat(64)}, 'plugin',
          ${PLUGIN_A}, ${ENTITY_A}, 1, NULL, NULL, NULL, 'system',
          NULL, NULL, 'fixture', ${RECORDED_AT}, ${RECORDED_AT}, NULL,
          ${exactSourceFreshness}, ${"d".repeat(64)}, 'evidence', NULL, 0
        )`

        const wrongOwnerRelationship = yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle,
          lifecycle_reason, release_id, environment_id, confidence_kind,
          confidence_score, confidence_rationale, provenance_kind,
          provenance_plugin_connection_id, provenance_source_entity_id,
          provenance_source_entity_revision, provenance_person_id,
          provenance_agent_id, provenance_rule_id, provenance_rule_version,
          provenance_rationale, recorded_by_kind, recorded_by_person_id,
          recorded_by_agent_id, recorded_by_component, effective_at,
          recorded_at, revision_digest
        ) SELECT
          workspace_id, relationship_id, 2, 1,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle,
          lifecycle_reason, release_id, environment_id, confidence_kind,
          confidence_score, confidence_rationale, 'plugin',
          ${PLUGIN_A_OTHER}, ${ENTITY_A}, 1, NULL,
          NULL, NULL, NULL, NULL,
          recorded_by_kind, recorded_by_person_id,
          recorded_by_agent_id, recorded_by_component, effective_at,
          recorded_at, ${"d".repeat(64)}
        FROM relationship_revisions
        WHERE workspace_id = ${WORKSPACE_A}
          AND relationship_id = ${RELATIONSHIP_A}
          AND revision = 1`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(wrongOwnerRelationship))
      })
    ))

  it.effect("enforces monotonic projection sources and causal evidence time", () =>
    withDatabase(
      Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedFoundations
        yield* seedGraph
        const later = "2026-07-15T10:05:00.000Z"

        yield* sql`INSERT INTO entity_revisions (
          workspace_id, entity_id, revision, source_revision,
          normalization_schema_version, source_url, first_observed_at,
          last_observed_at, synchronized_at, created_at
        ) VALUES (
          ${WORKSPACE_A}, ${ENTITY_A}, 2, 'revision-a-2', 1, NULL,
          ${RECORDED_AT}, ${later}, ${later}, ${later}
        )`
        yield* sql`INSERT INTO entity_projection_revisions (
          workspace_id, entity_id, projection_revision, source_entity_revision,
          supersedes_projection_revision, projection_schema_version, entity_state,
          display_key, title, extension_json, extension_digest, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, ${ENTITY_A}, 2, 2, 1, 1, 'present', 'ISSUE-A',
          'Issue A revision 2', '{"_tag":"issue"}', ${"4".repeat(64)}, ${later}
        )`
        const regressedProjection = yield* sql`INSERT INTO entity_projection_revisions (
          workspace_id, entity_id, projection_revision, source_entity_revision,
          supersedes_projection_revision, projection_schema_version, entity_state,
          display_key, title, extension_json, extension_digest, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, ${ENTITY_A}, 3, 1, 2, 1, 'present', 'ISSUE-A',
          'Regressed projection', '{"_tag":"issue"}', ${"5".repeat(64)}, ${later}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(regressedProjection))
        yield* sql`INSERT INTO entity_projection_revisions (
          workspace_id, entity_id, projection_revision, source_entity_revision,
          supersedes_projection_revision, projection_schema_version, entity_state,
          display_key, title, extension_json, extension_digest, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, ${ENTITY_A}, 3, 2, 2, 1, 'present', 'ISSUE-A',
          'Same-source reprojection', '{"_tag":"issue"}', ${"6".repeat(64)}, ${later}
        )`

        yield* sql`INSERT INTO evidence_items (
          workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
          plugin_connection_id, source_entity_id, source_entity_revision,
          person_id, agent_id, system_component, verifier_kind,
          verifier_person_id, verifier_agent_id, verifier_component,
          observed_at, recorded_at, valid_until, freshness_json, freshness_digest,
          retention_class, retain_until, legal_hold
        ) VALUES (
          ${WORKSPACE_A}, 'future-evidence', 1, ${"7".repeat(64)}, 'system',
          NULL, NULL, NULL, NULL, NULL, 'fixture', 'system',
          NULL, NULL, 'fixture', ${later}, ${later}, NULL,
          '{"_tag":"unavailable"}', ${"8".repeat(64)}, 'evidence', NULL, 0
        )`
        const claimBeforeEvidence = yield* sql`INSERT INTO evidence_claims (
          workspace_id, evidence_claim_id, evidence_id, subject_node_id,
          predicate, value_schema_version, value_json, value_digest,
          supersedes_claim_id, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, 'claim-before-evidence', 'future-evidence', ${MISSING_NODE_A},
          'relationship-observed', 1, '{"_tag":"flag","value":true}',
          ${"9".repeat(64)}, NULL, ${RECORDED_AT}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(claimBeforeEvidence))

        yield* sql`INSERT INTO evidence_claims (
          workspace_id, evidence_claim_id, evidence_id, subject_node_id,
          predicate, value_schema_version, value_json, value_digest,
          supersedes_claim_id, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, 'future-claim', 'future-evidence', ${MISSING_NODE_A},
          'relationship-observed', 1, '{"_tag":"flag","value":true}',
          ${"0".repeat(64)}, NULL, ${later}
        )`
        const relationshipId = "causally-inverted-relationship"
        yield* sql`INSERT INTO relationship_heads (
          workspace_id, relationship_id, current_revision, edge_digest,
          created_at, updated_at
        ) VALUES (
          ${WORKSPACE_A}, ${relationshipId}, 1, ${"3".repeat(64)},
          ${RECORDED_AT}, ${RECORDED_AT}
        )`
        yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle, lifecycle_reason,
          release_id, environment_id, confidence_kind, confidence_score,
          confidence_rationale, provenance_kind, provenance_plugin_connection_id,
          provenance_source_entity_id, provenance_source_entity_revision,
          provenance_person_id, provenance_agent_id, provenance_rule_id,
          provenance_rule_version, provenance_rationale, recorded_by_kind,
          recorded_by_person_id, recorded_by_agent_id, recorded_by_component,
          effective_at, recorded_at, revision_digest
        ) SELECT
          workspace_id, ${relationshipId}, 1, NULL,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle, lifecycle_reason,
          release_id, environment_id, confidence_kind, confidence_score,
          confidence_rationale, provenance_kind, provenance_plugin_connection_id,
          provenance_source_entity_id, provenance_source_entity_revision,
          provenance_person_id, provenance_agent_id, provenance_rule_id,
          provenance_rule_version, provenance_rationale, recorded_by_kind,
          recorded_by_person_id, recorded_by_agent_id, recorded_by_component,
          effective_at, recorded_at, ${"2".repeat(64)}
        FROM relationship_revisions
        WHERE workspace_id = ${WORKSPACE_A}
          AND relationship_id = ${RELATIONSHIP_A}
          AND revision = 1`
        const relationshipBeforeClaim = yield* sql`INSERT INTO relationship_revision_evidence (
          workspace_id, relationship_id, relationship_revision, evidence_claim_id
        ) VALUES (
          ${WORKSPACE_A}, ${relationshipId}, 1, 'future-claim'
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(relationshipBeforeClaim))
      })
    ))

  it.effect("enforces node, chronology, supersession, and immutability checks", () =>
    withDatabase(
      Effect.gen(function*() {
        const { sql } = yield* Database
        yield* seedFoundations
        yield* seedGraph

        const malformedMissingNode = yield* sql`INSERT INTO delivery_nodes (
          workspace_id, node_id, node_key_digest, node_kind, endpoint_kind, resolution_state,
          entity_id, release_id, environment_id, expected_entity_kind,
          missing_key, created_at
        ) VALUES (
          ${WORKSPACE_A}, 'malformed-missing-node', ${"5".repeat(64)}, 'entity', 'issue',
          'missing', NULL, NULL, NULL, NULL, 'missing-kind', ${RECORDED_AT}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(malformedMissingNode))

        const zeroLengthFreshness = yield* sql`INSERT INTO evidence_items (
          workspace_id, evidence_id, schema_version, evidence_digest, origin_kind,
          plugin_connection_id, source_entity_id, source_entity_revision,
          person_id, agent_id, system_component, verifier_kind,
          verifier_person_id, verifier_agent_id, verifier_component,
          observed_at, recorded_at, valid_until, freshness_json, freshness_digest, retention_class,
          retain_until, legal_hold
        ) VALUES (
          ${WORKSPACE_A}, 'zero-length-freshness', 1, ${"6".repeat(64)}, 'system',
          NULL, NULL, NULL, NULL, NULL, 'fixture', 'system', NULL, NULL,
          'fixture', ${RECORDED_AT}, ${RECORDED_AT}, ${RECORDED_AT},
          '{"_tag":"unavailable"}', ${"0".repeat(64)}, 'evidence', NULL, 0
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(zeroLengthFreshness))

        const mismatchedEndpointKind = yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle,
          lifecycle_reason, release_id, environment_id, confidence_kind,
          confidence_score, confidence_rationale, provenance_kind,
          provenance_plugin_connection_id, provenance_source_entity_id,
          provenance_source_entity_revision, provenance_person_id,
          provenance_agent_id, provenance_rule_id, provenance_rule_version,
          provenance_rationale, recorded_by_kind, recorded_by_person_id,
          recorded_by_agent_id, recorded_by_component, effective_at,
          recorded_at, revision_digest
        ) SELECT
          workspace_id, relationship_id, 2, 1,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, 'issue', lifecycle,
          lifecycle_reason, release_id, environment_id, confidence_kind,
          confidence_score, confidence_rationale, provenance_kind,
          provenance_plugin_connection_id, provenance_source_entity_id,
          provenance_source_entity_revision, provenance_person_id,
          provenance_agent_id, provenance_rule_id, provenance_rule_version,
          provenance_rationale, recorded_by_kind, recorded_by_person_id,
          recorded_by_agent_id, recorded_by_component, effective_at,
          recorded_at, ${"a".repeat(64)}
        FROM relationship_revisions
        WHERE workspace_id = ${WORKSPACE_A}
          AND relationship_id = ${RELATIONSHIP_A}
          AND revision = 1`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(mismatchedEndpointKind))

        const invalidDirection = yield* sql`INSERT INTO relationship_revisions (
          workspace_id, relationship_id, revision, supersedes_revision,
          schema_version, kind, source_node_id, source_node_kind,
          target_node_id, target_node_kind, lifecycle,
          lifecycle_reason, release_id, environment_id, confidence_kind,
          confidence_score, confidence_rationale, provenance_kind,
          provenance_plugin_connection_id, provenance_source_entity_id,
          provenance_source_entity_revision, provenance_person_id,
          provenance_agent_id, provenance_rule_id, provenance_rule_version,
          provenance_rationale, recorded_by_kind, recorded_by_person_id,
          recorded_by_agent_id, recorded_by_component, effective_at,
          recorded_at, revision_digest
        ) SELECT
          workspace_id, relationship_id, 2, 1,
          schema_version, kind, target_node_id, target_node_kind,
          source_node_id, source_node_kind, lifecycle,
          lifecycle_reason, release_id, environment_id, confidence_kind,
          confidence_score, confidence_rationale, provenance_kind,
          provenance_plugin_connection_id, provenance_source_entity_id,
          provenance_source_entity_revision, provenance_person_id,
          provenance_agent_id, provenance_rule_id, provenance_rule_version,
          provenance_rationale, recorded_by_kind, recorded_by_person_id,
          recorded_by_agent_id, recorded_by_component, effective_at,
          recorded_at, ${"3".repeat(64)}
        FROM relationship_revisions
        WHERE workspace_id = ${WORKSPACE_A}
          AND relationship_id = ${RELATIONSHIP_A}
          AND revision = 1`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(invalidDirection))

        const immutableMutations = [
          sql`UPDATE entity_projection_revisions SET title = 'changed'
            WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ENTITY_A}`,
          sql`DELETE FROM entity_projection_revisions
            WHERE workspace_id = ${WORKSPACE_A} AND entity_id = ${ENTITY_A}`,
          sql`UPDATE delivery_nodes SET missing_key = 'changed'
            WHERE workspace_id = ${WORKSPACE_A} AND node_id = ${MISSING_NODE_A}`,
          sql`DELETE FROM delivery_nodes
            WHERE workspace_id = ${WORKSPACE_A} AND node_id = ${MISSING_NODE_A}`,
          sql`UPDATE evidence_items SET legal_hold = 1
            WHERE workspace_id = ${WORKSPACE_A} AND evidence_id = ${EVIDENCE_A}`,
          sql`DELETE FROM evidence_items
            WHERE workspace_id = ${WORKSPACE_A} AND evidence_id = ${EVIDENCE_A}`,
          sql`UPDATE evidence_claims SET value_json = '{"_tag":"flag","value":true}'
            WHERE workspace_id = ${WORKSPACE_A} AND evidence_claim_id = ${CLAIM_A}`,
          sql`DELETE FROM evidence_claims
            WHERE workspace_id = ${WORKSPACE_A} AND evidence_claim_id = ${CLAIM_A}`,
          sql`UPDATE relationship_revisions SET lifecycle = 'rejected'
            WHERE workspace_id = ${WORKSPACE_A} AND relationship_id = ${RELATIONSHIP_A}`,
          sql`DELETE FROM relationship_revisions
            WHERE workspace_id = ${WORKSPACE_A} AND relationship_id = ${RELATIONSHIP_A}`,
          sql`UPDATE relationship_revision_evidence SET evidence_claim_id = ${CLAIM_A}
            WHERE workspace_id = ${WORKSPACE_A} AND relationship_id = ${RELATIONSHIP_A}`,
          sql`DELETE FROM relationship_revision_evidence
            WHERE workspace_id = ${WORKSPACE_A} AND relationship_id = ${RELATIONSHIP_A}`
        ]
        for (const mutation of immutableMutations) {
          const result = yield* mutation.pipe(Effect.result)
          assert.isTrue(Result.isFailure(result))
        }

        yield* sql`UPDATE relationship_heads
          SET updated_at = '2026-07-15T10:01:00.000Z'
          WHERE workspace_id = ${WORKSPACE_A}
            AND relationship_id = ${RELATIONSHIP_A}`

        const secondClaim = "01890f6f-6d6a-7cc0-98d2-00000000010f"
        yield* sql`INSERT INTO evidence_claims (
          workspace_id, evidence_claim_id, evidence_id, subject_node_id,
          predicate, value_schema_version, value_json, value_digest,
          supersedes_claim_id, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, ${secondClaim}, ${EVIDENCE_A}, ${MISSING_NODE_A},
          'relationship-observed', 1, '{"_tag":"flag","value":true}',
          ${"7".repeat(64)}, ${CLAIM_A}, ${RECORDED_AT}
        )`
        const forkedClaim = yield* sql`INSERT INTO evidence_claims (
          workspace_id, evidence_claim_id, evidence_id, subject_node_id,
          predicate, value_schema_version, value_json, value_digest,
          supersedes_claim_id, recorded_at
        ) VALUES (
          ${WORKSPACE_A}, 'forked-claim', ${EVIDENCE_A}, ${MISSING_NODE_A},
          'relationship-observed', 1, '{"_tag":"flag","value":true}',
          ${"8".repeat(64)}, ${CLAIM_A}, ${RECORDED_AT}
        )`.pipe(Effect.result)
        assert.isTrue(Result.isFailure(forkedClaim))
      })
    ))
})
