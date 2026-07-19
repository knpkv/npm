import type {
  RlyCollaboratorCategory,
  RlyFreshnessState,
  RlyPerson,
  RlyRelationship,
  RlyService,
  RlyTimelineEvent,
  RlyVerdictTone
} from "@knpkv/rly/patterns"
import * as DateTime from "effect/DateTime"

import type { WorkspaceEntityInspection, WorkspaceEntityOwner } from "../../api/deliveryGraph.js"
import type { Role } from "../../domain/actors.js"
import type {
  DeliveryEntityDetails,
  DeliveryEntityKind,
  DeliveryNode,
  DeliveryRelationship
} from "../../domain/deliveryGraph.js"
import type { EntityId, GraphNodeId, ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import type { SourceRevision } from "../../domain/sourceRevision.js"
import { serviceFor, statusFor, statusPresentation } from "../items/presentWorkspaceItems.js"
import { workspaceEntityPath } from "../workspaceEntityPaths.js"

export interface WorkspaceEntityFact {
  readonly label: string
  readonly value: string
}

export interface WorkspaceEntityActionPresentation {
  readonly external: boolean
  readonly href: string | null
  readonly label: string
}

export interface WorkspaceEntityCollaboratorsPresentation {
  readonly approvers: ReadonlyArray<RlyPerson>
  readonly authors: ReadonlyArray<RlyPerson>
  readonly emptyLabel: string
  readonly expandedCategories: ReadonlyArray<RlyCollaboratorCategory>
  readonly operators: ReadonlyArray<RlyPerson>
  readonly owners: ReadonlyArray<RlyPerson>
  readonly reviewers: ReadonlyArray<RlyPerson>
}

export interface WorkspaceEntityEvidencePresentation {
  readonly claimCount: number
  readonly freshness: RlyFreshnessState
  readonly freshnessDateTime: string
  readonly freshnessTime: string
  readonly itemCount: number
  readonly reference: string
}

export interface WorkspaceEntityReleasePresentation {
  readonly href: string
  readonly id: ReleaseId
  readonly label: string
}

export interface WorkspaceEntityPresentation {
  readonly activity: ReadonlyArray<RlyTimelineEvent>
  readonly activityEmptyLabel: string
  readonly agentContext: string
  readonly collaborators: WorkspaceEntityCollaboratorsPresentation
  readonly contentSummary: string
  readonly displayKey: string
  readonly evidence: WorkspaceEntityEvidencePresentation
  readonly facts: ReadonlyArray<WorkspaceEntityFact>
  readonly freshness: RlyFreshnessState
  readonly freshnessDateTime: string
  readonly freshnessTime: string
  readonly kindLabel: string
  readonly partialMessages: ReadonlyArray<string>
  readonly primaryAction: WorkspaceEntityActionPresentation
  readonly relationships: ReadonlyArray<RlyRelationship>
  readonly relationshipEmptyLabel: string
  readonly releases: ReadonlyArray<WorkspaceEntityReleasePresentation>
  readonly service: RlyService
  readonly serviceName: string
  readonly title: string
  readonly tone: RlyVerdictTone
  readonly verdict: string
}

const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
})

