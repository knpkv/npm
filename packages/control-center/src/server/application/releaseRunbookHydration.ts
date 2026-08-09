import * as Effect from "effect/Effect"

import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import type { EntityId, WorkspaceId } from "../../domain/identifiers.js"
import type { PersistenceService } from "../persistence/Persistence.js"

interface ReleaseRunbookPersistence {
  readonly deliveryGraph: Pick<PersistenceService["deliveryGraph"], "read">
}

/** Keep exact release inspection bodies within a small deterministic response budget. */
export const MAXIMUM_HYDRATED_RELEASE_RUNBOOKS = 16
export const MAXIMUM_HYDRATED_RELEASE_RUNBOOK_CHARACTERS = 1_048_576

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
  const candidates = releaseRunbookEntityIds(inspection).filter((entityId) => presentEntityIds.has(entityId))
  const exactPages = new Array<ReleaseDeliveryGraphInspection["entityProjections"][number]>()
  let hydratedCharacters = 0
  let hydrationTruncated = candidates.length > MAXIMUM_HYDRATED_RELEASE_RUNBOOKS
  for (const entityId of candidates.slice(0, MAXIMUM_HYDRATED_RELEASE_RUNBOOKS)) {
    const page = yield* persistence.deliveryGraph.read(workspaceId, {
      _tag: "entityProjection",
      entityId,
      revision: null
    }).pipe(
      Effect.flatMap((result) =>
        result._tag === "entityProjection"
          ? Effect.succeed(result.value)
          : Effect.die("Expected an exact entity projection for release runbook")
      ),
      Effect.catchTag("RecordNotFoundError", () => Effect.succeed(null))
    )
    if (page === null) continue
    const pageCharacters = page.projection.details._tag === "page"
      ? page.projection.details.content?.markdown.length ?? 0
      : 0
    if (hydratedCharacters + pageCharacters > MAXIMUM_HYDRATED_RELEASE_RUNBOOK_CHARACTERS) {
      hydrationTruncated = true
      break
    }
    hydratedCharacters += pageCharacters
    exactPages.push(page)
  }
  if (exactPages.length === 0 && !hydrationTruncated) return inspection
  const exactByEntityId = new Map(exactPages.map((page) => [page.projection.entityId, page]))
  return {
    ...inspection,
    truncated: inspection.truncated || hydrationTruncated,
    entityProjections: inspection.entityProjections.map((summary) =>
      exactByEntityId.get(summary.projection.entityId) ?? summary
    )
  } satisfies ReleaseDeliveryGraphInspection
})
