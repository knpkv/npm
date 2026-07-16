import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { DeliveryRelationship, LedgerRevision } from "../../domain/deliveryGraph.js"
import type { RelationshipRepairDisposition } from "../../domain/relationshipRepair.js"
import { ApplicationInvalidRequest, RelationshipRepairProposals } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { mapPersistenceRead, mapPersistenceWriteError } from "./errors.js"

const lifecycleForDisposition = (
  disposition: RelationshipRepairDisposition,
  rationale: string,
  effectiveAt: DeliveryRelationship["recordedAt"]
): DeliveryRelationship["lifecycle"] => {
  switch (disposition) {
    case "link":
      return { _tag: "governed", effectiveAt }
    case "verify":
      return { _tag: "verified", effectiveAt }
    case "reject":
      return { _tag: "rejected", effectiveAt, reason: rationale }
  }
}

/** Construct durable, idempotent relationship-repair proposal operations. */
export const makeRelationshipRepairProposals = Effect.gen(function*() {
  const persistence = yield* Persistence

  return RelationshipRepairProposals.of({
    create: Effect.fn("RelationshipRepairProposals.create")(function*(input) {
      const proposedAt = yield* DateTime.now
      return yield* persistence.relationshipRepairProposals.create({
        proposalId: input.request.proposalId,
        workspaceId: input.workspaceId,
        releaseId: input.releaseId,
        environmentId: input.request.environmentId,
        relationshipId: input.relationshipId,
        expectedRevision: input.request.expectedRevision,
        disposition: input.request.disposition,
        rationale: input.request.rationale,
        origin: { actor: input.actor, sessionId: input.sessionId },
        proposedAt
      }).pipe(Effect.mapError(mapPersistenceWriteError))
    }),
    get: Effect.fn("RelationshipRepairProposals.get")(function*(input) {
      return yield* mapPersistenceRead(persistence.relationshipRepairProposals.get(input))
    }),
    list: Effect.fn("RelationshipRepairProposals.list")(function*(input) {
      yield* mapPersistenceRead(persistence.releases.get(input.workspaceId, input.releaseId))
      const { applications, page } = yield* mapPersistenceRead(
        persistence.transact(Effect.gen(function*() {
          const page = yield* persistence.relationshipRepairProposals.list(input)
          const applications = yield* persistence.relationshipRepairProposals.listApplications(input)
          return { applications, page }
        }))
      )
      return {
        releaseId: input.releaseId,
        environmentId: input.environmentId,
        status: input.status,
        truncated: page.truncated,
        proposals: page.proposals,
        applications
      }
    }),
    review: Effect.fn("RelationshipRepairProposals.review")(function*(input) {
      const reviewedAt = yield* DateTime.now
      return yield* persistence.relationshipRepairProposals.review({
        workspaceId: input.workspaceId,
        proposalId: input.proposalId,
        reviewId: input.request.reviewId,
        decision: input.request.decision,
        rationale: input.request.rationale,
        origin: { actor: input.actor, sessionId: input.sessionId },
        reviewedAt
      }).pipe(Effect.mapError(mapPersistenceWriteError))
    }),
    apply: Effect.fn("RelationshipRepairProposals.apply")(function*(input) {
      const proposal = yield* mapPersistenceRead(persistence.relationshipRepairProposals.get(input))
      if (proposal.status !== "approved") return yield* new ApplicationInvalidRequest()
      const appliedAt = yield* DateTime.now

      return yield* persistence.transact(Effect.gen(function*() {
        const existing = yield* persistence.relationshipRepairProposals.application(input)
        if (existing !== null) {
          const result = yield* persistence.deliveryGraph.read(input.workspaceId, {
            _tag: "relationship",
            relationshipId: existing.relationshipId,
            revision: existing.appliedRevision
          })
          if (result._tag !== "relationship") {
            return yield* Effect.die("relationship application read returned an unexpected result")
          }
          return { application: existing, relationship: result.value }
        }

        const currentResult = yield* persistence.deliveryGraph.read(input.workspaceId, {
          _tag: "relationship",
          relationshipId: proposal.relationshipId,
          revision: null
        })
        if (currentResult._tag !== "relationship") {
          return yield* Effect.die("current relationship read returned an unexpected result")
        }
        const current = currentResult.value
        const nextRevision = LedgerRevision.make(proposal.expectedRevision + 1)
        const provenance: DeliveryRelationship["provenance"] = input.actor._tag === "human"
          ? { _tag: "human", personId: input.actor.personId, rationale: proposal.rationale }
          : { _tag: "agent", agentId: input.actor.agentId, rationale: proposal.rationale }
        const recordedBy: DeliveryRelationship["recordedBy"] = input.actor._tag === "human"
          ? { _tag: "human", personId: input.actor.personId }
          : { _tag: "agent", agentId: input.actor.agentId }
        const relationship = DeliveryRelationship.make({
          ...current,
          revision: nextRevision,
          supersedesRevision: proposal.expectedRevision,
          lifecycle: lifecycleForDisposition(proposal.disposition, proposal.rationale, appliedAt),
          provenance,
          recordedBy,
          recordedAt: appliedAt
        })
        const encodedRelationship = yield* Schema.encodeEffect(DeliveryRelationship)(relationship).pipe(Effect.orDie)
        yield* persistence.deliveryGraph.write(input.workspaceId, {
          entityProjections: [],
          nodes: [],
          evidenceItems: [],
          evidenceClaims: [],
          relationships: [encodedRelationship]
        })
        const application = yield* persistence.relationshipRepairProposals.recordApplication({
          workspaceId: input.workspaceId,
          proposalId: input.proposalId,
          relationshipId: proposal.relationshipId,
          appliedRevision: nextRevision,
          origin: { actor: input.actor, sessionId: input.sessionId },
          appliedAt
        })
        return { application, relationship }
      })).pipe(Effect.mapError(mapPersistenceWriteError))
    })
  })
})

/** Live durable relationship-repair proposal layer. */
export const relationshipRepairProposalsLayer = Layer.effect(
  RelationshipRepairProposals,
  makeRelationshipRepairProposals
)
