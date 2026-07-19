import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  type DeliveryNode,
  type DeliveryRelationship,
  type EvidenceClaim,
  type EvidenceItem,
  LedgerRevision
} from "../../domain/deliveryGraph.js"
import type { PluginHealth } from "../../domain/freshness.js"
import { EvidenceClaimId, EvidenceId, GraphNodeId, RelationshipId, type WorkspaceId } from "../../domain/identifiers.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { PersistenceOperationError } from "../persistence/errors.js"
import type { PersistenceOperationFailure, PersistenceService } from "../persistence/Persistence.js"
import { DeliveryGraphWriteBatch } from "../persistence/repositories/deliveryGraphRepository.js"
import type { EntityRecord } from "../persistence/repositories/models.js"
import {
  deriveRelationshipInference,
  type RelationshipInferenceCandidate,
  type RelationshipInferenceEndpoint,
  type RelationshipInferenceEntity,
  type RelationshipInferenceRelease
} from "./relationshipInference.js"

const MAXIMUM_INFERENCE_ENTITIES = 500
const MAXIMUM_INFERENCE_RELEASES = 50
const COMPONENT = "relationship-inference"

export interface RelationshipInferenceMaterializationScope {
  readonly committedAt: UtcTimestamp
  readonly successfulHealth: Extract<PluginHealth, { readonly _tag: "healthy" | "degraded" }>
  readonly workspaceId: WorkspaceId
}

export interface RelationshipInferenceMaterializationReceipt {
  readonly evidenceClaimCount: number
  readonly evidenceItemCount: number
  readonly nodeCount: number
  readonly relationshipCount: number
  readonly skippedDueToBounds: boolean
}

type StableIdentity<IdentityError> = (identity: string) => Effect.Effect<string, IdentityError>

const readRelationship = Effect.fn("RelationshipInferenceMaterialization.readRelationship")(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  relationshipId: RelationshipId
) {
  const result = yield* persistence.deliveryGraph
    .read(workspaceId, {
      _tag: "relationship",
      relationshipId,
      revision: null
    })
    .pipe(Effect.result)
  if (Result.isFailure(result)) {
    if (result.failure._tag === "RecordNotFoundError") return null
    return yield* result.failure
  }
  return result.success._tag === "relationship" ? result.success.value : null
})

const nodeExists = Effect.fn("RelationshipInferenceMaterialization.nodeExists")(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  nodeId: GraphNodeId
) {
  const result = yield* persistence.deliveryGraph
    .read(workspaceId, {
      _tag: "node",
      nodeId
    })
    .pipe(Effect.result)
  if (Result.isSuccess(result)) return true
  if (result.failure._tag === "RecordNotFoundError") return false
  return yield* result.failure
})

const writeGraph = Effect.fn("RelationshipInferenceMaterialization.writeGraph")(function*(
  persistence: PersistenceService,
  workspaceId: WorkspaceId,
  batch: typeof DeliveryGraphWriteBatch.Type
) {
  const encoded = yield* Schema.encodeEffect(DeliveryGraphWriteBatch)(batch).pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "relationship-inference.encode" }))
  )
  return yield* persistence.deliveryGraph.write(workspaceId, encoded)
})

const relationshipIdentity = (workspaceId: WorkspaceId, identityKey: string): string =>
  `${workspaceId}\u0000relationship-inference\u0000relationship\u0000${identityKey}`

const missingNodeIdentity = (workspaceId: WorkspaceId, endpointKind: string, missingKey: string): string =>
  `${workspaceId}\u0000relationship-inference\u0000missing-node\u0000${endpointKind}\u0000${missingKey}`

const evidenceIdentity = (
  workspaceId: WorkspaceId,
  identityKey: string,
  observationKey: string,
  kind: "claim" | "item"
): string =>
  `${workspaceId}\u0000relationship-inference\u0000evidence-${kind}\u0000${identityKey}\u0000${observationKey}`

const entityNodeIdentity = (workspaceId: WorkspaceId, entity: EntityRecord): string => {
  const source = entity.sourceRevision
  return `${workspaceId}\u0000${source.pluginConnectionId}\u0000${source.providerId}\u0000entity-node\u0000${source.vendorImmutableId}`
}

