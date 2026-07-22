import type { RlyStage, RlyVerdictTone } from "@knpkv/rly/patterns"
import * as DateTime from "effect/DateTime"

import type { WorkspaceEntityInspection } from "../../api/deliveryGraph.js"
import type { DeliveryEntityDetails } from "../../domain/deliveryGraph.js"

type PipelineDetails = Extract<DeliveryEntityDetails, { readonly _tag: "pipeline-execution" }>
type PipelineStatus = PipelineDetails["status"]

export interface WorkspacePipelineTimestamp {
  readonly dateTime: string
  readonly label: string
}

export interface WorkspacePipelineActionPresentation {
  readonly actor: string | null
  readonly artifacts: ReadonlyArray<{
    readonly accessLabel: string
    readonly direction: "input" | "output"
    readonly name: string
  }>
  readonly duration: string
  readonly error: string | null
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly region: string | null
  readonly stageName: string
  readonly status: string
  readonly summary: string | null
  readonly tone: RlyVerdictTone
}

export interface WorkspacePipelineExecutionPresentation {
  readonly actionCountLabel: string
  readonly actions: ReadonlyArray<WorkspacePipelineActionPresentation>
  readonly actionsTruncated: boolean
  readonly approvers: ReadonlyArray<string>
  readonly duration: string
  readonly executionId: string
  readonly executionMode: string
  readonly operators: ReadonlyArray<string>
  readonly pagesRead: number
  readonly pipelineName: string
  readonly pipelineVersion: string
  readonly pullRequestCountLabel: string
  readonly releaseCountLabel: string
  readonly runbookCountLabel: string
  readonly sourceArtifacts: ReadonlyArray<{
    readonly accessLabel: string
    readonly createdAt: WorkspacePipelineTimestamp | null
    readonly name: string
    readonly revision: string
    readonly summary: string | null
  }>
  readonly stages: ReadonlyArray<RlyStage>
  readonly startedAt: WorkspacePipelineTimestamp | null
  readonly status: string
  readonly statusSummary: string | null
  readonly targetEnvironment: string
  readonly triggerDetail: string
  readonly triggerRevision: string
  readonly triggerType: string
  readonly updatedAt: WorkspacePipelineTimestamp | null
}

const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
})

