import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type {
  EvidenceInspection,
  RelationshipHistoryInspection,
  RelationshipRepairCandidate,
  RelationshipRepairCandidates,
  RelationshipRepairProposalDraft,
  ReleaseDeliveryGraphInspection,
  WorkspaceEntityProjectionIndex
} from "../../api/deliveryGraph.js"
import type { DeliveryRelationship, LedgerRevision } from "../../domain/deliveryGraph.js"
import type { EnvironmentId, RelationshipId, ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import { ApplicationResourceNotFound, DeliveryGraphInspection } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { mapPersistenceRead } from "./errors.js"

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

  return DeliveryGraphInspection.of({
    workspaceEntityProjections: Effect.fn("DeliveryGraphInspection.workspaceEntityProjections")(function*(workspaceId) {
      const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(workspaceId, {
        _tag: "workspaceEntityProjections",
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
