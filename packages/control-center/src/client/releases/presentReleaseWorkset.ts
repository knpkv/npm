import type {
  RlyService,
  RlyStage,
  RlyWorksetGap,
  RlyWorksetJiraItem,
  RlyWorksetPipeline,
  RlyWorksetPullRequestGroup
} from "@knpkv/rly/patterns"
import type { RlyStateTone } from "@knpkv/rly/primitives"

import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import type {
  DeliveryEntityDetails,
  DeliveryEntityProjection,
  DeliveryRelationship,
  EvidenceClaim
} from "../../domain/deliveryGraph.js"
import type {
  EntityId,
  EvidenceId,
  GraphNodeId,
  RelationshipId,
  ReleaseId,
  WorkspaceId
} from "../../domain/identifiers.js"
import { workspaceEntityPath } from "../workspaceEntityPaths.js"

type Projection = ReleaseDeliveryGraphInspection["entityProjections"][number]["projection"]
type ProjectionWithDetails<Tag extends DeliveryEntityDetails["_tag"]> = Projection & {
  readonly details: Extract<DeliveryEntityDetails, { readonly _tag: Tag }>
}

export interface ReleaseWorksetRunbook {
  readonly href: string
  readonly id: EntityId
  readonly reference: string
  readonly state: string
  readonly title: string
}

export interface SelectedReleaseWorksetObject {
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>
  readonly id: EntityId
  readonly kind: DeliveryEntityProjection["entityType"]
  readonly label: string
  readonly service: RlyService
  readonly status: string
  readonly title: string
  readonly tone: RlyStateTone
}

export interface SelectedReleaseWorksetTraceConnection {
  readonly href: string | null
  readonly kind: string
  readonly label: string
  readonly service: RlyService | null
  readonly title: string
}

export interface SelectedReleaseWorksetTraceRelationship {
  readonly confidence: string
  readonly detailsHref: string
  readonly direction: "incoming" | "outgoing"
  readonly evidenceCount: number
  readonly id: RelationshipId
  readonly kind: DeliveryRelationship["kind"]
  readonly lifecycle: string
  readonly other: SelectedReleaseWorksetTraceConnection
  readonly tone: RlyStateTone
}

export interface SelectedReleaseWorksetTrace {
  readonly relationships: ReadonlyArray<SelectedReleaseWorksetTraceRelationship>
  readonly truncated: boolean
}

export interface ReleaseWorksetPresentation {
  readonly gaps: ReadonlyArray<RlyWorksetGap>
  readonly jiraItems: ReadonlyArray<RlyWorksetJiraItem>
  readonly pipelines: ReadonlyArray<RlyWorksetPipeline>
  readonly pullRequestGroups: ReadonlyArray<RlyWorksetPullRequestGroup>
  readonly runbooks: ReadonlyArray<ReleaseWorksetRunbook>
  readonly truncated: boolean
}

const relationshipHref = (
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  entityId: EntityId,
  relationshipId: RelationshipId
): string =>
  `/w/${workspaceId}/releases/${releaseId}?object=${encodeURIComponent(entityId)}&relationship=${
    encodeURIComponent(relationshipId)
  }#release-work`

const statusTone = (status: string): RlyStateTone => {
  const normalized = status.toLocaleLowerCase("en-US")
  if (
    ["blocked", "changes requested", "failed", "rejected", "rolled back", "stopped", "superseded"].some(
      (value) => normalized.includes(value)
    )
  ) {
    return "critical"
  }
  if (
    ["approved", "closed", "current", "done", "merged", "not required", "passed", "ready", "resolved", "succeeded"]
      .some((value) => normalized.includes(value))
  ) return "positive"
  if (
    ["deploying", "in progress", "in review", "pending", "queued", "requested", "running", "verifying"]
      .some((value) => normalized.includes(value))
  ) return "progress"
  return "neutral"
}

const reviewStateLabel = (
  state: Extract<DeliveryEntityDetails, { readonly _tag: "pull-request" }>["reviewState"]
): string => {
  switch (state) {
    case "not-requested":
      return "Review not requested"
    case "requested":
      return "Review requested"
    case "changes-requested":
      return "Changes requested"
    case "approved":
      return "Approved"
    case "merged":
      return "Merged"
  }
}