const releaseNodeIdentity = (
  workspaceId: WorkspaceId,
  pluginConnectionId: string,
  providerId: string,
  vendorImmutableId: string
): string => `${workspaceId}\u0000${pluginConnectionId}\u0000${providerId}\u0000release-node\u0000${vendorImmutableId}`

const relationshipIdFor = <IdentityError>(
  identity: StableIdentity<IdentityError>,
  workspaceId: WorkspaceId,
  identityKey: string
) => identity(relationshipIdentity(workspaceId, identityKey)).pipe(Effect.map(RelationshipId.make))

const endpointNode = <IdentityError>(
  identity: StableIdentity<IdentityError>,
  scope: RelationshipInferenceMaterializationScope,
  endpoint: RelationshipInferenceEndpoint
) =>
  endpoint._tag === "resolved"
    ? Effect.succeed({ node: null, nodeId: endpoint.nodeId })
    : identity(missingNodeIdentity(scope.workspaceId, endpoint.kind, endpoint.missingKey)).pipe(
      Effect.map((value) => {
        const nodeId = GraphNodeId.make(value)
        const node: DeliveryNode = {
          workspaceId: scope.workspaceId,
          nodeId,
          endpointKind: endpoint.kind,
          resolution: {
            _tag: "missing",
            expectedKind: "entity",
            expectedEntityKind: endpoint.kind,
            missingKey: endpoint.missingKey
          },
          createdAt: scope.committedAt
        }
        return {
          nodeId,
          node
        }
      })
    )

const evidenceFor = Effect.fn("RelationshipInferenceMaterialization.evidenceFor")(function*<IdentityError>(
  identity: StableIdentity<IdentityError>,
  scope: RelationshipInferenceMaterializationScope,
  candidate: RelationshipInferenceCandidate,
  sourceNodeId: GraphNodeId,
  targetNodeId: GraphNodeId,
  entity: EntityRecord
): Effect.fn.Return<{ readonly claim: EvidenceClaim; readonly item: EvidenceItem }, IdentityError> {
  const evidenceId = EvidenceId.make(
    yield* identity(evidenceIdentity(scope.workspaceId, candidate.identityKey, candidate.observationKey, "item"))
  )
  const evidenceClaimId = EvidenceClaimId.make(
    yield* identity(evidenceIdentity(scope.workspaceId, candidate.identityKey, candidate.observationKey, "claim"))
  )
  const source = entity.sourceRevision
  const sourceAgeSeconds = Math.max(
    0,
    (DateTime.toEpochMillis(scope.committedAt) - DateTime.toEpochMillis(source.lastObservedAt)) / 1_000
  )
  return {
    item: {
      workspaceId: scope.workspaceId,
      evidenceId,
      schemaVersion: 1,
      attribution: { _tag: "system", component: COMPONENT },
      verifier: { _tag: "system", component: COMPONENT },
      observedAt: source.lastObservedAt,
      recordedAt: scope.committedAt,
      validUntil: null,
      freshness: {
        _tag: "current",
        evaluatedAt: scope.committedAt,
        pluginHealth: scope.successfulHealth._tag === "healthy"
          ? { _tag: "healthy", checkedAt: scope.committedAt }
          : { ...scope.successfulHealth, checkedAt: scope.committedAt },
        provenance: { _tag: "provider", sourceRevision: source },
        sourceObservedAt: source.lastObservedAt,
        staleAfterSeconds: Math.max(1, Math.ceil(sourceAgeSeconds) + 86_400),
        synchronizedAt: source.synchronizedAt
      },
      retention: { classification: "evidence", retainUntil: null, legalHold: false }
    },
    claim: {
      workspaceId: scope.workspaceId,
      evidenceClaimId,
      evidenceId,
      subjectNodeId: sourceNodeId,
      predicate: "relationship-observed",
      value: { _tag: "reference", targetNodeId },
      recordedAt: scope.committedAt,
      supersedesEvidenceClaimId: null
    }
  }
})

