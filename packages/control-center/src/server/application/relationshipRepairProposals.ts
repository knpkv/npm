import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { RelationshipRepairProposals } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { mapPersistenceRead, mapPersistenceWriteError } from "./errors.js"

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
      const page = yield* mapPersistenceRead(persistence.relationshipRepairProposals.list(input))
      return {
        releaseId: input.releaseId,
        environmentId: input.environmentId,
        status: input.status,
        truncated: page.truncated,
        proposals: page.proposals
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
    })
  })
})

/** Live durable relationship-repair proposal layer. */
export const relationshipRepairProposalsLayer = Layer.effect(
  RelationshipRepairProposals,
  makeRelationshipRepairProposals
)
