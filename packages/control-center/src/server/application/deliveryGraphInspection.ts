import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type {
  EvidenceInspection,
  RelationshipHistoryInspection,
  ReleaseDeliveryGraphInspection
} from "../../api/deliveryGraph.js"
import type { DeliveryRelationship } from "../../domain/deliveryGraph.js"
import { DeliveryGraphInspection } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { mapPersistenceRead } from "./errors.js"

const unexpectedResult = (operation: string): Effect.Effect<never> =>
  Effect.die(`Delivery graph repository returned an unexpected result for ${operation}`)

/** Construct bounded workspace-safe delivery graph inspection reads. */
export const makeDeliveryGraphInspection = Effect.gen(function*() {
  const persistence = yield* Persistence

  return DeliveryGraphInspection.of({
    releaseSlice: Effect.fn("DeliveryGraphInspection.releaseSlice")(function*(input) {
      yield* mapPersistenceRead(persistence.releases.get(input.workspaceId, input.releaseId))
      const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
        _tag: "releaseSlice",
        releaseId: input.releaseId,
        environmentId: input.environmentId,
        limit: 500
      }))
      if (result._tag !== "releaseSlice") return yield* unexpectedResult("release slice")
      return result.value satisfies ReleaseDeliveryGraphInspection
    }),
    relationship: Effect.fn("DeliveryGraphInspection.relationship")(function*(input) {
      const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(input.workspaceId, {
        _tag: "relationship",
        relationshipId: input.relationshipId,
        revision: input.revision
      }))
      if (result._tag !== "relationship") return yield* unexpectedResult("relationship")
      return result.value satisfies DeliveryRelationship
    }),
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
