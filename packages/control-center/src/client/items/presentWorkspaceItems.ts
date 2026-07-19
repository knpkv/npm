import type { RlyService } from "@knpkv/rly/patterns"
import type { RlyStateTone } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"

import type {
  ReleaseDeliveryGraphInspection,
  WorkspaceEntityOwner,
  WorkspaceEntityProjectionIndex
} from "../../api/deliveryGraph.js"
import type { Role } from "../../domain/actors.js"
import type {
  DeliveryEntityDetails,
  DeliveryEntityKind,
  DeliveryEntityStatusGroup
} from "../../domain/deliveryGraph.js"
import type { EntityId, ReleaseId, WorkspaceId } from "../../domain/identifiers.js"

export type WorkspaceItemStatus = DeliveryEntityStatusGroup

export interface WorkspaceItemPresentation {
  readonly entityId: EntityId
  readonly freshness: string
  readonly href: string
  readonly key: string
  readonly kind: DeliveryEntityKind
  readonly owner: string
  readonly owners: ReadonlyArray<WorkspaceItemOwnerPresentation>
  readonly ownersTruncated: boolean
  readonly releaseId: ReleaseId | null
  readonly releaseIds: ReadonlyArray<ReleaseId>
  readonly releaseMembershipsTruncated: boolean
  readonly routableReleaseIds: ReadonlyArray<ReleaseId>
  readonly service: RlyService
  readonly status: string
  readonly statusGroup: WorkspaceItemStatus
  readonly title: string
  readonly tone: RlyStateTone
}

export interface WorkspaceItemOwnerPresentation {
  readonly avatarFallback: string
  readonly id: string
  readonly name: string
  readonly role: string
  readonly roles: ReadonlyArray<Role>
}

const collaboratorRoleLabel = (role: Role): string => {
  switch (role) {
    case "change-owner":
    case "issue-owner":
    case "page-owner":
      return "Owner"
    case "issue-assignee":
      return "Assignee"
    case "author":
      return "Author"
    case "operator":
      return "Operator"
    default:
      return titleCase(role)
  }
}

export const serviceFor = (kind: DeliveryEntityKind): RlyService => {
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

export const statusFor = (details: DeliveryEntityDetails): string => {
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

export const statusPresentation = (
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

export const workspaceItemReleaseHref = (
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  entityId: EntityId
): string => `/w/${workspaceId}/releases/${releaseId}?object=${encodeURIComponent(entityId)}#release-work`

const itemHref = (workspaceId: WorkspaceId, entityId: EntityId): string =>
  `/w/${workspaceId}/items/${encodeURIComponent(entityId)}`

const presentProjection = (
  workspaceId: WorkspaceId,
  entry: ReleaseDeliveryGraphInspection["entityProjections"][number] & {
    readonly canonicalReleaseId: ReleaseId | null
    readonly owners?: ReadonlyArray<WorkspaceEntityOwner>
    readonly ownersTruncated?: boolean
    readonly releaseIds: ReadonlyArray<ReleaseId>
    readonly releaseMembershipsTruncated: boolean
  },
  routableReleaseIds?: ReadonlySet<ReleaseId>
): WorkspaceItemPresentation => {
  const projection = entry.projection
  const status = statusFor(projection.details)
  const routableMemberships = entry.releaseIds.filter(
    (releaseId) => routableReleaseIds === undefined || routableReleaseIds.has(releaseId)
  )
  const releaseId = entry.releaseIds.length === 1 && !entry.releaseMembershipsTruncated
    ? (routableMemberships[0] ?? null)
    : null
  const owners: ReadonlyArray<WorkspaceItemOwnerPresentation> = (entry.owners ?? []).map(({
    avatarFallback,
    displayName,
    personId,
    roles
  }) => ({
    avatarFallback,
    id: personId,
    name: displayName,
    role: [...new Set(roles.map(collaboratorRoleLabel))].join(" · "),
    roles
  }))
  return {
    entityId: projection.entityId,
    freshness: DateTime.formatIso(entry.recordedAt),
    href: itemHref(workspaceId, projection.entityId),
    key: projection.displayKey,
    kind: projection.entityType,
    owner: owners.length === 0 ? "Unassigned" : owners.map(({ name }) => name).join(", "),
    owners,
    ownersTruncated: entry.ownersTruncated ?? false,
    releaseId,
    releaseIds: entry.releaseIds,
    releaseMembershipsTruncated: entry.releaseMembershipsTruncated,
    routableReleaseIds: routableMemberships,
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
    .map((entry) => presentProjection(workspaceId, entry, routableReleaseIds))
    .sort((left, right) => left.service.localeCompare(right.service) || left.key.localeCompare(right.key))

/** Present bounded release slices as one deduplicated release-linked item index. */
export const presentWorkspaceItems = (
  workspaceId: WorkspaceId,
  inspections: ReadonlyArray<ReleaseDeliveryGraphInspection>
): ReadonlyArray<WorkspaceItemPresentation> => {
  const items = new Map<EntityId, {
    readonly entry: ReleaseDeliveryGraphInspection["entityProjections"][number]
    readonly releaseIds: Set<ReleaseId>
  }>()
  const canonicalInspections = [...inspections].sort((left, right) => left.releaseId.localeCompare(right.releaseId))
  for (const inspection of canonicalInspections) {
    for (const entry of inspection.entityProjections) {
      const projection = entry.projection
      if (projection.entityState !== "present") continue
      const existing = items.get(projection.entityId)
      if (existing !== undefined) {
        existing.releaseIds.add(inspection.releaseId)
        continue
      }
      items.set(projection.entityId, { entry, releaseIds: new Set([inspection.releaseId]) })
    }
  }
  return [...items.values()].map(({ entry, releaseIds: membershipSet }) => {
    const releaseIds = [...membershipSet].sort((left, right) => left.localeCompare(right))
    return presentProjection(workspaceId, {
      ...entry,
      canonicalReleaseId: releaseIds[0] ?? null,
      releaseIds,
      releaseMembershipsTruncated: false
    })
  }).sort((left, right) => left.service.localeCompare(right.service) || left.key.localeCompare(right.key))
}
