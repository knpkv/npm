import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { DeliveryNode, DeliveryRelationship, EvidenceItem } from "../../../../domain/deliveryGraph.js"
import { DeliveryEntityKind, EvidenceClaim, LedgerRevision } from "../../../../domain/deliveryGraph.js"
import type { EntityId, WorkspaceId } from "../../../../domain/identifiers.js"
import { GraphNodeId, PluginConnectionId, ReleaseId } from "../../../../domain/identifiers.js"
import { Database } from "../../Database.js"
import { PersistenceOperationError, RevisionConflictError } from "../../errors.js"
import { ContentBlobDigest } from "../models.js"
import { DeliveryGraphInputError, DeliveryGraphWriteReceipt } from "./contract.js"
import type { DeliveryGraphWriteBatch, EntityProjectionWrite } from "./contract.js"
import { makeDeliveryGraphIntegrity } from "./integrity.js"
import {
  decodeRows,
  DELIVERY_GRAPH_SCHEMA_VERSION,
  edgeJson,
  encodeTimestamp,
  evidenceJson,
  evidenceValueJson,
  freshnessJson,
  graphRecordError,
  nodeResolutionJson,
  projectionJson,
  relationshipJson
} from "./rows.js"

export const makeDeliveryGraphWriter = Effect.gen(function*() {
  const database = yield* Database
  const { digestText } = yield* makeDeliveryGraphIntegrity
  const sql = database.sql

  const loadCanonicalEntity = Effect.fn("DeliveryGraphRepository.loadCanonicalEntity")(function*(
    workspaceId: WorkspaceId,
    entityId: EntityId
  ) {
    const rows = yield* sql`SELECT
        CASE entity_type
          WHEN 'pipeline' THEN 'pipeline-execution'
          ELSE entity_type
        END AS entityKind,
        plugin_connection_id AS pluginConnectionId
      FROM entities
      WHERE workspace_id = ${workspaceId}
        AND entity_id = ${entityId}`
    const entities = yield* decodeRows(
      Schema.Struct({
        entityKind: DeliveryEntityKind,
        pluginConnectionId: PluginConnectionId
      }),
      rows
    )
    const entity = entities[0]
    if (entity === undefined) {
      return yield* graphRecordError(
        workspaceId,
        "entity",
        entityId,
        "delivery-graph-entity-not-found"
      )
    }
    return entity
  })

  const ensurePluginEvidenceSourceRevision = Effect.fn(
    "DeliveryGraphRepository.ensurePluginEvidenceSourceRevision"
  )(function*(evidence: EvidenceItem) {
    if (evidence.attribution._tag !== "plugin") return
    const provenance = evidence.freshness.provenance
    if (provenance._tag === "none") {
      return yield* graphRecordError(
        evidence.workspaceId,
        "evidence-item",
        evidence.evidenceId,
        "evidence-plugin-source-revision-mismatch"
      )
    }
    const sourceRevision = provenance.sourceRevision
    const sourceUrl = sourceRevision.sourceUrl === null ? null : sourceRevision.sourceUrl.toString()
    const firstObservedAt = encodeTimestamp(sourceRevision.firstObservedAt)
    const lastObservedAt = encodeTimestamp(sourceRevision.lastObservedAt)
    const synchronizedAt = encodeTimestamp(sourceRevision.synchronizedAt)
    const rows = yield* sql`SELECT 1 AS matches
      FROM entities entity
      INNER JOIN entity_revisions revision
        ON revision.workspace_id = entity.workspace_id
       AND revision.entity_id = entity.entity_id
      WHERE entity.workspace_id = ${evidence.workspaceId}
        AND entity.entity_id = ${evidence.attribution.sourceEntityId}
        AND revision.revision = ${evidence.attribution.sourceEntityRevision}
        AND entity.plugin_connection_id = ${sourceRevision.pluginConnectionId}
        AND entity.provider_id = ${sourceRevision.providerId}
        AND entity.vendor_immutable_id = ${sourceRevision.vendorImmutableId}
        AND revision.source_revision = ${sourceRevision.revision}
        AND revision.source_url IS ${sourceUrl}
        AND revision.first_observed_at = ${firstObservedAt}
        AND revision.last_observed_at = ${lastObservedAt}
        AND revision.synchronized_at = ${synchronizedAt}
        AND revision.normalization_schema_version = ${sourceRevision.normalizationSchemaVersion}`
    const matches = yield* decodeRows(Schema.Struct({ matches: Schema.Literal(1) }), rows)
    if (matches.length !== 1) {
      return yield* graphRecordError(
        evidence.workspaceId,
        "evidence-item",
        evidence.evidenceId,
        "evidence-plugin-source-revision-mismatch"
      )
    }
  })

  const ensureWorkspace = Effect.fn("DeliveryGraphRepository.ensureWorkspace")(function*(
    workspaceId: WorkspaceId,
    batch: DeliveryGraphWriteBatch
  ) {
    const records = [
      ...batch.entityProjections.map(({ projection }) => projection),
      ...batch.nodes,
      ...batch.evidenceItems,
      ...batch.evidenceClaims,
      ...batch.relationships
    ]
    if (records.some((record) => record.workspaceId !== workspaceId)) {
      return yield* new DeliveryGraphInputError({ operation: "write" })
    }
  })

  const appendEntityProjection = Effect.fn("DeliveryGraphRepository.appendEntityProjection")(function*(
    projectionWrite: typeof EntityProjectionWrite.Type
  ) {
    const { projection, recordedAt } = projectionWrite
    const entity = yield* loadCanonicalEntity(projection.workspaceId, projection.entityId)
    if (entity.entityKind !== projection.entityType) {
      return yield* graphRecordError(
        projection.workspaceId,
        "entity-projection",
        projection.entityId,
        "entity-projection-entity-kind-mismatch"
      )
    }
    const recordedAtText = encodeTimestamp(recordedAt)
    const previousRows = yield* sql`SELECT
        projection_revision AS revision,
        source_entity_revision AS sourceEntityRevision
      FROM entity_projection_revisions
      WHERE workspace_id = ${projection.workspaceId}
        AND entity_id = ${projection.entityId}
      ORDER BY projection_revision DESC
      LIMIT 1`
    const decodedPrevious = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({
        revision: Schema.Number,
        sourceEntityRevision: Schema.Number
      }))
    )(previousRows)
    const previous = decodedPrevious[0]
    const actualRevision = previous?.revision ?? null
    const expectedRevision = projection.projectionRevision - 1
    if (actualRevision !== (expectedRevision === 0 ? null : expectedRevision)) {
      return yield* new RevisionConflictError({
        workspaceId: projection.workspaceId,
        recordKind: "entity-projection",
        recordKey: projection.entityId,
        expectedRevision,
        actualRevision
      })
    }
    if (
      previous !== undefined &&
      projection.sourceEntityRevision < previous.sourceEntityRevision
    ) {
      return yield* graphRecordError(
        projection.workspaceId,
        "entity-projection",
        projection.entityId,
        "entity-projection-source-revision-regression"
      )
    }
    const extensionJson = yield* Schema.encodeEffect(projectionJson)(projection.details).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-projection" }))
    )
    const extensionDigest = yield* digestText(extensionJson)
    yield* sql`INSERT INTO entity_projection_revisions (
      workspace_id, entity_id, projection_revision, source_entity_revision,
      supersedes_projection_revision,
      projection_schema_version, entity_state, display_key, title,
      extension_json, extension_digest, recorded_at
    ) VALUES (
      ${projection.workspaceId}, ${projection.entityId}, ${projection.projectionRevision},
      ${projection.sourceEntityRevision}, ${projection.supersedesProjectionRevision},
      ${projection.projectionSchemaVersion},
      ${projection.entityState}, ${projection.displayKey}, ${projection.title},
      ${extensionJson}, ${extensionDigest}, ${recordedAtText}
    )`
  })

  const insertNode = Effect.fn("DeliveryGraphRepository.insertNode")(function*(node: DeliveryNode) {
    const createdAt = encodeTimestamp(node.createdAt)
    const resolutionJson = yield* Schema.encodeEffect(nodeResolutionJson)(node.resolution).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-node" }))
    )
    const nodeKeyDigest = yield* digestText(resolutionJson)
    const isResolved = node.resolution._tag === "resolved"
    const target = isResolved ? node.resolution.target : null
    const nodeKind = isResolved ? target?._tag : node.resolution.expectedKind
    const entityId = target?._tag === "entity" ? target.entityId : null
    const releaseId = target?._tag === "release" || target?._tag === "environment"
      ? target.releaseId
      : null
    const environmentId = target?._tag === "environment" ? target.environmentId : null
    const expectedEntityKind = !isResolved && node.resolution.expectedKind === "entity"
      ? node.resolution.expectedEntityKind
      : null
    const missingKey = isResolved ? null : node.resolution.missingKey
    if (target?._tag === "entity") {
      const entity = yield* loadCanonicalEntity(node.workspaceId, target.entityId)
      if (entity.entityKind !== target.entityKind) {
        return yield* graphRecordError(
          node.workspaceId,
          "delivery-node",
          node.nodeId,
          "delivery-node-entity-kind-mismatch"
        )
      }
    }
    yield* sql`INSERT INTO delivery_nodes (
      workspace_id, node_id, node_key_digest, node_kind, endpoint_kind, resolution_state,
      entity_id, release_id, environment_id, expected_entity_kind, missing_key, created_at
    ) VALUES (
      ${node.workspaceId}, ${node.nodeId}, ${nodeKeyDigest}, ${nodeKind}, ${node.endpointKind},
      ${node.resolution._tag},
      ${entityId}, ${releaseId}, ${environmentId}, ${expectedEntityKind}, ${missingKey}, ${createdAt}
    )`
  })

  const insertEvidence = Effect.fn("DeliveryGraphRepository.insertEvidence")(function*(
    evidence: EvidenceItem
  ) {
    if (evidence.attribution._tag === "plugin") {
      const entity = yield* loadCanonicalEntity(
        evidence.workspaceId,
        evidence.attribution.sourceEntityId
      )
      if (entity.pluginConnectionId !== evidence.attribution.pluginConnectionId) {
        return yield* graphRecordError(
          evidence.workspaceId,
          "evidence-item",
          evidence.evidenceId,
          "evidence-plugin-source-owner-mismatch"
        )
      }
    }
    yield* ensurePluginEvidenceSourceRevision(evidence)
    const evidencePayload = yield* Schema.encodeEffect(evidenceJson)(evidence).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-evidence" }))
    )
    const evidenceDigest = yield* digestText(evidencePayload)
    const encodedFreshness = yield* Schema.encodeEffect(freshnessJson)(evidence.freshness).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-freshness" }))
    )
    const freshnessDigest = yield* digestText(encodedFreshness)
    const attribution = evidence.attribution
    const verifier = evidence.verifier
    const observedAt = encodeTimestamp(evidence.observedAt)
    const recordedAt = encodeTimestamp(evidence.recordedAt)
    const validUntil = evidence.validUntil === null ? null : encodeTimestamp(evidence.validUntil)
    const retainUntil = evidence.retention.retainUntil === null
      ? null
      : encodeTimestamp(evidence.retention.retainUntil)
    yield* sql`INSERT INTO evidence_items (
      workspace_id, evidence_id, schema_version, evidence_digest,
      origin_kind, plugin_connection_id, source_entity_id, source_entity_revision,
      person_id, agent_id, system_component,
      verifier_kind, verifier_person_id, verifier_agent_id, verifier_component,
      observed_at, recorded_at, valid_until, freshness_json, freshness_digest,
      retention_class, retain_until, legal_hold
    ) VALUES (
      ${evidence.workspaceId}, ${evidence.evidenceId}, ${evidence.schemaVersion}, ${evidenceDigest},
      ${attribution._tag},
      ${attribution._tag === "plugin" ? attribution.pluginConnectionId : null},
      ${attribution._tag === "plugin" ? attribution.sourceEntityId : null},
      ${attribution._tag === "plugin" ? attribution.sourceEntityRevision : null},
      ${attribution._tag === "human" ? attribution.personId : null},
      ${attribution._tag === "agent" ? attribution.agentId : null},
      ${attribution._tag === "system" ? attribution.component : null},
      ${verifier._tag},
      ${verifier._tag === "human" ? verifier.personId : null},
      ${verifier._tag === "agent" ? verifier.agentId : null},
      ${verifier._tag === "system" ? verifier.component : null},
      ${observedAt}, ${recordedAt}, ${validUntil}, ${encodedFreshness}, ${freshnessDigest},
      ${evidence.retention.classification}, ${retainUntil},
      ${evidence.retention.legalHold ? 1 : 0}
    )`
  })

  const insertClaim = Effect.fn("DeliveryGraphRepository.insertClaim")(function*(claim: EvidenceClaim) {
    const recordedAt = encodeTimestamp(claim.recordedAt)
    const causalEvidenceRows = yield* sql`SELECT 1 AS matches
      FROM evidence_items
      WHERE workspace_id = ${claim.workspaceId}
        AND evidence_id = ${claim.evidenceId}
        AND recorded_at <= ${recordedAt}`
    const causalEvidence = yield* decodeRows(
      Schema.Struct({ matches: Schema.Literal(1) }),
      causalEvidenceRows
    )
    if (causalEvidence.length !== 1) {
      return yield* graphRecordError(
        claim.workspaceId,
        "evidence-claim",
        claim.evidenceClaimId,
        "evidence-claim-precedes-evidence"
      )
    }
    if (claim.supersedesEvidenceClaimId !== null) {
      const predecessorRows = yield* sql`SELECT
          subject_node_id AS subjectNodeId,
          predicate,
          (SELECT evidence_claim_id FROM evidence_claims successor
            WHERE successor.workspace_id = predecessor.workspace_id
              AND successor.supersedes_claim_id = predecessor.evidence_claim_id
            LIMIT 1) AS successorId
        FROM evidence_claims predecessor
        WHERE workspace_id = ${claim.workspaceId}
          AND evidence_claim_id = ${claim.supersedesEvidenceClaimId}`
      const predecessor = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
        subjectNodeId: GraphNodeId,
        predicate: EvidenceClaim.fields.predicate,
        successorId: Schema.NullOr(EvidenceClaim.fields.evidenceClaimId)
      })))(predecessorRows)
      const row = predecessor[0]
      if (
        row === undefined || row.subjectNodeId !== claim.subjectNodeId ||
        row.predicate !== claim.predicate || row.successorId !== null
      ) {
        return yield* graphRecordError(
          claim.workspaceId,
          "evidence-claim",
          claim.evidenceClaimId,
          "evidence-claim-supersession-invalid"
        )
      }
    }
    const valueJson = yield* Schema.encodeEffect(evidenceValueJson)(claim.value).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-claim" }))
    )
    const valueDigest = yield* digestText(valueJson)
    yield* sql`INSERT INTO evidence_claims (
      workspace_id, evidence_claim_id, evidence_id, subject_node_id, predicate,
      value_schema_version, value_json, value_digest, supersedes_claim_id, recorded_at
    ) VALUES (
      ${claim.workspaceId}, ${claim.evidenceClaimId}, ${claim.evidenceId}, ${claim.subjectNodeId},
      ${claim.predicate}, ${DELIVERY_GRAPH_SCHEMA_VERSION}, ${valueJson}, ${valueDigest},
      ${claim.supersedesEvidenceClaimId}, ${recordedAt}
    )`
  })

  const ensureContainsScope = Effect.fn("DeliveryGraphRepository.ensureContainsScope")(function*(
    relationship: DeliveryRelationship
  ) {
    if (relationship.kind !== "contains") return
    if (relationship.scope === null) {
      return yield* graphRecordError(
        relationship.workspaceId,
        "delivery-relationship",
        relationship.relationshipId,
        "relationship-containment-scope-missing"
      )
    }
    const rows = yield* sql`SELECT release_id AS releaseId
      FROM delivery_nodes
      WHERE workspace_id = ${relationship.workspaceId}
        AND node_id = ${relationship.sourceNodeId}
        AND node_kind = 'release'
        AND resolution_state = 'resolved'`
    const sources = yield* decodeRows(Schema.Struct({ releaseId: ReleaseId }), rows)
    if (sources[0]?.releaseId !== relationship.scope.releaseId) {
      return yield* graphRecordError(
        relationship.workspaceId,
        "delivery-relationship",
        relationship.relationshipId,
        "relationship-containment-release-mismatch"
      )
    }
  })

  const appendRelationship = Effect.fn("DeliveryGraphRepository.appendRelationship")(function*(
    relationship: DeliveryRelationship
  ) {
    yield* ensureContainsScope(relationship)
    if (relationship.provenance._tag === "plugin") {
      const entity = yield* loadCanonicalEntity(
        relationship.workspaceId,
        relationship.provenance.sourceEntityId
      )
      if (entity.pluginConnectionId !== relationship.provenance.pluginConnectionId) {
        return yield* graphRecordError(
          relationship.workspaceId,
          "delivery-relationship",
          relationship.relationshipId,
          "relationship-plugin-source-owner-mismatch"
        )
      }
    }
    const relationshipPayload = yield* Schema.encodeEffect(relationshipJson)(relationship).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-relationship" }))
    )
    const revisionDigest = yield* digestText(relationshipPayload)
    const edgePayload = yield* Schema.encodeEffect(edgeJson)({
      kind: relationship.kind,
      sourceNodeId: relationship.sourceNodeId,
      sourceNodeKind: relationship.sourceNodeKind,
      targetNodeId: relationship.targetNodeId,
      targetNodeKind: relationship.targetNodeKind,
      scope: relationship.scope
    }).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-edge" }))
    )
    const edgeDigest = yield* digestText(edgePayload)
    const lifecycle = relationship.lifecycle
    const confidence = relationship.confidence
    const provenance = relationship.provenance
    const recordedBy = relationship.recordedBy
    const recordedAt = encodeTimestamp(relationship.recordedAt)
    const effectiveAt = encodeTimestamp(lifecycle.effectiveAt)
    const releaseId = relationship.scope?._tag === "release" || relationship.scope?._tag === "environment"
      ? relationship.scope.releaseId
      : null
    const environmentId = relationship.scope?._tag === "environment"
      ? relationship.scope.environmentId
      : null

    yield* Effect.forEach(
      relationship.evidenceClaimIds,
      (evidenceClaimId) =>
        Effect.gen(function*() {
          const causalClaimRows = yield* sql`SELECT 1 AS matches
            FROM evidence_claims
            WHERE workspace_id = ${relationship.workspaceId}
              AND evidence_claim_id = ${evidenceClaimId}
              AND recorded_at <= ${recordedAt}`
          const causalClaims = yield* decodeRows(
            Schema.Struct({ matches: Schema.Literal(1) }),
            causalClaimRows
          )
          if (causalClaims.length !== 1) {
            return yield* graphRecordError(
              relationship.workspaceId,
              "delivery-relationship",
              relationship.relationshipId,
              "relationship-precedes-evidence-claim"
            )
          }
        }),
      { discard: true }
    )

    if (relationship.revision === 1) {
      yield* sql`INSERT INTO relationship_heads (
        workspace_id, relationship_id, current_revision, edge_digest, created_at, updated_at
      ) VALUES (
        ${relationship.workspaceId}, ${relationship.relationshipId}, 1, ${edgeDigest},
        ${recordedAt}, ${recordedAt}
      )`
    } else {
      const headRows = yield* sql`SELECT current_revision AS revision, edge_digest AS edgeDigest
        FROM relationship_heads
        WHERE workspace_id = ${relationship.workspaceId}
          AND relationship_id = ${relationship.relationshipId}`
      const heads = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
        revision: LedgerRevision,
        edgeDigest: ContentBlobDigest
      })))(headRows)
      const head = heads[0]
      if (head?.revision !== relationship.supersedesRevision) {
        return yield* new RevisionConflictError({
          workspaceId: relationship.workspaceId,
          recordKind: "delivery-relationship",
          recordKey: relationship.relationshipId,
          expectedRevision: relationship.supersedesRevision ?? 0,
          actualRevision: head?.revision ?? null
        })
      }
      if (head.edgeDigest !== edgeDigest) {
        return yield* graphRecordError(
          relationship.workspaceId,
          "delivery-relationship",
          relationship.relationshipId,
          "relationship-edge-identity-mismatch"
        )
      }
    }

    const lifecycleReason = lifecycle._tag === "missing" || lifecycle._tag === "rejected" ||
        lifecycle._tag === "superseded"
      ? lifecycle.reason
      : null
    const confidenceRationale = confidence._tag === "confirmed"
      ? "Confirmed by recorded evidence."
      : confidence.rationale
    yield* sql`INSERT INTO relationship_revisions (
      workspace_id, relationship_id, revision, supersedes_revision, schema_version,
      kind, source_node_id, source_node_kind, target_node_id, target_node_kind,
      lifecycle, lifecycle_reason,
      release_id, environment_id, confidence_kind, confidence_score, confidence_rationale,
      provenance_kind, provenance_plugin_connection_id, provenance_source_entity_id,
      provenance_source_entity_revision, provenance_person_id, provenance_agent_id,
      provenance_rule_id, provenance_rule_version, provenance_rationale,
      recorded_by_kind, recorded_by_person_id, recorded_by_agent_id, recorded_by_component,
      effective_at, recorded_at, revision_digest
    ) VALUES (
      ${relationship.workspaceId}, ${relationship.relationshipId}, ${relationship.revision},
      ${relationship.supersedesRevision}, ${relationship.relationshipSchemaVersion}, ${relationship.kind},
      ${relationship.sourceNodeId}, ${relationship.sourceNodeKind},
      ${relationship.targetNodeId}, ${relationship.targetNodeKind}, ${lifecycle._tag}, ${lifecycleReason},
      ${releaseId}, ${environmentId}, ${confidence._tag},
      ${confidence._tag === "inferred" ? confidence.score : null}, ${confidenceRationale},
      ${provenance._tag},
      ${provenance._tag === "plugin" ? provenance.pluginConnectionId : null},
      ${provenance._tag === "plugin" ? provenance.sourceEntityId : null},
      ${provenance._tag === "plugin" ? provenance.sourceEntityRevision : null},
      ${provenance._tag === "human" ? provenance.personId : null},
      ${provenance._tag === "agent" ? provenance.agentId : null},
      ${provenance._tag === "rule" ? provenance.ruleId : null},
      ${provenance._tag === "rule" ? provenance.ruleVersion : null},
      ${
      provenance._tag === "human" || provenance._tag === "agent" || provenance._tag === "rule"
        ? provenance.rationale
        : null
    },
      ${recordedBy._tag},
      ${recordedBy._tag === "human" ? recordedBy.personId : null},
      ${recordedBy._tag === "agent" ? recordedBy.agentId : null},
      ${recordedBy._tag === "system" ? recordedBy.component : null},
      ${effectiveAt}, ${recordedAt}, ${revisionDigest}
    )`
    yield* Effect.forEach(
      relationship.evidenceClaimIds,
      (evidenceClaimId) =>
        sql`INSERT INTO relationship_revision_evidence (
        workspace_id, relationship_id, relationship_revision, evidence_claim_id
      ) VALUES (
        ${relationship.workspaceId}, ${relationship.relationshipId},
        ${relationship.revision}, ${evidenceClaimId}
      )`,
      { discard: true }
    )
    if (relationship.revision > 1) {
      yield* sql`UPDATE relationship_heads
        SET current_revision = ${relationship.revision}, updated_at = ${recordedAt}
        WHERE workspace_id = ${relationship.workspaceId}
          AND relationship_id = ${relationship.relationshipId}
          AND current_revision = ${relationship.supersedesRevision}`
      const changesRows = yield* sql`SELECT changes() AS changes`
      const changes = yield* decodeRows(Schema.Struct({ changes: Schema.Number }), changesRows)
      if (changes[0]?.changes !== 1) {
        return yield* new RevisionConflictError({
          workspaceId: relationship.workspaceId,
          recordKind: "delivery-relationship",
          recordKey: relationship.relationshipId,
          expectedRevision: relationship.supersedesRevision ?? 0,
          actualRevision: null
        })
      }
    }
  })

  const writeDecoded = Effect.fn("DeliveryGraphRepository.writeDecoded")(function*(
    batch: DeliveryGraphWriteBatch
  ) {
    yield* Effect.forEach(batch.entityProjections, appendEntityProjection, { discard: true })
    yield* Effect.forEach(batch.nodes, insertNode, { discard: true })
    yield* Effect.forEach(batch.evidenceItems, insertEvidence, { discard: true })
    yield* Effect.forEach(batch.evidenceClaims, insertClaim, { discard: true })
    yield* Effect.forEach(batch.relationships, appendRelationship, { discard: true })
    return DeliveryGraphWriteReceipt.make({
      entityProjectionCount: batch.entityProjections.length,
      nodeCount: batch.nodes.length,
      evidenceItemCount: batch.evidenceItems.length,
      evidenceClaimCount: batch.evidenceClaims.length,
      relationshipCount: batch.relationships.length
    })
  })

  return { ensureWorkspace, writeDecoded }
})