const unchanged = (
  previous: DeliveryRelationship | null,
  candidate: RelationshipInferenceCandidate,
  sourceNodeId: GraphNodeId,
  targetNodeId: GraphNodeId,
  claimId: EvidenceClaimId | null
): boolean =>
  previous !== null &&
  previous.kind === candidate.kind &&
  previous.sourceNodeId === sourceNodeId &&
  previous.targetNodeId === targetNodeId &&
  previous.scope?._tag === "release" &&
  previous.scope.releaseId === candidate.releaseId &&
  previous.lifecycle._tag === candidate.lifecycle &&
  (claimId === null || previous.evidenceClaimIds.includes(claimId))

const protectedByDecision = (previous: DeliveryRelationship | null): boolean =>
  previous?.lifecycle._tag === "governed" ||
  previous?.lifecycle._tag === "verified" ||
  previous?.lifecycle._tag === "rejected"

const materializeCandidate = Effect.fn("RelationshipInferenceMaterialization.materializeCandidate")(function*<
  IdentityError
>(
  persistence: PersistenceService,
  identity: StableIdentity<IdentityError>,
  scope: RelationshipInferenceMaterializationScope,
  candidate: RelationshipInferenceCandidate,
  entityById: ReadonlyMap<string, EntityRecord>
): Effect.fn.Return<RelationshipInferenceMaterializationReceipt, IdentityError | PersistenceOperationFailure> {
  const relationshipId = yield* relationshipIdFor(identity, scope.workspaceId, candidate.identityKey)
  const previous = yield* readRelationship(persistence, scope.workspaceId, relationshipId)
  if (protectedByDecision(previous)) {
    return {
      evidenceClaimCount: 0,
      evidenceItemCount: 0,
      nodeCount: 0,
      relationshipCount: 0,
      skippedDueToBounds: false
    }
  }
  const source = yield* endpointNode(identity, scope, candidate.source)
  const target = yield* endpointNode(identity, scope, candidate.target)
  const evidenceEntity = candidate.evidenceEntityId === null
    ? null
    : (entityById.get(candidate.evidenceEntityId) ?? null)
  const evidence = evidenceEntity === null
    ? null
    : yield* evidenceFor(identity, scope, candidate, source.nodeId, target.nodeId, evidenceEntity)
  if (unchanged(previous, candidate, source.nodeId, target.nodeId, evidence?.claim.evidenceClaimId ?? null)) {
    return {
      evidenceClaimCount: 0,
      evidenceItemCount: 0,
      nodeCount: 0,
      relationshipCount: 0,
      skippedDueToBounds: false
    }
  }
  const nodes = []
  if (source.node !== null && !(yield* nodeExists(persistence, scope.workspaceId, source.nodeId))) {
    nodes.push(source.node)
  }
  if (target.node !== null && !(yield* nodeExists(persistence, scope.workspaceId, target.nodeId))) {
    nodes.push(target.node)
  }
  const confidence: DeliveryRelationship["confidence"] = candidate.confidence === null
    ? { _tag: "unknown", rationale: "No matching provider evidence is currently synchronized." }
    : { _tag: "inferred", ...candidate.confidence }
  const relationship: DeliveryRelationship = {
    workspaceId: scope.workspaceId,
    relationshipId,
    relationshipSchemaVersion: 1,
    revision: LedgerRevision.make((previous?.revision ?? 0) + 1),
    supersedesRevision: previous?.revision ?? null,
    kind: candidate.kind,
    sourceNodeId: source.nodeId,
    sourceNodeKind: candidate.source.kind,
    targetNodeId: target.nodeId,
    targetNodeKind: candidate.target.kind,
    scope: { _tag: "release", releaseId: candidate.releaseId },
    lifecycle: candidate.lifecycle === "missing"
      ? {
        _tag: "missing",
        effectiveAt: scope.committedAt,
        reason: "No synchronized provider evidence currently resolves this required delivery link."
      }
      : { _tag: "inferred", effectiveAt: scope.committedAt },
    confidence,
    provenance: {
      _tag: "rule",
      ruleId: candidate.ruleId,
      ruleVersion: 1,
      rationale: candidate.confidence?.rationale ?? "Required delivery link has no synchronized match."
    },
    recordedBy: { _tag: "system", component: COMPONENT },
    evidenceClaimIds: evidence === null ? [] : [evidence.claim.evidenceClaimId],
    recordedAt: scope.committedAt
  }
  const receipt = yield* writeGraph(persistence, scope.workspaceId, {
    entityProjections: [],
    nodes,
    evidenceItems: evidence === null ? [] : [evidence.item],
    evidenceClaims: evidence === null ? [] : [evidence.claim],
    relationships: [relationship]
  })
  return { ...receipt, skippedDueToBounds: false }
})

