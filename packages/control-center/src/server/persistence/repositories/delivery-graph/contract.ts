import * as Schema from "effect/Schema"

import {
  DeliveryEntityProjection,
  DeliveryNode,
  DeliveryRelationship,
  EvidenceClaim,
  EvidenceItem,
  LedgerRevision
} from "../../../../domain/deliveryGraph.js"
import {
  EntityId,
  EnvironmentId,
  EvidenceId,
  GraphNodeId,
  RelationshipId,
  ReleaseId
} from "../../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"

const MAXIMUM_BATCH_RECORDS = 500

export const EntityProjectionWrite = Schema.Struct({
  projection: DeliveryEntityProjection,
  recordedAt: UtcTimestamp
})

/** Bounded atomic set of immutable delivery-graph records. */
export const DeliveryGraphWriteBatch = Schema.Struct({
  entityProjections: Schema.Array(EntityProjectionWrite).check(
    Schema.isMaxLength(MAXIMUM_BATCH_RECORDS)
  ),
  nodes: Schema.Array(DeliveryNode).check(Schema.isMaxLength(MAXIMUM_BATCH_RECORDS)),
  evidenceItems: Schema.Array(EvidenceItem).check(Schema.isMaxLength(MAXIMUM_BATCH_RECORDS)),
  evidenceClaims: Schema.Array(EvidenceClaim).check(Schema.isMaxLength(MAXIMUM_BATCH_RECORDS)),
  relationships: Schema.Array(DeliveryRelationship).check(
    Schema.isMaxLength(MAXIMUM_BATCH_RECORDS)
  )
}).check(
  Schema.makeFilter(
    (batch) => {
      const size = batch.entityProjections.length + batch.nodes.length +
        batch.evidenceItems.length + batch.evidenceClaims.length + batch.relationships.length
      return size > 0 && size <= MAXIMUM_BATCH_RECORDS
    },
    { expected: `a nonempty delivery graph batch of at most ${MAXIMUM_BATCH_RECORDS} records` }
  )
)

/** Decoded atomic delivery-graph write batch. */
export type DeliveryGraphWriteBatch = typeof DeliveryGraphWriteBatch.Type

/** Tagged, bounded read supported by the delivery-graph persistence seam. */
export const DeliveryGraphQuery = Schema.TaggedUnion({
  entityProjection: {
    entityId: EntityId,
    revision: Schema.NullOr(LedgerRevision)
  },
  node: { nodeId: GraphNodeId },
  evidence: {
    evidenceId: EvidenceId,
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
  },
  relationship: {
    relationshipId: RelationshipId,
    revision: Schema.NullOr(LedgerRevision)
  },
  relationshipHistory: {
    relationshipId: RelationshipId,
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))
  },
  releaseSlice: {
    releaseId: ReleaseId,
    environmentId: Schema.NullOr(EnvironmentId),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
  }
})

/** Decoded delivery-graph read query. */
export type DeliveryGraphQuery = typeof DeliveryGraphQuery.Type

export const PersistedEntityProjection = Schema.Struct({
  projection: DeliveryEntityProjection,
  recordedAt: UtcTimestamp
})

const EvidenceBundle = Schema.Struct({
  evidence: EvidenceItem,
  claims: Schema.Array(EvidenceClaim)
})

const ReleaseSlice = Schema.Struct({
  releaseId: ReleaseId,
  environmentId: Schema.NullOr(EnvironmentId),
  nodes: Schema.Array(DeliveryNode),
  entityProjections: Schema.Array(PersistedEntityProjection),
  relationships: Schema.Array(DeliveryRelationship),
  evidenceClaims: Schema.Array(EvidenceClaim),
  evidenceItems: Schema.Array(EvidenceItem)
})

/** Tagged read result; callers never need to understand the SQL representation. */
export const DeliveryGraphReadResult = Schema.TaggedUnion({
  entityProjection: { value: PersistedEntityProjection },
  node: { value: DeliveryNode },
  evidence: { value: EvidenceBundle },
  relationship: { value: DeliveryRelationship },
  relationshipHistory: { value: Schema.Array(DeliveryRelationship) },
  releaseSlice: { value: ReleaseSlice }
})

/** Decoded delivery-graph read result. */
export type DeliveryGraphReadResult = typeof DeliveryGraphReadResult.Type

/** Counts committed by one atomic delivery-graph write. */
export const DeliveryGraphWriteReceipt = Schema.Struct({
  entityProjectionCount: Schema.Int,
  nodeCount: Schema.Int,
  evidenceItemCount: Schema.Int,
  evidenceClaimCount: Schema.Int,
  relationshipCount: Schema.Int
})

/** Decoded delivery-graph write receipt. */
export type DeliveryGraphWriteReceipt = typeof DeliveryGraphWriteReceipt.Type

/** Invalid unknown input rejected before any graph SQL is run. */
export class DeliveryGraphInputError extends Schema.TaggedErrorClass<DeliveryGraphInputError>()(
  "DeliveryGraphInputError",
  { operation: Schema.Literals(["read", "write"]) }
) {}
