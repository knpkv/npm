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
  DeliveryRelationship
} from "../../domain/deliveryGraph.js"
import type { EntityId, GraphNodeId, ReleaseId, WorkspaceId } from "../../domain/identifiers.js"

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

export interface ReleaseWorksetPresentation {
  readonly gaps: ReadonlyArray<RlyWorksetGap>
  readonly jiraItems: ReadonlyArray<RlyWorksetJiraItem>
  readonly pipelines: ReadonlyArray<RlyWorksetPipeline>
  readonly pullRequestGroups: ReadonlyArray<RlyWorksetPullRequestGroup>
  readonly runbooks: ReadonlyArray<ReleaseWorksetRunbook>
  readonly truncated: boolean
}

const objectHref = (
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  entityId: EntityId
): string => `/w/${workspaceId}/releases/${releaseId}?object=${encodeURIComponent(entityId)}#release-work`

const statusTone = (status: string): RlyStateTone => {
  const normalized = status.toLocaleLowerCase("en-US")
  if (["blocked", "changes requested", "failed", "rejected", "stopped"].some((value) => normalized.includes(value))) {
    return "critical"
  }
  if (
    ["approved", "closed", "done", "merged", "passed", "ready", "resolved", "succeeded"].some((value) =>
      normalized.includes(value)
    )
  ) return "positive"
  if (
    ["in progress", "in review", "queued", "requested", "running", "verifying"].some((value) =>
      normalized.includes(value)
    )
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
  const href = (projection: DeliveryEntityProjection): string =>
    objectHref(workspaceId, inspection.releaseId, projection.entityId)
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
      const sourceNode = Array.from(projections).find(([, projection]) => projection.entityId === pullRequest.entityId)
        ?.[0]
      const linkedJiraKeys = sourceNode === undefined
        ? []
        : inspection.relationships.flatMap((relationship): ReadonlyArray<string> => {
          if (
            relationship.kind !== "implements" ||
            relationship.sourceNodeId !== sourceNode ||
            !currentRelationship(relationship)
          ) return []
          const issue = projections.get(relationship.targetNodeId)
          return issue?.details._tag === "issue" ? [issue.details.key] : []
        })
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