const supersedeObsoleteGap = Effect.fn("RelationshipInferenceMaterialization.supersedeObsoleteGap")(function*<
  IdentityError
>(
  persistence: PersistenceService,
  identity: StableIdentity<IdentityError>,
  scope: RelationshipInferenceMaterializationScope,
  identityKey: string
): Effect.fn.Return<number, IdentityError | PersistenceOperationFailure> {
  const relationshipId = yield* relationshipIdFor(identity, scope.workspaceId, identityKey)
  const previous = yield* readRelationship(persistence, scope.workspaceId, relationshipId)
  if (previous?.lifecycle._tag !== "missing") return 0
  const relationship: DeliveryRelationship = {
    ...previous,
    revision: LedgerRevision.make(previous.revision + 1),
    supersedesRevision: previous.revision,
    lifecycle: {
      _tag: "superseded",
      effectiveAt: scope.committedAt,
      reason: "New synchronized evidence resolved the previously missing link."
    },
    recordedAt: scope.committedAt
  }
  return (yield* writeGraph(persistence, scope.workspaceId, {
    entityProjections: [],
    nodes: [],
    evidenceItems: [],
    evidenceClaims: [],
    relationships: [relationship]
  })).relationshipCount
})

const supersedeObsoleteRelationship = Effect.fn("RelationshipInferenceMaterialization.supersedeObsoleteRelationship")(
  function*(
    persistence: PersistenceService,
    scope: RelationshipInferenceMaterializationScope,
    relationshipId: RelationshipId
  ) {
    const previous = yield* readRelationship(persistence, scope.workspaceId, relationshipId)
    if (previous?.lifecycle._tag !== "inferred" && previous?.lifecycle._tag !== "missing") return 0
    const relationship: DeliveryRelationship = {
      ...previous,
      revision: LedgerRevision.make(previous.revision + 1),
      supersedesRevision: previous.revision,
      lifecycle: {
        _tag: "superseded",
        effectiveAt: scope.committedAt,
        reason: previous.lifecycle._tag === "missing"
          ? "The entity is no longer in the release scope that required this missing link."
          : "Current synchronized metadata no longer supports this inferred link."
      },
      recordedAt: scope.committedAt
    }
    return (yield* writeGraph(persistence, scope.workspaceId, {
      entityProjections: [],
      nodes: [],
      evidenceItems: [],
      evidenceClaims: [],
      relationships: [relationship]
    })).relationshipCount
  }
)

const emptyReceipt = (skippedDueToBounds: boolean): RelationshipInferenceMaterializationReceipt => ({
  evidenceClaimCount: 0,
  evidenceItemCount: 0,
  nodeCount: 0,
  relationshipCount: 0,
  skippedDueToBounds
})

