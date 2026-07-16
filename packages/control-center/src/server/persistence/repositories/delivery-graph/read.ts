import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { LedgerRevision } from "../../../../domain/deliveryGraph.js"
import type { EntityId, EvidenceId, GraphNodeId, WorkspaceId } from "../../../../domain/identifiers.js"
import { EvidenceClaimId, RelationshipId } from "../../../../domain/identifiers.js"
import { Database } from "../../Database.js"
import { RecordNotFoundError } from "../../errors.js"
import { type DeliveryGraphQuery, DeliveryGraphReadResult } from "./contract.js"
import { makeDeliveryGraphDecoders } from "./decode.js"
import { captureMalformedDeliveryGraphRow } from "./quarantine.js"
import { selectBoundedRelationshipClosure } from "./release-slice.js"
import { ClaimRow, decodeRows, EvidenceRow, graphRecordError, NodeRow, ProjectionRow, RelationshipRow } from "./rows.js"

export const makeDeliveryGraphReader = Effect.gen(function*() {
  const database = yield* Database
  const sql = database.sql
  const {
    decodeClaimRow,
    decodeEvidenceRow,
    decodeNodeRow,
    decodeProjectionRow,
    decodeRelationshipRow
  } = yield* makeDeliveryGraphDecoders

  const loadProjection = Effect.fn("DeliveryGraphRepository.loadProjection")(function*(
    workspaceId: WorkspaceId,
    entityId: EntityId,
    revision: LedgerRevision | null
  ) {
    const rows = yield* sql`SELECT
        projection.workspace_id AS workspaceId,
        projection.entity_id AS entityId,
        projection.projection_revision AS projectionRevision,
        projection.source_entity_revision AS sourceEntityRevision,
        projection.supersedes_projection_revision AS supersedesProjectionRevision,
        projection.projection_schema_version AS projectionSchemaVersion,
        projection.entity_state AS entityState,
        CASE entity.entity_type
          WHEN 'pipeline' THEN 'pipeline-execution'
          ELSE entity.entity_type
        END AS entityType,
        projection.display_key AS displayKey,
        projection.title,
        projection.extension_json AS extensionJson,
        projection.extension_digest AS extensionDigest,
        projection.recorded_at AS recordedAt
      FROM entity_projection_revisions projection
      INNER JOIN entities entity
        ON entity.workspace_id = projection.workspace_id
       AND entity.entity_id = projection.entity_id
      WHERE projection.workspace_id = ${workspaceId}
        AND projection.entity_id = ${entityId}
        AND (${revision} IS NULL OR projection.projection_revision = ${revision})
      ORDER BY projection.projection_revision DESC
      LIMIT 1`
    const decoded = yield* decodeRows(ProjectionRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "entity-projection",
          entityId,
          "entity-projection-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "entity-projection",
        recordKey: revision === null ? entityId : `${entityId}:${revision}`
      })
    }
    return yield* decodeProjectionRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const loadNode = Effect.fn("DeliveryGraphRepository.loadNode")(function*(
    workspaceId: WorkspaceId,
    nodeId: GraphNodeId
  ) {
    const rows = yield* sql`SELECT
        workspace_id AS workspaceId, node_id AS nodeId, node_key_digest AS nodeKeyDigest,
        node_kind AS nodeKind, endpoint_kind AS endpointKind,
        resolution_state AS resolutionState, entity_id AS entityId,
        release_id AS releaseId, environment_id AS environmentId,
        expected_entity_kind AS expectedEntityKind, missing_key AS missingKey, created_at AS createdAt
      FROM delivery_nodes
      WHERE workspace_id = ${workspaceId} AND node_id = ${nodeId}`
    const decoded = yield* decodeRows(NodeRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "delivery-node",
          nodeId,
          "delivery-node-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "delivery-node",
        recordKey: nodeId
      })
    }
    return yield* decodeNodeRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const loadEvidence = Effect.fn("DeliveryGraphRepository.loadEvidence")(function*(
    workspaceId: WorkspaceId,
    evidenceId: EvidenceId
  ) {
    const rows = yield* sql`SELECT
        workspace_id AS workspaceId, evidence_id AS evidenceId, schema_version AS schemaVersion,
        evidence_digest AS evidenceDigest, origin_kind AS originKind,
        plugin_connection_id AS pluginConnectionId, source_entity_id AS sourceEntityId,
        source_entity_revision AS sourceEntityRevision, person_id AS personId, agent_id AS agentId,
        system_component AS systemComponent, verifier_kind AS verifierKind,
        verifier_person_id AS verifierPersonId, verifier_agent_id AS verifierAgentId,
        verifier_component AS verifierComponent, observed_at AS observedAt, recorded_at AS recordedAt,
        valid_until AS validUntil, freshness_json AS freshnessJson,
        freshness_digest AS freshnessDigest, retention_class AS retentionClass, retain_until AS retainUntil,
        legal_hold AS legalHold
      FROM evidence_items
      WHERE workspace_id = ${workspaceId} AND evidence_id = ${evidenceId}`
    const decoded = yield* decodeRows(EvidenceRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "evidence-item",
          evidenceId,
          "evidence-item-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "evidence-item",
        recordKey: evidenceId
      })
    }
    return yield* decodeEvidenceRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const loadClaim = Effect.fn("DeliveryGraphRepository.loadClaim")(function*(
    workspaceId: WorkspaceId,
    evidenceClaimId: EvidenceClaimId
  ) {
    const rows = yield* sql`SELECT
        workspace_id AS workspaceId, evidence_claim_id AS evidenceClaimId,
        evidence_id AS evidenceId, subject_node_id AS subjectNodeId, predicate,
        value_json AS valueJson, value_digest AS valueDigest,
        supersedes_claim_id AS supersedesEvidenceClaimId, recorded_at AS recordedAt
      FROM evidence_claims
      WHERE workspace_id = ${workspaceId} AND evidence_claim_id = ${evidenceClaimId}`
    const decoded = yield* decodeRows(ClaimRow, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "evidence-claim",
          evidenceClaimId,
          "evidence-claim-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "evidence-claim",
        recordKey: evidenceClaimId
      })
    }
    return yield* decodeClaimRow(row).pipe(captureMalformedDeliveryGraphRow(row))
  })

  const listClaimsForEvidence = Effect.fn("DeliveryGraphRepository.listClaimsForEvidence")(function*(
    workspaceId: WorkspaceId,
    evidenceId: EvidenceId,
    limit: number
  ) {
    const identities = yield* sql`SELECT evidence_claim_id AS evidenceClaimId
      FROM evidence_claims
      WHERE workspace_id = ${workspaceId} AND evidence_id = ${evidenceId}
      ORDER BY recorded_at, evidence_claim_id
      LIMIT ${limit}`
    const decoded = yield* decodeRows(Schema.Struct({ evidenceClaimId: EvidenceClaimId }), identities)
    return yield* Effect.forEach(decoded, ({ evidenceClaimId }) => loadClaim(workspaceId, evidenceClaimId))
  })

  const loadRelationship = Effect.fn("DeliveryGraphRepository.loadRelationship")(function*(
    workspaceId: WorkspaceId,
    relationshipId: RelationshipId,
    revision: LedgerRevision | null
  ) {
    const rows = yield* sql`SELECT
        revision.workspace_id AS workspaceId, revision.relationship_id AS relationshipId,
        revision.revision, revision.supersedes_revision AS supersedesRevision,
        revision.schema_version AS relationshipSchemaVersion, revision.kind,
        revision.source_node_id AS sourceNodeId, revision.source_node_kind AS sourceNodeKind,
        revision.target_node_id AS targetNodeId, revision.target_node_kind AS targetNodeKind,
        revision.lifecycle, revision.lifecycle_reason AS lifecycleReason,
        revision.release_id AS releaseId, revision.environment_id AS environmentId,
        revision.confidence_kind AS confidenceKind, revision.confidence_score AS confidenceScore,
        revision.confidence_rationale AS confidenceRationale,
        revision.provenance_kind AS provenanceKind,
        revision.provenance_plugin_connection_id AS provenancePluginConnectionId,
        revision.provenance_source_entity_id AS provenanceSourceEntityId,
        revision.provenance_source_entity_revision AS provenanceSourceEntityRevision,
        revision.provenance_person_id AS provenancePersonId,
        revision.provenance_agent_id AS provenanceAgentId,
        revision.provenance_rule_id AS provenanceRuleId,
        revision.provenance_rule_version AS provenanceRuleVersion,
        revision.provenance_rationale AS provenanceRationale,
        revision.recorded_by_kind AS recordedByKind,
        revision.recorded_by_person_id AS recordedByPersonId,
        revision.recorded_by_agent_id AS recordedByAgentId,
        revision.recorded_by_component AS recordedByComponent,
        revision.effective_at AS effectiveAt, revision.recorded_at AS recordedAt,
        revision.revision_digest AS revisionDigest, NULL AS evidenceClaimIds
      FROM relationship_revisions revision
      INNER JOIN relationship_heads head
        ON head.workspace_id = revision.workspace_id
       AND head.relationship_id = revision.relationship_id
      WHERE revision.workspace_id = ${workspaceId}
        AND revision.relationship_id = ${relationshipId}
        AND revision.revision = COALESCE(${revision}, head.current_revision)
      LIMIT 1`
    const baseSchema = Schema.Struct({ ...RelationshipRow.fields, evidenceClaimIds: Schema.Null })
    const decoded = yield* decodeRows(baseSchema, rows).pipe(
      Effect.mapError(() =>
        graphRecordError(
          workspaceId,
          "delivery-relationship",
          relationshipId,
          "delivery-relationship-schema-invalid"
        )
      ),
      captureMalformedDeliveryGraphRow(rows)
    )
    const row = decoded[0]
    if (row === undefined) {
      return yield* new RecordNotFoundError({
        workspaceId,
        recordKind: "delivery-relationship",
        recordKey: revision === null ? relationshipId : `${relationshipId}:${revision}`
      })
    }
    const evidenceRows = yield* sql`SELECT evidence_claim_id AS evidenceClaimId
      FROM relationship_revision_evidence
      WHERE workspace_id = ${workspaceId}
        AND relationship_id = ${relationshipId}
        AND relationship_revision = ${row.revision}
      ORDER BY evidence_claim_id`
    const evidenceClaimIds = (yield* decodeRows(
      Schema.Struct({ evidenceClaimId: EvidenceClaimId }),
      evidenceRows
    )).map(({ evidenceClaimId }) => evidenceClaimId)
    const persistedRow = { ...row, evidenceClaimIds }
    return yield* decodeRelationshipRow(persistedRow).pipe(
      captureMalformedDeliveryGraphRow(persistedRow)
    )
  })

  const readDecoded = Effect.fn("DeliveryGraphRepository.readDecoded")(function*(
    workspaceId: WorkspaceId,
    query: DeliveryGraphQuery
  ) {
    switch (query._tag) {
      case "entityProjection":
        return DeliveryGraphReadResult.make({
          _tag: "entityProjection",
          value: yield* loadProjection(workspaceId, query.entityId, query.revision)
        })
      case "node":
        return DeliveryGraphReadResult.make({
          _tag: "node",
          value: yield* loadNode(workspaceId, query.nodeId)
        })
      case "evidence": {
        const evidence = yield* loadEvidence(workspaceId, query.evidenceId)
        const claims = yield* listClaimsForEvidence(workspaceId, query.evidenceId, query.limit)
        return DeliveryGraphReadResult.make({ _tag: "evidence", value: { evidence, claims } })
      }
      case "relationship":
        return DeliveryGraphReadResult.make({
          _tag: "relationship",
          value: yield* loadRelationship(workspaceId, query.relationshipId, query.revision)
        })
      case "relationshipHistory": {
        const rows = yield* sql`SELECT revision
          FROM relationship_revisions
          WHERE workspace_id = ${workspaceId} AND relationship_id = ${query.relationshipId}
          ORDER BY revision DESC LIMIT ${query.limit}`
        const revisions = yield* decodeRows(Schema.Struct({ revision: LedgerRevision }), rows)
        if (revisions.length === 0) {
          return yield* new RecordNotFoundError({
            workspaceId,
            recordKind: "delivery-relationship",
            recordKey: query.relationshipId
          })
        }
        const value = yield* Effect.forEach(
          revisions,
          ({ revision }) => loadRelationship(workspaceId, query.relationshipId, revision)
        )
        return DeliveryGraphReadResult.make({ _tag: "relationshipHistory", value })
      }
      case "releaseSlice": {
        const identityLimit = query.limit + 1
        const identityRows = query.environmentId === null
          ? yield* sql`SELECT revision.relationship_id AS relationshipId
              FROM relationship_revisions revision
              INNER JOIN relationship_heads head
                ON head.workspace_id = revision.workspace_id
               AND head.relationship_id = revision.relationship_id
               AND head.current_revision = revision.revision
              WHERE revision.workspace_id = ${workspaceId}
                AND revision.release_id = ${query.releaseId}
                AND revision.environment_id IS NULL
              ORDER BY revision.recorded_at DESC
              LIMIT ${identityLimit}`
          : yield* sql`SELECT revision.relationship_id AS relationshipId
              FROM relationship_revisions revision
              INNER JOIN relationship_heads head
                ON head.workspace_id = revision.workspace_id
               AND head.relationship_id = revision.relationship_id
               AND head.current_revision = revision.revision
              WHERE revision.workspace_id = ${workspaceId}
                AND revision.release_id = ${query.releaseId}
                AND revision.environment_id = ${query.environmentId}
              ORDER BY revision.recorded_at DESC
              LIMIT ${identityLimit}`
        const identities = yield* decodeRows(Schema.Struct({ relationshipId: RelationshipId }), identityRows)
        const candidateRelationships = yield* Effect.forEach(
          identities.slice(0, query.limit),
          ({ relationshipId }) => loadRelationship(workspaceId, relationshipId, null)
        )
        const bounded = selectBoundedRelationshipClosure(candidateRelationships, {
          relationships: query.limit,
          nodes: 500,
          evidenceClaims: 500
        })
        const relationships = bounded.relationships
        const nodeIds = Array.from(
          new Set(relationships.flatMap((relationship) => [
            relationship.sourceNodeId,
            relationship.targetNodeId
          ]))
        )
        const nodes = yield* Effect.forEach(nodeIds, (nodeId) => loadNode(workspaceId, nodeId))
        const entityProjections = yield* Effect.forEach(
          nodes.filter((node) => node.resolution._tag === "resolved" && node.resolution.target._tag === "entity"),
          (node) => {
            if (node.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") {
              return Effect.die("unreachable delivery-node narrowing")
            }
            return loadProjection(workspaceId, node.resolution.target.entityId, null)
          }
        )
        const claimIds = Array.from(
          new Set(
            relationships.flatMap(({ evidenceClaimIds }) => evidenceClaimIds)
          )
        )
        const evidenceClaims = yield* Effect.forEach(
          claimIds,
          (evidenceClaimId) => loadClaim(workspaceId, evidenceClaimId)
        )
        const evidenceIds = Array.from(new Set(evidenceClaims.map(({ evidenceId }) => evidenceId)))
        const evidenceItems = yield* Effect.forEach(
          evidenceIds,
          (evidenceId) => loadEvidence(workspaceId, evidenceId)
        )
        return DeliveryGraphReadResult.make({
          _tag: "releaseSlice",
          value: {
            releaseId: query.releaseId,
            environmentId: query.environmentId,
            truncated: identities.length > query.limit || bounded.truncated,
            nodes,
            entityProjections,
            relationships,
            evidenceClaims,
            evidenceItems
          }
        })
      }
    }
  })

  return { readDecoded }
})
