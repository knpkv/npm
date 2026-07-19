import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type {
  EvidenceInspection,
  RelationshipHistoryInspection,
  RelationshipRepairCandidate,
  RelationshipRepairCandidates,
  RelationshipRepairProposalDraft,
  ReleaseDeliveryGraphInspection,
  WorkspaceEntityInspection,
  WorkspaceEntityProjectionIndex
} from "../../api/deliveryGraph.js"
import type { DeliveryRelationship, LedgerRevision } from "../../domain/deliveryGraph.js"
import { evaluateFreshnessAt } from "../../domain/freshness.js"
import type { EntityId, EnvironmentId, RelationshipId, ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import {
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable,
  DeliveryGraphInspection
} from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { mapPersistenceRead } from "./errors.js"
import { presentTimelineEvent } from "./timelineReads.js"

const unexpectedResult = (operation: string): Effect.Effect<never> =>
  Effect.die(`Delivery graph repository returned an unexpected result for ${operation}`)

const candidateExplanation = (relationship: DeliveryRelationship): string => {
  if (relationship.lifecycle._tag === "missing") return relationship.lifecycle.reason
  if (relationship.confidence._tag === "inferred") return relationship.confidence.rationale
  if (relationship.provenance._tag === "human" || relationship.provenance._tag === "agent") {
    return relationship.provenance.rationale
  }
  if (relationship.provenance._tag === "rule") return relationship.provenance.rationale
  return "Provider evidence requires human verification."
}

const relationshipMatchesImpact = (
  relationship: DeliveryRelationship,
  releaseId: ReleaseId,
  environmentId: EnvironmentId | null
): boolean => {
  if (relationship.scope === null || relationship.scope.releaseId !== releaseId) return false
  return environmentId === null
    ? relationship.scope._tag === "release"
    : relationship.scope._tag === "environment" && relationship.scope.environmentId === environmentId
}

const deriveRelationshipRepairCandidate = (
  relationship: DeliveryRelationship,
  releaseId: ReleaseId,
  environmentId: EnvironmentId | null
): RelationshipRepairCandidate | undefined => {
  if (!relationshipMatchesImpact(relationship, releaseId, environmentId)) return undefined
  if (!["missing", "inferred", "proposed"].includes(relationship.lifecycle._tag)) return undefined
  return {
    relationship,
    suggestedDisposition: relationship.lifecycle._tag === "missing" ? "link" : "verify",
    explanation: candidateExplanation(relationship),
    impact: { releaseId, environmentId },
    requiredPermission: "workspace-owner"
  }
}

/** Derive non-mutating repair suggestions from the current incomplete relationship prefix. */
export const deriveRelationshipRepairCandidates = (
  slice: ReleaseDeliveryGraphInspection
): RelationshipRepairCandidates => ({
  releaseId: slice.releaseId,
  environmentId: slice.environmentId,
  truncated: slice.truncated,
  candidates: slice.relationships.flatMap((relationship): ReadonlyArray<RelationshipRepairCandidate> => {
    const candidate = deriveRelationshipRepairCandidate(relationship, slice.releaseId, slice.environmentId)
    return candidate === undefined ? [] : [candidate]
  })
})

/** Draft one future repair proposal only when the selected immutable candidate still exists. */
export const deriveRelationshipRepairProposalDraft = (
  candidate: RelationshipRepairCandidate,
  revision: LedgerRevision
): RelationshipRepairProposalDraft | undefined => {
  if (candidate.relationship.revision !== revision) return undefined
  return {
    candidate,
    precondition: { relationshipId: candidate.relationship.relationshipId, expectedRevision: revision },
    proposal: {
      disposition: candidate.suggestedDisposition,
      rationale: candidate.explanation
    }
  }
}

/** Construct bounded workspace-safe delivery graph inspection reads. */
export const makeDeliveryGraphInspection = Effect.gen(function*() {
  const persistence = yield* Persistence

  const releaseSlice = Effect.fn("DeliveryGraphInspection.releaseSlice")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly environmentId: EnvironmentId | null
  }) {
    yield* mapPersistenceRead(persistence.releases.get(input.workspaceId, input.releaseId))
    const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
      _tag: "releaseSlice",
      releaseId: input.releaseId,
      environmentId: input.environmentId,
      limit: 500
    }))
    if (result._tag !== "releaseSlice") return yield* unexpectedResult("release slice")
    return result.value satisfies ReleaseDeliveryGraphInspection
  })

  const readRelationship = Effect.fn("DeliveryGraphInspection.relationship")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly relationshipId: RelationshipId
    readonly revision: LedgerRevision | null
  }) {
    const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
      _tag: "relationship",
      relationshipId: input.relationshipId,
      revision: input.revision
    }))
    if (result._tag !== "relationship") return yield* unexpectedResult("relationship")
    return result.value satisfies DeliveryRelationship
  })

  const workspaceEntity = Effect.fn("DeliveryGraphInspection.workspaceEntity")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
  }) {
    const entityRecord = yield* mapPersistenceRead(persistence.entities.get(input.workspaceId, input.entityId))
    const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
      _tag: "entitySlice",
      entityId: input.entityId,
      limit: 100
    }))
    if (result._tag !== "entitySlice") return yield* unexpectedResult("workspace entity")

    const entityNodeIds = new Set(result.value.nodes.flatMap((node): ReadonlyArray<string> => {
      if (node.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") return []
      return node.resolution.target.entityId === input.entityId ? [node.nodeId] : []
    }))
    const directEvidenceIds = new Set(
      result.value.evidenceClaims.flatMap((claim): ReadonlyArray<string> =>
        entityNodeIds.has(claim.subjectNodeId) ? [claim.evidenceId] : []
      )
    )
    const directEvidence = result.value.evidenceItems
      .filter(({ evidenceId }) => directEvidenceIds.has(evidenceId))
      .sort((left, right) => DateTime.Order(right.recordedAt, left.recordedAt))[0]
    const evaluatedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
    const freshness = directEvidence === undefined
      ? null
      : yield* evaluateFreshnessAt(directEvidence.freshness, evaluatedAt).pipe(
        Effect.mapError(() => new ApplicationServiceUnavailable({ retryAt: null }))
      )
    const activityRecords = yield* mapPersistenceRead(persistence.timeline.page({
      workspaceId: input.workspaceId,
      actorKind: null,
      before: null,
      entityId: input.entityId,
      from: null,
      limit: 21,
      to: null
    }))

    return {
      entity: result.value.entity,
      source: entityRecord.sourceRevision,
      isSourceCurrent: Number(entityRecord.revision) === Number(result.value.entity.projection.sourceEntityRevision),
      freshness,
      graph: {
        truncated: result.value.truncated,
        nodes: result.value.nodes,
        relatedEntityProjections: result.value.relatedEntityProjections,
        relationships: result.value.relationships,
        evidenceClaims: result.value.evidenceClaims,
        evidenceItems: result.value.evidenceItems
      },
      activity: {
        truncated: activityRecords.length > 20,
        events: activityRecords.slice(0, 20).map((record) => presentTimelineEvent(input.workspaceId, record))
      }
    } satisfies WorkspaceEntityInspection
  })

  return DeliveryGraphInspection.of({
    workspaceEntity,
    workspaceEntityProjections: Effect.fn("DeliveryGraphInspection.workspaceEntityProjections")(function*(input) {
      const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
        _tag: "workspaceEntityProjections",
        owner: input.owner,
        query: input.query,
        service: input.service,
        status: input.status,
        type: input.type,
        limit: 500
      }))
      if (result._tag !== "workspaceEntityProjections") {
        return yield* unexpectedResult("workspace entity projections")
      }
      return result.value satisfies WorkspaceEntityProjectionIndex
    }),
    releaseSlice,
    repairCandidates: Effect.fn("DeliveryGraphInspection.repairCandidates")(function*(input) {
      return deriveRelationshipRepairCandidates(yield* releaseSlice(input))
    }),
    repairProposalDraft: Effect.fn("DeliveryGraphInspection.repairProposalDraft")(function*(input) {
      yield* mapPersistenceRead(persistence.releases.get(input.workspaceId, input.releaseId))
      const relationship = yield* readRelationship({
        workspaceId: input.workspaceId,
        relationshipId: input.relationshipId,
        revision: null
      })
      const candidate = deriveRelationshipRepairCandidate(relationship, input.releaseId, input.environmentId)
      if (candidate === undefined) return yield* new ApplicationResourceNotFound()
      const draft = deriveRelationshipRepairProposalDraft(candidate, input.revision)
      if (draft === undefined) return yield* new ApplicationResourceNotFound()
      return draft
    }),
    relationship: readRelationship,
    relationshipHistory: Effect.fn("DeliveryGraphInspection.relationshipHistory")(function*(input) {
      const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
        _tag: "relationshipHistory",
        relationshipId: input.relationshipId,
        limit: 200
      }))
      if (result._tag !== "relationshipHistory") return yield* unexpectedResult("relationship history")
      return {
        relationshipId: input.relationshipId,
        revisions: result.value
      } satisfies RelationshipHistoryInspection
    }),
    evidence: Effect.fn("DeliveryGraphInspection.evidence")(function*(input) {
      const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
        _tag: "evidence",
        evidenceId: input.evidenceId,
        limit: 200
      }))
      if (result._tag !== "evidence") return yield* unexpectedResult("evidence")
      return result.value satisfies EvidenceInspection
    })
  })
})

/** Live delivery graph inspection layer. */
export const deliveryGraphInspectionLayer = Layer.effect(DeliveryGraphInspection, makeDeliveryGraphInspection)
