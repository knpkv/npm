import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  DeliveryEntityProjection,
  DeliveryNode,
  DeliveryRelationship,
  EvidenceClaim,
  EvidenceItem
} from "../../../../domain/deliveryGraph.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { PersistenceOperationError } from "../../errors.js"
import { makeDeliveryGraphIntegrity } from "./integrity.js"
import {
  type ClaimRow,
  evidenceJson,
  type EvidenceRow,
  evidenceValueJson,
  graphRecordError,
  nodeResolutionJson,
  type NodeRow,
  projectionJson,
  type ProjectionRow,
  type ProjectionSummaryRow,
  relationshipJson,
  type RelationshipRow
} from "./rows.js"

export const makeDeliveryGraphDecoders = Effect.gen(function*() {
  const { verifyDigest } = yield* makeDeliveryGraphIntegrity

  const decodeProjection = Effect.fn("DeliveryGraphRepository.decodeProjection")(function*(
    row: typeof ProjectionRow.Type,
    digestJson: string
  ) {
    yield* verifyDigest({
      workspaceId: row.workspaceId,
      recordKind: "entity-projection",
      recordKey: `${row.entityId}:${row.projectionRevision}`,
      json: digestJson,
      expected: row.extensionDigest
    })
    const details = yield* Schema.decodeUnknownEffect(projectionJson)(row.extensionJson).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "entity-projection",
          `${row.entityId}:${row.projectionRevision}`,
          "entity-projection-schema-invalid"
        )
      )
    )
    const projection = yield* Schema.decodeUnknownEffect(Schema.toType(DeliveryEntityProjection))({
      workspaceId: row.workspaceId,
      entityId: row.entityId,
      projectionRevision: row.projectionRevision,
      sourceEntityRevision: row.sourceEntityRevision,
      supersedesProjectionRevision: row.supersedesProjectionRevision,
      projectionSchemaVersion: row.projectionSchemaVersion,
      entityState: row.entityState,
      entityType: row.entityType,
      displayKey: row.displayKey,
      title: row.title,
      details
    }).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "entity-projection",
          `${row.entityId}:${row.projectionRevision}`,
          "entity-projection-schema-invalid"
        )
      )
    )
    const recordedAt = yield* Schema.decodeUnknownEffect(UtcTimestamp)(row.recordedAt).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "entity-projection",
          `${row.entityId}:${row.projectionRevision}`,
          "entity-projection-schema-invalid"
        )
      )
    )
    return { projection, recordedAt }
  })

  const decodeProjectionRow = Effect.fn("DeliveryGraphRepository.decodeProjectionRow")(function*(
    row: typeof ProjectionRow.Type
  ) {
    return yield* decodeProjection(row, row.extensionJson)
  })

  const decodeProjectionSummaryRow = Effect.fn(
    "DeliveryGraphRepository.decodeProjectionSummaryRow"
  )(function*(row: typeof ProjectionSummaryRow.Type) {
    return yield* decodeProjection(row, row.originalExtensionJson)
  })

  const decodeNodeRow = Effect.fn("DeliveryGraphRepository.decodeNodeRow")(function*(
    row: typeof NodeRow.Type
  ) {
    const resolution: unknown = row.resolutionState === "missing"
      ? {
        _tag: "missing",
        expectedKind: row.nodeKind,
        expectedEntityKind: row.expectedEntityKind,
        missingKey: row.missingKey
      }
      : row.nodeKind === "entity"
      ? {
        _tag: "resolved",
        target: { _tag: "entity", entityId: row.entityId, entityKind: row.endpointKind }
      }
      : row.nodeKind === "release"
      ? { _tag: "resolved", target: { _tag: "release", releaseId: row.releaseId } }
      : {
        _tag: "resolved",
        target: {
          _tag: "environment",
          releaseId: row.releaseId,
          environmentId: row.environmentId
        }
      }
    const node = yield* Schema.decodeUnknownEffect(DeliveryNode)({
      workspaceId: row.workspaceId,
      nodeId: row.nodeId,
      endpointKind: row.endpointKind,
      resolution,
      createdAt: row.createdAt
    }).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "delivery-node",
          row.nodeId,
          "delivery-node-schema-invalid"
        )
      )
    )
    const resolutionPayload = yield* Schema.encodeEffect(nodeResolutionJson)(node.resolution).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "delivery-node",
          row.nodeId,
          "delivery-node-schema-invalid"
        )
      )
    )
    yield* verifyDigest({
      workspaceId: row.workspaceId,
      recordKind: "delivery-node",
      recordKey: row.nodeId,
      json: resolutionPayload,
      expected: row.nodeKeyDigest
    })
    return node
  })

  const decodeEvidenceRow = Effect.fn("DeliveryGraphRepository.decodeEvidenceRow")(function*(
    row: typeof EvidenceRow.Type
  ) {
    const attribution: unknown = row.originKind === "plugin"
      ? {
        _tag: "plugin",
        pluginConnectionId: row.pluginConnectionId,
        sourceEntityId: row.sourceEntityId,
        sourceEntityRevision: row.sourceEntityRevision
      }
      : row.originKind === "human"
      ? { _tag: "human", personId: row.personId }
      : row.originKind === "agent"
      ? { _tag: "agent", agentId: row.agentId }
      : { _tag: "system", component: row.systemComponent }
    const verifier: unknown = row.verifierKind === "human"
      ? { _tag: "human", personId: row.verifierPersonId }
      : row.verifierKind === "agent"
      ? { _tag: "agent", agentId: row.verifierAgentId }
      : { _tag: "system", component: row.verifierComponent }
    yield* verifyDigest({
      workspaceId: row.workspaceId,
      recordKind: "evidence-freshness",
      recordKey: row.evidenceId,
      json: row.freshnessJson,
      expected: row.freshnessDigest
    })
    const freshness = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Unknown)
    )(row.freshnessJson).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "evidence-item",
          row.evidenceId,
          "evidence-freshness-schema-invalid"
        )
      )
    )
    const evidence = yield* Schema.decodeUnknownEffect(EvidenceItem)({
      workspaceId: row.workspaceId,
      evidenceId: row.evidenceId,
      schemaVersion: row.schemaVersion,
      attribution,
      verifier,
      observedAt: row.observedAt,
      recordedAt: row.recordedAt,
      validUntil: row.validUntil,
      freshness,
      retention: {
        classification: row.retentionClass,
        retainUntil: row.retainUntil,
        legalHold: row.legalHold === 1
      }
    }).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "evidence-item",
          row.evidenceId,
          "evidence-item-schema-invalid"
        )
      )
    )
    const payload = yield* Schema.encodeEffect(evidenceJson)(evidence).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-evidence" }))
    )
    yield* verifyDigest({
      workspaceId: row.workspaceId,
      recordKind: "evidence-item",
      recordKey: row.evidenceId,
      json: payload,
      expected: row.evidenceDigest
    })
    return evidence
  })

  const decodeClaimRow = Effect.fn("DeliveryGraphRepository.decodeClaimRow")(function*(
    row: typeof ClaimRow.Type
  ) {
    yield* verifyDigest({
      workspaceId: row.workspaceId,
      recordKind: "evidence-claim",
      recordKey: row.evidenceClaimId,
      json: row.valueJson,
      expected: row.valueDigest
    })
    const value = yield* Schema.decodeUnknownEffect(evidenceValueJson)(row.valueJson).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "evidence-claim",
          row.evidenceClaimId,
          "evidence-claim-schema-invalid"
        )
      )
    )
    return yield* Schema.decodeUnknownEffect(EvidenceClaim)({
      workspaceId: row.workspaceId,
      evidenceClaimId: row.evidenceClaimId,
      evidenceId: row.evidenceId,
      subjectNodeId: row.subjectNodeId,
      predicate: row.predicate,
      value,
      recordedAt: row.recordedAt,
      supersedesEvidenceClaimId: row.supersedesEvidenceClaimId
    }).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "evidence-claim",
          row.evidenceClaimId,
          "evidence-claim-schema-invalid"
        )
      )
    )
  })

  const decodeRelationshipRow = Effect.fn("DeliveryGraphRepository.decodeRelationshipRow")(function*(
    row: typeof RelationshipRow.Type
  ) {
    const lifecycle: unknown = row.lifecycle === "missing" || row.lifecycle === "rejected" ||
        row.lifecycle === "superseded"
      ? { _tag: row.lifecycle, effectiveAt: row.effectiveAt, reason: row.lifecycleReason }
      : { _tag: row.lifecycle, effectiveAt: row.effectiveAt }
    const scope: unknown = row.environmentId !== null
      ? { _tag: "environment", releaseId: row.releaseId, environmentId: row.environmentId }
      : row.releaseId !== null
      ? { _tag: "release", releaseId: row.releaseId }
      : null
    const confidence: unknown = row.confidenceKind === "inferred"
      ? {
        _tag: "inferred",
        score: row.confidenceScore,
        rationale: row.confidenceRationale
      }
      : row.confidenceKind === "unknown"
      ? { _tag: "unknown", rationale: row.confidenceRationale }
      : { _tag: row.confidenceKind }
    const provenance: unknown = row.provenanceKind === "plugin"
      ? {
        _tag: "plugin",
        pluginConnectionId: row.provenancePluginConnectionId,
        sourceEntityId: row.provenanceSourceEntityId,
        sourceEntityRevision: row.provenanceSourceEntityRevision
      }
      : row.provenanceKind === "human"
      ? { _tag: "human", personId: row.provenancePersonId, rationale: row.provenanceRationale }
      : row.provenanceKind === "agent"
      ? { _tag: "agent", agentId: row.provenanceAgentId, rationale: row.provenanceRationale }
      : {
        _tag: row.provenanceKind,
        ruleId: row.provenanceRuleId,
        ruleVersion: row.provenanceRuleVersion,
        rationale: row.provenanceRationale
      }
    const recordedBy: unknown = row.recordedByKind === "human"
      ? { _tag: "human", personId: row.recordedByPersonId }
      : row.recordedByKind === "agent"
      ? { _tag: "agent", agentId: row.recordedByAgentId }
      : { _tag: row.recordedByKind, component: row.recordedByComponent }
    const relationship = yield* Schema.decodeUnknownEffect(DeliveryRelationship)({
      workspaceId: row.workspaceId,
      relationshipId: row.relationshipId,
      relationshipSchemaVersion: row.relationshipSchemaVersion,
      revision: row.revision,
      supersedesRevision: row.supersedesRevision,
      kind: row.kind,
      sourceNodeId: row.sourceNodeId,
      sourceNodeKind: row.sourceNodeKind,
      targetNodeId: row.targetNodeId,
      targetNodeKind: row.targetNodeKind,
      scope,
      lifecycle,
      confidence,
      provenance,
      recordedBy,
      evidenceClaimIds: row.evidenceClaimIds,
      recordedAt: row.recordedAt
    }).pipe(
      Effect.mapError(() =>
        graphRecordError(
          row.workspaceId,
          "delivery-relationship",
          `${row.relationshipId}:${row.revision}`,
          "delivery-relationship-schema-invalid"
        )
      )
    )
    const payload = yield* Schema.encodeEffect(relationshipJson)(relationship).pipe(
      Effect.mapError(() => new PersistenceOperationError({ operation: "delivery-graph.encode-relationship" }))
    )
    yield* verifyDigest({
      workspaceId: row.workspaceId,
      recordKind: "delivery-relationship",
      recordKey: `${row.relationshipId}:${row.revision}`,
      json: payload,
      expected: row.revisionDigest
    })
    return relationship
  })

  return {
    decodeClaimRow,
    decodeEvidenceRow,
    decodeNodeRow,
    decodeProjectionRow,
    decodeProjectionSummaryRow,
    decodeRelationshipRow
  }
})
