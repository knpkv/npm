import type { RlyService } from "@knpkv/rly/patterns"
import type { RlyStateTone } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"

import type { ReleaseDeliveryGraphInspection, WorkspaceEntityProjectionIndex } from "../../api/deliveryGraph.js"
import type { DeliveryEntityDetails, DeliveryEntityKind } from "../../domain/deliveryGraph.js"
import type { EntityId, ReleaseId, WorkspaceId } from "../../domain/identifiers.js"

export type WorkspaceItemStatus = "active" | "done" | "failed"

export interface WorkspaceItemPresentation {
  readonly entityId: EntityId
  readonly freshness: string
  readonly href: string
  readonly key: string
  readonly kind: DeliveryEntityKind
  readonly owner: string
  readonly releaseId: ReleaseId | null
  readonly service: RlyService
  readonly status: string
  readonly statusGroup: WorkspaceItemStatus
  readonly title: string
  readonly tone: RlyStateTone
}

const serviceFor = (kind: DeliveryEntityKind): RlyService => {
  switch (kind) {
    case "issue":
      return "jira"
    case "pull-request":
      return "codecommit"
    case "page":
      return "confluence"
    case "pipeline-execution":
    case "deployment":
      return "codepipeline"
    case "time-entry":
      return "clockify"
  }
}

const titleCase = (value: string): string =>
  value.split("-").map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`).join(" ")

const statusFor = (details: DeliveryEntityDetails): string => {
  switch (details._tag) {
    case "issue":
      return details.status
    case "pull-request":
      return titleCase(details.reviewState)
    case "page":
    case "pipeline-execution":
    case "deployment":
      return titleCase(details.status)
    case "time-entry":
      return titleCase(details.approvalState)
  }
}

const issueStatusPresentation = (status: string): Pick<WorkspaceItemPresentation, "statusGroup" | "tone"> => {
  const value = status.trim().toLocaleLowerCase("en-US")
  if (value === "blocked" || value === "rejected") return { statusGroup: "failed", tone: "critical" }
  if (value === "closed" || value === "done" || value === "resolved") {
    return { statusGroup: "done", tone: "positive" }
  }
  return { statusGroup: "active", tone: "progress" }
}

const statusPresentation = (
  kind: DeliveryEntityKind,
  status: string
): Pick<WorkspaceItemPresentation, "statusGroup" | "tone"> => {
  if (kind === "issue") return issueStatusPresentation(status)
  const value = status.toLocaleLowerCase("en-US")
  if (
    ["blocked", "changes requested", "failed", "rejected", "rolled back", "stopped", "superseded"].some((part) =>
      value.includes(part)
    )
  ) return { statusGroup: "failed", tone: "critical" }
  if (
    ["approved", "closed", "current", "done", "merged", "not required", "ready", "resolved", "succeeded"]
      .some((part) => value.includes(part))
  ) return { statusGroup: "done", tone: "positive" }
  return { statusGroup: "active", tone: "progress" }
}

const itemHref = (workspaceId: WorkspaceId, releaseId: ReleaseId | null, entityId: EntityId): string =>
  releaseId === null
    ? `/w/${workspaceId}/items?object=${encodeURIComponent(entityId)}#item-details`
    : `/w/${workspaceId}/releases/${releaseId}?object=${encodeURIComponent(entityId)}#release-work`

const presentProjection = (
  workspaceId: WorkspaceId,
  releaseId: ReleaseId | null,
  entry: WorkspaceEntityProjectionIndex["items"][number]
): WorkspaceItemPresentation => {
  const projection = entry.projection
  const status = statusFor(projection.details)
  return {
    entityId: projection.entityId,
    freshness: DateTime.formatIso(entry.recordedAt),
    href: itemHref(workspaceId, releaseId, projection.entityId),
    key: projection.displayKey,
    kind: projection.entityType,
    owner: "Unassigned",
    releaseId,
    service: serviceFor(projection.entityType),
    status,
    ...statusPresentation(projection.entityType, status),
    title: projection.title
  }
}

/** Present one server-authoritative workspace entity index. */
export const presentWorkspaceEntityIndex = (
  workspaceId: WorkspaceId,
  index: WorkspaceEntityProjectionIndex,
  routableReleaseIds?: ReadonlySet<ReleaseId>
): ReadonlyArray<WorkspaceItemPresentation> =>
  index.items
    .filter(({ projection }) => projection.entityState === "present")
    .map((entry) =>
      presentProjection(
        workspaceId,
        entry.canonicalReleaseId !== null && routableReleaseIds?.has(entry.canonicalReleaseId) !== false
          ? entry.canonicalReleaseId
          : null,
        entry
      )
    )
    .sort((left, right) => left.service.localeCompare(right.service) || left.key.localeCompare(right.key))

/** Present bounded release slices as one deduplicated release-linked item index. */
export const presentWorkspaceItems = (
  workspaceId: WorkspaceId,
  inspections: ReadonlyArray<ReleaseDeliveryGraphInspection>
): ReadonlyArray<WorkspaceItemPresentation> => {
  const items = new Map<EntityId, WorkspaceItemPresentation>()
  const canonicalInspections = [...inspections].sort((left, right) => left.releaseId.localeCompare(right.releaseId))
  for (const inspection of canonicalInspections) {
    for (const entry of inspection.entityProjections) {
      const projection = entry.projection
      if (projection.entityState !== "present" || items.has(projection.entityId)) continue
      items.set(
        projection.entityId,
        presentProjection(workspaceId, inspection.releaseId, {
          ...entry,
          canonicalReleaseId: inspection.releaseId
        })
      )
    }
  }
  return [...items.values()].sort((left, right) =>
    left.service.localeCompare(right.service) || left.key.localeCompare(right.key)
  )
}