const titleCase = (value: string): string =>
  value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .split(/[._\-\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`)
    .join(" ")

const timestampFor = (value: DateTime.DateTime | null | undefined): WorkspacePipelineTimestamp | null =>
  value === null || value === undefined
    ? null
    : {
      dateTime: DateTime.formatIso(value),
      label: timestampFormatter.format(DateTime.toDateUtc(value))
    }

const durationBetween = (
  startedAt: DateTime.DateTime | null | undefined,
  updatedAt: DateTime.DateTime | null | undefined,
  running = false
): string => {
  if (startedAt === null || startedAt === undefined || updatedAt === null || updatedAt === undefined) {
    return running ? "In progress" : "Not available"
  }
  const seconds = Math.max(
    0,
    Math.round((DateTime.toEpochMillis(updatedAt) - DateTime.toEpochMillis(startedAt)) / 1_000)
  )
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(remainder)}s`
}

const toneFor = (status: PipelineStatus): RlyVerdictTone => {
  switch (status) {
    case "succeeded":
      return "positive"
    case "failed":
      return "critical"
    case "running":
      return "progress"
    case "stopped":
      return "caution"
    case "queued":
      return "neutral"
  }
}

const stageFor = (stage: NonNullable<PipelineDetails["stages"]>[number]): RlyStage => ({
  id: stage.name,
  name: stage.name,
  reason: `${String(stage.actionCount)} action${stage.actionCount === 1 ? "" : "s"}${
    stage.actionsTruncated ? " · detail is partial" : ""
  }`,
  state: titleCase(stage.status),
  tone: toneFor(stage.status)
})

const identityLabel = (identity: string): string => {
  const leaf = identity.split("/").filter((part) => part.length > 0).at(-1) ?? identity
  return leaf.includes("@") ? leaf : titleCase(leaf) || identity
}

const currentlyRelatedEntityIds = (inspection: WorkspaceEntityInspection): ReadonlySet<string> => {
  const entityIdByNode = new Map(
    inspection.graph.nodes.flatMap(({ nodeId, resolution }): ReadonlyArray<readonly [string, string]> =>
      resolution._tag === "resolved" && resolution.target._tag === "entity"
        ? [[nodeId, resolution.target.entityId]]
        : []
    )
  )
  const subjectNodeIds = new Set(
    inspection.graph.nodes.flatMap(({ nodeId, resolution }) =>
      resolution._tag === "resolved" && resolution.target._tag === "entity" &&
        resolution.target.entityId === inspection.entity.projection.entityId
        ? [nodeId]
        : []
    )
  )
  return new Set(inspection.graph.relationships.flatMap((relationship) => {
    if (
      relationship.lifecycle._tag === "missing" ||
      relationship.lifecycle._tag === "rejected" ||
      relationship.lifecycle._tag === "superseded"
    ) return []
    if (subjectNodeIds.has(relationship.sourceNodeId)) {
      const entityId = entityIdByNode.get(relationship.targetNodeId)
      return entityId === undefined ? [] : [entityId]
    }
    if (subjectNodeIds.has(relationship.targetNodeId)) {
      const entityId = entityIdByNode.get(relationship.sourceNodeId)
      return entityId === undefined ? [] : [entityId]
    }
    return []
  }))
}

const targetEnvironment = (details: PipelineDetails): string => {
  const deploymentAction = details.actions?.find(({ category }) => category?.toLocaleLowerCase("en-US") === "deploy")
  return deploymentAction === undefined
    ? "Not linked"
    : `${deploymentAction.stageName} · ${deploymentAction.region ?? "region unknown"}`
}

/** Present one immutable CodePipeline execution as a compact operator flight recorder. */
export const presentWorkspacePipelineExecution = (
  details: PipelineDetails,
  inspection: WorkspaceEntityInspection
): WorkspacePipelineExecutionPresentation => {
  const related = currentlyRelatedEntityIds(inspection)
  const relatedCount = (kind: "page" | "pull-request"): number =>
    inspection.graph.relatedEntityProjections.filter(({ projection }) =>
      projection.entityState === "present" && projection.entityType === kind && related.has(projection.entityId)
    ).length
  const lowerBound = (count: number, truncated: boolean): string => `${String(count)}${truncated ? "+" : ""}`
  const actions = details.actions ?? []
  const actors = [...new Set(actions.flatMap(({ updatedBy }) => updatedBy === null ? [] : [identityLabel(updatedBy)]))]
  const approvers = [
    ...new Set(
      actions.flatMap(({ category, updatedBy }) =>
        category?.toLocaleLowerCase("en-US") === "approval" && updatedBy !== null ? [identityLabel(updatedBy)] : []
      )
    )
  ]
  return {
    actionCountLabel: lowerBound(details.actionCount ?? actions.length, details.actionsTruncated ?? false),
    actions: actions.map((action) => ({
      actor: action.updatedBy === null ? null : identityLabel(action.updatedBy),
      artifacts: action.artifacts.map((artifact) => ({
        accessLabel: "Proxy required",
        direction: artifact.direction,
        name: artifact.name
      })),
      duration: durationBetween(action.startedAt, action.updatedAt, action.status === "running"),
      error: action.errorMessage ?? action.errorCode,
      id: action.actionExecutionId,
      name: action.actionName,
      provider: [action.owner, action.provider, action.version].filter((value) => value !== null).join(" · ") ||
        "Provider unavailable",
      region: action.region,
      stageName: action.stageName,
      status: titleCase(action.status),
      summary: action.externalExecutionSummary,
      tone: toneFor(action.status)
    })),
    actionsTruncated: details.actionsTruncated ?? false,
    approvers,
    duration: durationBetween(details.startedAt, details.updatedAt, details.status === "running"),
    executionId: details.executionId,
    executionMode:
      [details.executionMode, details.executionType].filter((value) => value !== null && value !== undefined).join(
        " · "
      ) || "Not synchronized",
    operators: actors.filter((actor) => !approvers.includes(actor)),
    pagesRead: details.actionPagesRead ?? 0,
    pipelineName: details.pipelineName,
    pipelineVersion: details.pipelineVersion === null || details.pipelineVersion === undefined
      ? "Unknown"
      : `v${String(details.pipelineVersion)}`,
    pullRequestCountLabel: lowerBound(relatedCount("pull-request"), inspection.graph.truncated),
    releaseCountLabel: lowerBound(inspection.entity.releaseIds.length, inspection.entity.releaseMembershipsTruncated),
    runbookCountLabel: lowerBound(relatedCount("page"), inspection.graph.truncated),
    sourceArtifacts: (details.sourceArtifacts ?? []).map((artifact) => ({
      accessLabel: "Proxy required",
      createdAt: timestampFor(artifact.createdAt),
      name: artifact.name,
      revision: artifact.revisionId ?? "Revision unavailable",
      summary: artifact.revisionSummary
    })),
    stages: (details.stages ?? []).map(stageFor),
    startedAt: timestampFor(details.startedAt),
    status: titleCase(details.status),
    statusSummary: details.statusSummary ?? null,
    targetEnvironment: targetEnvironment(details),
    triggerDetail: details.triggerDetail === null || details.triggerDetail === undefined
      ? "Trigger identity unavailable"
      : identityLabel(details.triggerDetail),
    triggerRevision: details.triggerRevision,
    triggerType: details.triggerType === null || details.triggerType === undefined
      ? "Unknown trigger"
      : titleCase(details.triggerType),
    updatedAt: timestampFor(details.updatedAt)
  }
}