const pipelineStateLabel = (
  state: Extract<DeliveryEntityDetails, { readonly _tag: "pipeline-execution" }>["status"]
): string => `${state.charAt(0).toLocaleUpperCase("en-US")}${state.slice(1)}`

const titleCase = (value: string): string =>
  value.split("-").map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`).join(" ")

const selectedObjectService = (kind: DeliveryEntityProjection["entityType"]): RlyService => {
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

const selectedObjectStatus = (details: DeliveryEntityDetails): string => {
  switch (details._tag) {
    case "issue":
      return details.status
    case "pull-request":
      return reviewStateLabel(details.reviewState)
    case "page":
    case "deployment":
      return titleCase(details.status)
    case "pipeline-execution":
      return pipelineStateLabel(details.status)
    case "time-entry":
      return titleCase(details.approvalState)
  }
}

const selectedObjectFacts = (
  details: DeliveryEntityDetails
): ReadonlyArray<{ readonly label: string; readonly value: string }> => {
  switch (details._tag) {
    case "issue":
      return [
        { label: "Priority", value: details.priority ?? "Not set" },
        { label: "Estimate", value: details.estimatePoints === null ? "Not set" : `${details.estimatePoints} points` }
      ]
    case "pull-request":
      return [
        { label: "Repository", value: details.repository },
        { label: "Branch", value: `${details.sourceBranch} → ${details.targetBranch}` },
        { label: "Revision", value: details.headRevision }
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
        { label: "Revision", value: details.triggerRevision }
      ]
    case "deployment":
      return [
        { label: "Environment", value: details.environmentId },
        { label: "Revision", value: details.revision }
      ]
    case "time-entry":
      return [
        { label: "Duration", value: `${details.durationMinutes} minutes` },
        { label: "Billing", value: details.billable ? "Billable" : "Non-billable" }
      ]
  }
}

const presentSelectedObject = (selected: DeliveryEntityProjection): SelectedReleaseWorksetObject => {
  const status = selectedObjectStatus(selected.details)
  return {
    facts: selectedObjectFacts(selected.details),
    id: selected.entityId,
    kind: selected.entityType,
    label: selected.displayKey,
    service: selectedObjectService(selected.entityType),
    status,
    title: selected.title,
    tone: statusTone(status)
  }
}

/** Resolve every present normalized object into an inspectable selected-object surface. */
export const selectReleaseWorksetObject = (
  inspection: ReleaseDeliveryGraphInspection,
  selectedObjectId: string | null
): SelectedReleaseWorksetObject | null => {
  if (selectedObjectId === null) return null
  const selected = inspection.entityProjections.find(
    ({ projection }) => projection.entityState === "present" && projection.entityId === selectedObjectId
  )?.projection
  if (selected === undefined) return null
  return presentSelectedObject(selected)
}

const currentRelationship = (relationship: DeliveryRelationship): boolean =>
  relationship.lifecycle._tag !== "missing" &&
  relationship.lifecycle._tag !== "rejected" &&
  relationship.lifecycle._tag !== "superseded"

const gapService = (relationship: DeliveryRelationship): RlyService => {
  const missingKind = relationship.sourceNodeKind === "release"
    ? relationship.targetNodeKind
    : relationship.sourceNodeKind
  switch (missingKind) {
    case "issue":
      return "jira"
    case "page":
      return "confluence"
    case "pipeline-execution":
    case "deployment":
      return "codepipeline"
    case "time-entry":
      return "clockify"
    case "pull-request":
    case "release":
    case "environment":
      return "codecommit"
  }
  return "codecommit"
}

const entityProjectionByNode = (
  inspection: ReleaseDeliveryGraphInspection
): ReadonlyMap<GraphNodeId, DeliveryEntityProjection> => {
  const projections = new Map(inspection.entityProjections.map(({ projection }) => [projection.entityId, projection]))
  return new Map(
    inspection.nodes.flatMap((node): ReadonlyArray<readonly [GraphNodeId, DeliveryEntityProjection]> => {
      if (node.resolution._tag !== "resolved" || node.resolution.target._tag !== "entity") return []
      const projection = projections.get(node.resolution.target.entityId)
      return projection === undefined ? [] : [[node.nodeId, projection]]
    })
  )
}

const relationshipLifecycleTone = (lifecycle: DeliveryRelationship["lifecycle"]["_tag"]): RlyStateTone => {
  switch (lifecycle) {
    case "missing":
    case "rejected":
      return "critical"
    case "governed":
    case "verified":
      return "positive"
    case "inferred":
    case "proposed":
      return "progress"
    case "superseded":
      return "neutral"
  }
}

const relationshipConfidenceLabel = (confidence: DeliveryRelationship["confidence"]): string => {
  switch (confidence._tag) {
    case "confirmed":
      return "Confirmed"
    case "inferred":
      return `Inferred ${String(Math.round(confidence.score * 100))}%`
    case "unknown":
      return "Confidence unknown"
  }
}

const traceConnection = (
  inspection: ReleaseDeliveryGraphInspection,
  workspaceId: WorkspaceId,
  nodeId: GraphNodeId,
  projections: ReadonlyMap<GraphNodeId, DeliveryEntityProjection>
): SelectedReleaseWorksetTraceConnection => {
  const projection = projections.get(nodeId)
  if (projection !== undefined) {
    const selected = presentSelectedObject(projection)
    return {
      href: projection.entityState === "present"
        ? workspaceEntityPath(workspaceId, projection.entityId)
        : null,
      kind: selected.kind,
      label: selected.label,
      service: selected.service,
      title: projection.entityState === "present" ? selected.title : `${selected.title} · Deleted`
    }
  }
  const node = inspection.nodes.find((candidate) => candidate.nodeId === nodeId)
  if (node?.resolution._tag === "missing") {
    return {
      href: null,
      kind: node.endpointKind,
      label: node.resolution.missingKey,
      service: null,
      title: `Missing ${titleCase(node.endpointKind)}`
    }
  }
  if (node?.resolution._tag === "resolved" && node.resolution.target._tag === "release") {
    const isCurrentRelease = node.resolution.target.releaseId === inspection.releaseId
    return {
      href: null,
      kind: "release",
      label: `Release ${node.resolution.target.releaseId.slice(-6)}`,
      service: null,
      title: isCurrentRelease ? "Current release context" : "Connected release"
    }
  }
  if (node?.resolution._tag === "resolved" && node.resolution.target._tag === "environment") {
    return {
      href: null,
      kind: "environment",
      label: `Environment ${node.resolution.target.environmentId.slice(-6)}`,
      service: null,
      title: "Delivery environment"
    }
  }
  return { href: null, kind: "unknown", label: nodeId.slice(-6), service: null, title: "Unresolved graph node" }
}

/** Center the bounded current release graph on one selected normalized object. */
export const selectReleaseWorksetTrace = (
  inspection: ReleaseDeliveryGraphInspection,
  workspaceId: WorkspaceId,
  selectedObjectId: string | null
): SelectedReleaseWorksetTrace | null => {
  const selectedObject = selectReleaseWorksetObject(inspection, selectedObjectId)
  if (selectedObject === null || selectedObjectId === null) return null
  const selectedNodeIds = new Set(
    inspection.nodes.flatMap((node): ReadonlyArray<GraphNodeId> =>
      node.resolution._tag === "resolved" &&
        node.resolution.target._tag === "entity" &&
        node.resolution.target.entityId === selectedObjectId
        ? [node.nodeId]
        : []
    )
  )
  const projections = entityProjectionByNode(inspection)
  const relationships = inspection.relationships.flatMap(
    (relationship): ReadonlyArray<SelectedReleaseWorksetTraceRelationship> => {
      const direction = selectedNodeIds.has(relationship.sourceNodeId)
        ? "outgoing"
        : selectedNodeIds.has(relationship.targetNodeId)
        ? "incoming"
        : null
      if (direction === null) return []
      const otherNodeId = direction === "outgoing" ? relationship.targetNodeId : relationship.sourceNodeId
      return [{
        confidence: relationshipConfidenceLabel(relationship.confidence),
        detailsHref: relationshipHref(
          workspaceId,
          inspection.releaseId,
          selectedObject.id,
          relationship.relationshipId
        ),
        direction,
        evidenceCount: relationship.evidenceClaimIds.length,
        id: relationship.relationshipId,
        kind: relationship.kind,
        lifecycle: titleCase(relationship.lifecycle._tag),
        other: traceConnection(inspection, workspaceId, otherNodeId, projections),
        tone: relationshipLifecycleTone(relationship.lifecycle._tag)
      }]
    }
  ).sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.other.label.localeCompare(right.other.label) ||
    left.id.localeCompare(right.id)
  )
  return { relationships, truncated: inspection.truncated }
}

/** Resolve a URL-selected relationship only when it touches the selected object in this bounded slice. */
export const selectReleaseWorksetRelationship = (
  inspection: ReleaseDeliveryGraphInspection,
  selectedObjectId: string | null,
  selectedRelationshipId: string | null
): DeliveryRelationship | null => {
  if (
    selectedRelationshipId === null ||
    selectedObjectId === null ||
    selectReleaseWorksetObject(inspection, selectedObjectId) === null
  ) return null
  const selectedNodeIds = new Set(
    inspection.nodes.flatMap((node): ReadonlyArray<GraphNodeId> =>
      node.resolution._tag === "resolved" &&
        node.resolution.target._tag === "entity" &&
        node.resolution.target.entityId === selectedObjectId
        ? [node.nodeId]
        : []
    )
  )
  let selected: DeliveryRelationship | null = null
  for (const relationship of inspection.relationships) {
    if (
      relationship.relationshipId === selectedRelationshipId &&
      (selectedNodeIds.has(relationship.sourceNodeId) || selectedNodeIds.has(relationship.targetNodeId)) &&
      (selected === null || relationship.revision > selected.revision)
    ) selected = relationship
  }
  return selected
}

/** Resolve exact referenced claims from the closure-checked release slice. */
export const releaseWorksetRelationshipEvidenceClaims = (
  inspection: ReleaseDeliveryGraphInspection,
  relationship: DeliveryRelationship | null
): ReadonlyArray<EvidenceClaim> => {
  if (relationship === null) return []
  const claimById = new Map(inspection.evidenceClaims.map((claim) => [claim.evidenceClaimId, claim]))
  return relationship.evidenceClaimIds.flatMap((claimId) => {
    const claim = claimById.get(claimId)
    return claim === undefined ? [] : [claim]
  })
}

/** Resolve the unique evidence observations referenced by one relationship from the closed release slice. */
export const releaseWorksetRelationshipEvidenceIds = (
  inspection: ReleaseDeliveryGraphInspection,
  relationship: DeliveryRelationship | null
): ReadonlyArray<EvidenceId> => {
  const evidenceIds = new Set<EvidenceId>()
  for (const claim of releaseWorksetRelationshipEvidenceClaims(inspection, relationship)) {
    evidenceIds.add(claim.evidenceId)
  }
  return [...evidenceIds].sort((left, right) => left.localeCompare(right))
}

const releaseRunbookEntityIds = (
  inspection: ReleaseDeliveryGraphInspection,
  projections: ReadonlyMap<GraphNodeId, DeliveryEntityProjection>
): ReadonlySet<EntityId> => {
  const nodes = new Map(inspection.nodes.map((node) => [node.nodeId, node]))
  return new Set(
    inspection.relationships.flatMap((relationship): ReadonlyArray<EntityId> => {
      if (
        relationship.kind !== "documented-by" ||
        relationship.sourceNodeKind !== "release" ||
        relationship.targetNodeKind !== "page" ||
        !currentRelationship(relationship)
      ) return []
      const source = nodes.get(relationship.sourceNodeId)
      const target = projections.get(relationship.targetNodeId)
      return source?.resolution._tag === "resolved" &&
          source.resolution.target._tag === "release" &&
          source.resolution.target.releaseId === inspection.releaseId &&
          target?.details._tag === "page"
        ? [target.entityId]
        : []
    })
  )
}

const gapLabel = (
  relationship: DeliveryRelationship,
  projections: ReadonlyMap<GraphNodeId, DeliveryEntityProjection>
): string => {
  const issue = relationship.sourceNodeKind === "issue"
    ? projections.get(relationship.sourceNodeId)
    : relationship.targetNodeKind === "issue"
    ? projections.get(relationship.targetNodeId)
    : undefined
  if (issue?.details._tag === "issue" && relationship.sourceNodeKind === "pull-request") {
    return `${issue.details.key} has no CodeCommit pull request`
  }
  return `Missing ${relationship.sourceNodeKind} → ${relationship.targetNodeKind} relationship`
}

/** Present one bounded graph inspection as three explicit release-work dimensions. */
export const presentReleaseWorkset = (
  inspection: ReleaseDeliveryGraphInspection,
  workspaceId: WorkspaceId,
  stages: ReadonlyArray<RlyStage>
): ReleaseWorksetPresentation => {
  const projections = entityProjectionByNode(inspection)
  const runbookEntityIds = releaseRunbookEntityIds(inspection, projections)
  const href = (projection: DeliveryEntityProjection): string => workspaceEntityPath(workspaceId, projection.entityId)
  const issues = inspection.entityProjections
    .map(({ projection }) => projection)
    .filter((projection): projection is ProjectionWithDetails<"issue"> =>
      projection.entityType === "issue" && projection.details._tag === "issue" && projection.entityState === "present"
    )
  const pullRequests = inspection.entityProjections
    .map(({ projection }) => projection)
    .filter((projection): projection is ProjectionWithDetails<"pull-request"> =>
      projection.entityType === "pull-request" &&
      projection.details._tag === "pull-request" &&
      projection.entityState === "present"
    )
  const pipelineExecutions = inspection.entityProjections
    .map(({ projection }) => projection)
    .filter((projection): projection is ProjectionWithDetails<"pipeline-execution"> =>
      projection.entityType === "pipeline-execution" &&
      projection.details._tag === "pipeline-execution" &&
      projection.entityState === "present"
    )
  const pages = inspection.entityProjections
    .map(({ projection }) => projection)
    .filter((projection): projection is ProjectionWithDetails<"page"> =>
      projection.entityType === "page" &&
      projection.details._tag === "page" &&
      projection.entityState === "present" &&
      runbookEntityIds.has(projection.entityId)
    )

  return {
    jiraItems: issues.map((issue) => ({
      id: issue.entityId,
      key: issue.details.key,
      title: issue.title,
      state: issue.details.status,
      tone: statusTone(issue.details.status),
      href: href(issue)
    })),
    pullRequestGroups: pullRequests.map((pullRequest) => {
      const sourceNodes = new Set(
        Array.from(projections).flatMap(([nodeId, projection]): ReadonlyArray<GraphNodeId> =>
          projection.entityId === pullRequest.entityId ? [nodeId] : []
        )
      )
      const linkedJiraKeys = Array.from(
        new Set(inspection.relationships.flatMap((relationship): ReadonlyArray<string> => {
          if (
            relationship.kind !== "implements" ||
            !sourceNodes.has(relationship.sourceNodeId) ||
            !currentRelationship(relationship)
          ) return []
          const issue = projections.get(relationship.targetNodeId)
          return issue?.details._tag === "issue" ? [issue.details.key] : []
        }))
      )
      const state = reviewStateLabel(pullRequest.details.reviewState)
      return {
        id: pullRequest.entityId,
        title: pullRequest.title,
        reference: pullRequest.displayKey,
        state,
        tone: statusTone(state),
        href: href(pullRequest),
        linkedJiraKeys
      }
    }),
    gaps: inspection.relationships.flatMap((relationship): ReadonlyArray<RlyWorksetGap> =>
      relationship.lifecycle._tag === "missing"
        ? [{
          id: relationship.relationshipId,
          label: gapLabel(relationship, projections),
          reason: relationship.lifecycle.reason,
          service: gapService(relationship)
        }]
        : []
    ),
    pipelines: pipelineExecutions.map((pipeline) => {
      const state = pipelineStateLabel(pipeline.details.status)
      return {
        id: pipeline.entityId,
        title: pipeline.title,
        reference: pipeline.displayKey,
        state,
        tone: statusTone(state),
        href: href(pipeline),
        stages
      }
    }),
    runbooks: pages.map((page) => ({
      href: href(page),
      id: page.entityId,
      reference: page.displayKey,
      state: page.details.status,
      title: page.title
    })),
    truncated: inspection.truncated
  }
}
