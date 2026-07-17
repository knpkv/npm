import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { AuthorizedShareSummary } from "../../api/shares.js"
import type { AuthorizedShareGrant } from "../../domain/authorizedShare.js"
import type { DeliveryEntityKind } from "../../domain/deliveryGraph.js"
import type { EntityId, WorkspaceId } from "../../domain/identifiers.js"
import { ApplicationInvalidRequest, ApplicationResourceNotFound, AuthorizedShares } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { mapPersistenceRead, mapPersistenceReadError, mapPersistenceWriteError } from "./errors.js"

const summaryFromGrant = (grant: AuthorizedShareGrant): AuthorizedShareSummary => ({
  shareId: grant.shareId,
  entityId: grant.target.entityId,
  granteePersonId: grant.granteePersonId,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
  revokedAt: grant.revokedAt
})

const unexpectedProjectionResult = (): Effect.Effect<never> =>
  Effect.die("Authorized share entity projection read returned an unexpected result")

/** Construct exact-scope authenticated share operations. */
export const makeAuthorizedShares = Effect.gen(function*() {
  const persistence = yield* Persistence

  const readCurrentPresentProjection = Effect.fn("AuthorizedShares.readCurrentPresentProjection")(function*(
    workspaceId: WorkspaceId,
    entityId: EntityId
  ) {
    const entity = yield* mapPersistenceRead(persistence.entities.get(workspaceId, entityId))
    const result = yield* mapPersistenceRead(persistence.deliveryGraph.read(workspaceId, {
      _tag: "entityProjection",
      entityId,
      revision: null
    }))
    if (result._tag !== "entityProjection") return yield* unexpectedProjectionResult()
    const canonicalEntityType: DeliveryEntityKind = entity.entityType === "pipeline"
      ? "pipeline-execution"
      : entity.entityType
    if (
      result.value.projection.entityState !== "present" ||
      Number(result.value.projection.sourceEntityRevision) !== Number(entity.revision) ||
      result.value.projection.entityType !== canonicalEntityType
    ) {
      return yield* new ApplicationResourceNotFound()
    }
    return result.value
  })

  return AuthorizedShares.of({
    create: Effect.fn("AuthorizedShares.create")(function*(input) {
      const createdAt = yield* DateTime.now
      if (DateTime.Order(createdAt, input.request.expiresAt) >= 0) {
        return yield* new ApplicationInvalidRequest()
      }
      const grantee = yield* mapPersistenceRead(
        persistence.people.getPerson(input.workspaceId, input.request.granteePersonId)
      )
      if (!grantee.person.isActive) return yield* new ApplicationInvalidRequest()
      yield* readCurrentPresentProjection(input.workspaceId, input.request.entityId)
      const grant = yield* persistence.authorizedShares.create({
        workspaceId: input.workspaceId,
        shareId: input.request.shareId,
        entityId: input.request.entityId,
        granteePersonId: input.request.granteePersonId,
        createdByPersonId: input.createdByPersonId,
        createdBySessionId: input.sessionId,
        createdAt,
        expiresAt: input.request.expiresAt
      }).pipe(Effect.mapError(mapPersistenceWriteError))
      return summaryFromGrant(grant)
    }),
    resolve: Effect.fn("AuthorizedShares.resolve")(function*(input) {
      return yield* persistence.transact(Effect.gen(function*() {
        const grant = yield* mapPersistenceRead(persistence.authorizedShares.get(input))
        const now = yield* DateTime.now
        if (
          input.actor._tag !== "human" ||
          input.actor.personId !== grant.granteePersonId ||
          grant.revokedAt !== null ||
          DateTime.Order(now, grant.expiresAt) >= 0
        ) {
          return yield* new ApplicationResourceNotFound()
        }
        const target = yield* readCurrentPresentProjection(input.workspaceId, grant.target.entityId)
        return {
          share: summaryFromGrant(grant),
          item: target
        }
      })).pipe(
        Effect.mapError((error) => error._tag === "PersistenceOperationError" ? mapPersistenceReadError(error) : error)
      )
    }),
    revoke: Effect.fn("AuthorizedShares.revoke")(function*(input) {
      const revokedAt = yield* DateTime.now
      yield* persistence.authorizedShares.revoke({
        workspaceId: input.workspaceId,
        shareId: input.shareId,
        revokedByPersonId: input.revokedByPersonId,
        revokedBySessionId: input.sessionId,
        revokedAt
      }).pipe(Effect.mapError(mapPersistenceReadError))
    })
  })
})

/** Live durable exact-scope authorized-share layer. */
export const authorizedSharesLayer = Layer.effect(AuthorizedShares, makeAuthorizedShares)
