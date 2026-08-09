import * as Effect from "effect/Effect"

import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import type { EntityId, WorkspaceId } from "../../domain/identifiers.js"
import type { PersistenceService } from "../persistence/Persistence.js"

interface ReleaseRunbookPersistence {
  readonly deliveryGraph: Pick<PersistenceService["deliveryGraph"], "read">
}

const relationshipIsCurrent = (
  relationship: ReleaseDeliveryGraphInspection["relationships"][number]
): boolean =>
  relationship.lifecycle._tag !== "missing" &&
  relationship.lifecycle._tag !== "rejected" &&
  relationship.lifecycle._tag !== "superseded"

/** Resolve only pages directly documenting the inspected release. */
export const releaseRunbookEntityIds = (
  inspection: ReleaseDeliveryGraphInspection
): ReadonlyArray<EntityId> => {
  const nodes = new Map(inspection.nodes.map((node) => [node.nodeId, node]))
  return Array.from(
    new Set(inspection.relationships.flatMap((relationship): ReadonlyArray<EntityId> => {
      if (
        relationship.kind !== "documented-by" ||
        relationship.sourceNodeKind !== "release" ||
        relationship.targetNodeKind !== "page" ||
        !relationshipIsCurrent(relationship)
      ) return []
      const source = nodes.get(relationship.sourceNodeId)
      const target = nodes.get(relationship.targetNodeId)
      return source?.resolution._tag === "resolved" &&
          source.resolution.target._tag === "release" &&
          source.resolution.target.releaseId === inspection.releaseId &&
          target?.resolution._tag === "resolved" &&
          target.resolution.target._tag === "entity"
        ? [target.resolution.target.entityId]
        : []
    }))
  )
}

/** Hydrate exact safe page content only for release runbooks whose tasks govern readiness. */
export const hydrateReleaseRunbookContent = Effect.fn("ReleaseRunbookHydration.hydrate")(function*(
  persistence: ReleaseRunbookPersistence,
  workspaceId: WorkspaceId,
  inspection: ReleaseDeliveryGraphInspection
) {
  const presentEntityIds = new Set(
    inspection.entityProjections.flatMap(({ projection }): ReadonlyArray<EntityId> =>
      projection.entityState === "present" ? [projection.entityId] : []
    )
  )
  const exactPages = yield* Effect.forEach(
    releaseRunbookEntityIds(inspection).filter((entityId) => presentEntityIds.has(entityId)),
    (entityId) =>
      persistence.deliveryGraph.read(workspaceId, {
        _tag: "entitySlice",
        entityId,
        limit: 100
      }).pipe(
        Effect.flatMap((result) =>
          result._tag === "entitySlice"
            ? Effect.succeed({
              projection: result.value.entity.projection,
              recordedAt: result.value.entity.recordedAt
            })
            : Effect.die("Expected an entity slice for release runbook")
        ),
        Effect.catchTag("RecordNotFoundError", () => Effect.succeed(null))
      ),
    { concurrency: 4 }
  )
  if (exactPages.length === 0) return inspection
  const exactByEntityId = new Map<EntityId, NonNullable<(typeof exactPages)[number]>>()
  for (const page of exactPages) {
    if (page !== null) exactByEntityId.set(page.projection.entityId, page)
  }
  return {
    ...inspection,
    entityProjections: inspection.entityProjections.map((summary) =>
      exactByEntityId.get(summary.projection.entityId) ?? summary
    )
  } satisfies ReleaseDeliveryGraphInspection
})