/** Persist current rule candidates after a normalized page has committed. */
export const materializeRelationshipInference = Effect.fn("RelationshipInferenceMaterialization.reconcile")(function*<
  IdentityError
>(
  persistence: PersistenceService,
  identity: StableIdentity<IdentityError>,
  scope: RelationshipInferenceMaterializationScope
): Effect.fn.Return<RelationshipInferenceMaterializationReceipt, IdentityError | PersistenceOperationFailure> {
  const projectionResult = yield* persistence.deliveryGraph.read(scope.workspaceId, {
    _tag: "workspaceEntityProjections",
    owner: null,
    query: null,
    service: null,
    status: null,
    type: null,
    limit: MAXIMUM_INFERENCE_ENTITIES
  })
  if (projectionResult._tag !== "workspaceEntityProjections") return emptyReceipt(true)
  if (projectionResult.value.truncated) return emptyReceipt(true)
  const records = yield* Effect.forEach(
    projectionResult.value.items,
    ({ projection }) => persistence.entities.get(scope.workspaceId, projection.entityId),
    { concurrency: 10 }
  )
  const entityById = new Map(records.map((record) => [record.entityId, record]))
  const entities: Array<RelationshipInferenceEntity> = []
  for (const item of projectionResult.value.items) {
    const entity = entityById.get(item.projection.entityId)
    if (entity === undefined) continue
    entities.push({
      projection: item.projection,
      releaseIds: item.releaseIds,
      nodeId: GraphNodeId.make(yield* identity(entityNodeIdentity(scope.workspaceId, entity)))
    })
  }
  const releases = yield* persistence.releases.list(scope.workspaceId, MAXIMUM_INFERENCE_RELEASES + 1)
  if (releases.length > MAXIMUM_INFERENCE_RELEASES) return emptyReceipt(true)
  const inferenceReleases: Array<{
    readonly inferenceRelease: RelationshipInferenceRelease
    readonly node: DeliveryNode | null
  }> = []
  for (const { release } of releases) {
    const candidates = yield* Effect.forEach(release.sourceRevisions, (source) =>
      Effect.gen(function*() {
        const nodeId = GraphNodeId.make(
          yield* identity(
            releaseNodeIdentity(
              scope.workspaceId,
              source.pluginConnectionId,
              source.providerId,
              source.vendorImmutableId
            )
          )
        )
        return { exists: yield* nodeExists(persistence, scope.workspaceId, nodeId), nodeId }
      }))
    const selected = candidates.find(({ exists }) => exists) ?? candidates[0]
    if (selected === undefined) continue
    inferenceReleases.push({
      inferenceRelease: { nodeId: selected.nodeId, releaseId: release.id, version: release.version },
      node: selected.exists
        ? null
        : {
          workspaceId: scope.workspaceId,
          nodeId: selected.nodeId,
          endpointKind: "release",
          resolution: { _tag: "resolved", target: { _tag: "release", releaseId: release.id } },
          createdAt: scope.committedAt
        }
    })
  }
  const releaseIds = releases.map(({ release }) => release.id)
  const slices = yield* Effect.forEach(releaseIds, (releaseId) =>
    persistence.deliveryGraph.read(scope.workspaceId, {
      _tag: "releaseSlice",
      releaseId,
      environmentId: null,
      limit: MAXIMUM_INFERENCE_ENTITIES
    }))
  if (slices.some((slice) => slice._tag !== "releaseSlice" || slice.value.truncated)) return emptyReceipt(true)
  const relationships = slices.flatMap((slice) => (slice._tag === "releaseSlice" ? slice.value.relationships : []))
  const inference = deriveRelationshipInference({
    entities,
    releases: inferenceReleases.map(({ inferenceRelease }) => inferenceRelease),
    relationships
  })
  if (inference.truncated) return emptyReceipt(true)
  let receipt = emptyReceipt(false)
  const missingReleaseNodes = inferenceReleases.flatMap(({ node }) => node === null ? [] : [node])
  if (missingReleaseNodes.length > 0) {
    const current = yield* writeGraph(persistence, scope.workspaceId, {
      entityProjections: [],
      nodes: missingReleaseNodes,
      evidenceItems: [],
      evidenceClaims: [],
      relationships: []
    })
    receipt = { ...receipt, nodeCount: current.nodeCount }
  }
  for (const candidate of inference.candidates) {
    const current = yield* materializeCandidate(persistence, identity, scope, candidate, entityById)
    receipt = {
      evidenceClaimCount: receipt.evidenceClaimCount + current.evidenceClaimCount,
      evidenceItemCount: receipt.evidenceItemCount + current.evidenceItemCount,
      nodeCount: receipt.nodeCount + current.nodeCount,
      relationshipCount: receipt.relationshipCount + current.relationshipCount,
      skippedDueToBounds: false
    }
  }
  for (const identityKey of inference.obsoleteGapIdentityKeys) {
    receipt = {
      ...receipt,
      relationshipCount: receipt.relationshipCount +
        (yield* supersedeObsoleteGap(persistence, identity, scope, identityKey))
    }
  }
  for (const relationshipId of inference.obsoleteRelationshipIds) {
    receipt = {
      ...receipt,
      relationshipCount: receipt.relationshipCount +
        (yield* supersedeObsoleteRelationship(persistence, scope, relationshipId))
    }
  }
  return receipt
})