const titleCase = (value: string): string =>
  value.split("-").map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`).join(" ")

const serviceNames = {
  clockify: "Clockify",
  codecommit: "CodeCommit",
  codepipeline: "CodePipeline",
  confluence: "Confluence",
  jira: "Jira"
} satisfies Readonly<Record<RlyService, string>>

const kindNames = {
  deployment: "Deployment",
  issue: "Issue",
  page: "Page",
  "pipeline-execution": "Pipeline execution",
  "pull-request": "Pull request",
  "time-entry": "Time entry"
} satisfies Readonly<Record<DeliveryEntityKind, string>>

const readableTimestamp = (timestamp: DateTime.DateTime): string =>
  timestampFormatter.format(DateTime.toDateUtc(timestamp))

const sourceHref = (source: SourceRevision): string | null => source.sourceUrl === null ? null : source.sourceUrl.href

const releaseHref = (workspaceId: WorkspaceId, releaseId: ReleaseId): string =>
  `/w/${encodeURIComponent(workspaceId)}/releases/${encodeURIComponent(releaseId)}`

const shortIdentity = (identity: string): string => identity.slice(-8)

const factsFor = (details: DeliveryEntityDetails): ReadonlyArray<WorkspaceEntityFact> => {
  switch (details._tag) {
    case "issue":
      return [
        { label: "Priority", value: details.priority ?? "Not set" },
        {
          label: "Estimate",
          value: details.estimatePoints === null ? "Not estimated" : `${details.estimatePoints} points`
        }
      ]
    case "pull-request":
      return [
        { label: "Repository", value: details.repository },
        { label: "Branches", value: `${details.sourceBranch} → ${details.targetBranch}` },
        { label: "Head revision", value: details.headRevision }
      ]
    case "page":
      return [
        { label: "Space", value: details.spaceKey },
        { label: "Revision", value: details.revision }
      ]
    case "pipeline-execution":
      return [
        { label: "Pipeline", value: details.pipelineName },
        { label: "Execution", value: details.executionId },
        { label: "Trigger revision", value: details.triggerRevision }
      ]
    case "deployment":
      return [
        { label: "Environment", value: shortIdentity(details.environmentId) },
        { label: "Revision", value: details.revision }
      ]
    case "time-entry":
      return [
        { label: "Duration", value: `${details.durationMinutes} min` },
        { label: "Billable", value: details.billable ? "Yes" : "No" }
      ]
  }
}

const roleLabel = (role: Role): string => titleCase(role)

const personFor = (owner: WorkspaceEntityOwner): RlyPerson => ({
  avatarFallback: owner.avatarFallback,
  id: owner.personId,
  name: owner.displayName,
  role: [...new Set(owner.roles.map(roleLabel))].join(" · ")
})

const collaboratorCategory = (roles: ReadonlyArray<Role>): RlyCollaboratorCategory => {
  if (roles.some((role) => role.includes("approver"))) return "approvers"
  if (roles.some((role) => role === "reviewer" || role === "watcher")) return "reviewers"
  if (roles.includes("operator")) return "operators"
  if (roles.some((role) => role === "author" || role === "contributor")) return "authors"
  return "owners"
}

const collaboratorsFor = (
  owners: ReadonlyArray<WorkspaceEntityOwner>
): WorkspaceEntityCollaboratorsPresentation => {
  const categoryOrder: ReadonlyArray<RlyCollaboratorCategory> = [
    "authors",
    "owners",
    "reviewers",
    "operators",
    "approvers"
  ]
  const categories: Record<RlyCollaboratorCategory, Array<RlyPerson>> = {
    approvers: [],
    authors: [],
    operators: [],
    owners: [],
    reviewers: []
  }
  for (const owner of owners) categories[collaboratorCategory(owner.roles)].push(personFor(owner))
  const expandedCategories = categoryOrder.filter((category) => categories[category].length > 0)
  return {
    ...categories,
    emptyLabel: "No collaborator is assigned to this object.",
    expandedCategories
  }
}

const freshnessFor = (inspection: WorkspaceEntityInspection): RlyFreshnessState => {
  const freshness = inspection.freshness
  if (freshness === null) return inspection.isSourceCurrent ? "current" : "cached"
  if (freshness._tag === "current") {
    return inspection.isSourceCurrent && freshness.provenance._tag === "provider" ? "current" : "cached"
  }
  return freshness._tag
}

const freshnessTimestamp = (inspection: WorkspaceEntityInspection): DateTime.DateTime => {
  const freshness = inspection.freshness
  if (freshness === null) return inspection.entity.recordedAt
  return freshness.sourceObservedAt ?? freshness.synchronizedAt ?? freshness.pluginHealth.checkedAt
}

const endpointFor = (
  node: DeliveryNode | undefined,
  entityById: ReadonlyMap<EntityId, WorkspaceEntityInspection["entity"]["projection"]>,
  service: RlyService,
  workspaceId: WorkspaceId
): RlyRelationship["source"] => {
  if (node === undefined) {
    return { state: "missing", label: "Unknown graph endpoint", reason: "The endpoint is outside this graph response." }
  }
  if (node.resolution._tag === "missing") {
    return {
      state: "missing",
      label: node.resolution.missingKey,
      reason: `${titleCase(node.endpointKind)} is not connected.`
    }
  }
  const target = node.resolution.target
  if (target._tag === "entity") {
    const projection = entityById.get(target.entityId)
    if (projection === undefined) {
      return {
        state: "missing",
        label: `${kindNames[target.entityKind]} ${shortIdentity(target.entityId)}`,
        reason: "The related object is outside this bounded response.",
        service: serviceFor(target.entityKind)
      }
    }
    return {
      state: "present",
      href: workspaceEntityPath(workspaceId, projection.entityId),
      id: projection.entityId,
      reference: projection.displayKey,
      service: serviceFor(projection.entityType),
      title: projection.title
    }
  }
  if (target._tag === "release") {
    return {
      state: "present",
      href: releaseHref(workspaceId, target.releaseId),
      id: target.releaseId,
      reference: `Control Center release · ${shortIdentity(target.releaseId)}`,
      service,
      title: "Delivery release"
    }
  }
  return {
    state: "present",
    id: target.environmentId,
    reference: `Control Center environment · ${shortIdentity(target.environmentId)}`,
    service,
    title: "Delivery environment"
  }
}

const relationshipEvidence = (relationship: DeliveryRelationship): string => {
  const evidence = relationship.evidenceClaimIds.length
  const confidence = relationship.confidence._tag === "inferred"
    ? `${Math.round(relationship.confidence.score * 100)}% inferred`
    : titleCase(relationship.confidence._tag)
  return `${evidence} evidence claim${evidence === 1 ? "" : "s"} · ${confidence}`
}

const relationshipsFor = (
  inspection: WorkspaceEntityInspection,
  workspaceId: WorkspaceId,
  service: RlyService
): ReadonlyArray<RlyRelationship> => {
  const nodeById = new Map<GraphNodeId, DeliveryNode>(inspection.graph.nodes.map((node) => [node.nodeId, node]))
  const projections = [inspection.entity, ...inspection.graph.relatedEntityProjections]
    .map(({ projection }) => projection)
  const entityById = new Map<EntityId, WorkspaceEntityInspection["entity"]["projection"]>(
    projections.map((projection) => [projection.entityId, projection])
  )
  const ownerById = new Map(inspection.entity.owners.map((owner) => [owner.personId, owner]))
  return inspection.graph.relationships.map((relationship) => {
    const actorOwner = relationship.recordedBy._tag === "human"
      ? ownerById.get(relationship.recordedBy.personId)
      : undefined
    return {
      ...(actorOwner === undefined ? {} : { actor: personFor(actorOwner) }),
      direction: "forward",
      evidence: relationshipEvidence(relationship),
      id: relationship.relationshipId,
      kind: titleCase(relationship.kind),
      lifecycle: relationship.lifecycle._tag,
      source: endpointFor(nodeById.get(relationship.sourceNodeId), entityById, service, workspaceId),
      target: endpointFor(nodeById.get(relationship.targetNodeId), entityById, service, workspaceId)
    }
  })
}

const activityFor = (inspection: WorkspaceEntityInspection): ReadonlyArray<RlyTimelineEvent> =>
  inspection.activity.events.map((event) => ({
    actor: event.actor.label,
    actorKind: event.actor.kind,
    dateTime: DateTime.formatIso(event.occurredAt),
    detail: titleCase(event.sourceKind),
    ...(event.href === null ? {} : { href: event.href }),
    id: event.eventKey,
    ...(event.service === null ? {} : { service: event.service }),
    time: readableTimestamp(event.occurredAt),
    title: event.title
  }))

const primaryActionFor = (
  inspection: WorkspaceEntityInspection,
  workspaceId: WorkspaceId,
  serviceName: string
): WorkspaceEntityActionPresentation => {
  const href = sourceHref(inspection.source)
  if (href !== null) return { external: true, href, label: `Open in ${serviceName}` }
  const releaseId = inspection.entity.canonicalReleaseId
  return releaseId === null
    ? { external: false, href: null, label: "Source link unavailable" }
    : { external: false, href: releaseHref(workspaceId, releaseId), label: "Open delivery release" }
}

const partialMessagesFor = (inspection: WorkspaceEntityInspection): ReadonlyArray<string> => [
  ...(inspection.entity.ownersTruncated ? ["More collaborators exist than this bounded view can show."] : []),
  ...(inspection.entity.releaseMembershipsTruncated
    ? ["More release memberships exist than this bounded delivery path can show."]
    : []),
  ...(inspection.graph.truncated ? ["The relationship graph is partial; additional delivery links exist."] : []),
  ...(inspection.activity.truncated ? ["The activity list is partial; older events are not shown."] : [])
]

/** Turn one provider-neutral canonical read into explicit application-owned Rly inputs. */
export const presentWorkspaceEntity = (
  workspaceId: WorkspaceId,
  inspection: WorkspaceEntityInspection
): WorkspaceEntityPresentation => {
  const projection = inspection.entity.projection
  const service = serviceFor(projection.entityType)
  const serviceName = serviceNames[service]
  const verdict = statusFor(projection.details)
  const freshnessTimestampValue = freshnessTimestamp(inspection)
  const releaseCount = inspection.entity.releaseIds.length
  return {
    activity: activityFor(inspection),
    activityEmptyLabel: "No attributable activity has been recorded for this object.",
    agentContext: `${projection.displayKey} · ${projection.title} · ${serviceName}`,
    collaborators: collaboratorsFor(inspection.entity.owners),
    contentSummary: `${kindNames[projection.entityType]} ${projection.displayKey} is tracked in ${serviceName}. ${
      releaseCount === 0
        ? "It is not linked to a release yet."
        : `It belongs to ${releaseCount}${inspection.entity.releaseMembershipsTruncated ? "+" : ""} release${
          releaseCount === 1 ? "" : "s"
        }.`
    }`,
    displayKey: projection.displayKey,
    evidence: {
      claimCount: inspection.graph.evidenceClaims.length,
      freshness: freshnessFor(inspection),
      freshnessDateTime: DateTime.formatIso(freshnessTimestampValue),
      freshnessTime: readableTimestamp(freshnessTimestampValue),
      itemCount: inspection.graph.evidenceItems.length,
      reference: `${projection.displayKey} · source revision ${inspection.source.revision}`
    },
    facts: [
      { label: "Object", value: kindNames[projection.entityType] },
      { label: "Service", value: serviceName },
      ...factsFor(projection.details)
    ],
    freshness: freshnessFor(inspection),
    freshnessDateTime: DateTime.formatIso(freshnessTimestampValue),
    freshnessTime: readableTimestamp(freshnessTimestampValue),
    kindLabel: kindNames[projection.entityType],
    partialMessages: partialMessagesFor(inspection),
    primaryAction: primaryActionFor(inspection, workspaceId, serviceName),
    relationships: relationshipsFor(inspection, workspaceId, service),
    relationshipEmptyLabel: "No delivery relationships have been recorded for this object.",
    releases: inspection.entity.releaseIds.map((releaseId) => ({
      href: releaseHref(workspaceId, releaseId),
      id: releaseId,
      label: `Release ${shortIdentity(releaseId)}`
    })),
    service,
    serviceName,
    title: projection.title,
    tone: statusPresentation(projection.entityType, verdict).tone,
    verdict
  }
}
