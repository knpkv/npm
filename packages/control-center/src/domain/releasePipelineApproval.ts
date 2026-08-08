import type { DeliveryEntityProjection, DeliveryNode, DeliveryRelationship } from "./deliveryGraph.js"
import type { EntityId } from "./identifiers.js"

interface ReleasePipelineApprovalInspection {
  readonly entityProjections: ReadonlyArray<{ readonly projection: DeliveryEntityProjection }>
  readonly nodes: ReadonlyArray<DeliveryNode>
  readonly relationships: ReadonlyArray<DeliveryRelationship>
  readonly truncated: boolean
}

export type ReleasePipelineApprovalGate = Readonly<{
  readonly entityId: EntityId
  readonly pipelineName: string
  readonly state: "missing" | "not-waiting" | "waiting"
}>

const currentRelationship = (
  lifecycle: DeliveryRelationship["lifecycle"]
): boolean => lifecycle._tag !== "missing" && lifecycle._tag !== "rejected" && lifecycle._tag !== "superseded"

const approvalName = (value: string): boolean =>
  /(?:^|[\s_-])(?:approval|approve)(?:$|[\s_-])/iu.test(value) || /release[\s_-]*gate/iu.test(value)

/** Prove that every pipeline delivering a release PR is stopped at its observed manual approval gate. */
export const releasePipelineApprovalReadiness = (inspection: ReleasePipelineApprovalInspection) => {
  const nodeById = new Map(inspection.nodes.map((node) => [node.nodeId, node]))
  const projectionByEntityId = new Map(
    inspection.entityProjections.map(({ projection }) => [projection.entityId, projection])
  )
  const affectedPipelineIds = new Set(
    inspection.relationships.flatMap((relationship): ReadonlyArray<EntityId> => {
      if (
        relationship.kind !== "delivered-by" ||
        relationship.sourceNodeKind !== "pull-request" ||
        relationship.targetNodeKind !== "pipeline-execution" ||
        !currentRelationship(relationship.lifecycle)
      ) return []
      const source = nodeById.get(relationship.sourceNodeId)
      const target = nodeById.get(relationship.targetNodeId)
      return source?.resolution._tag === "resolved" &&
          source.resolution.target._tag === "entity" &&
          target?.resolution._tag === "resolved" &&
          target.resolution.target._tag === "entity"
        ? [target.resolution.target.entityId]
        : []
    })
  )
  let unverifiablePipelines = 0
  const gates: Array<ReleasePipelineApprovalGate> = []
  for (const entityId of affectedPipelineIds) {
    const projection = projectionByEntityId.get(entityId)
    const details = projection?.details
    if (
      projection?.entityState !== "present" ||
      projection.entityType !== "pipeline-execution" ||
      details?._tag !== "pipeline-execution"
    ) {
      unverifiablePipelines += 1
      continue
    }
    const approvalActionStages = new Set(
      (details.actions ?? []).flatMap((action) =>
        action.category?.toLocaleLowerCase("en-US") === "approval" ||
          action.provider?.toLocaleLowerCase("en-US") === "manual"
          ? [action.stageName]
          : []
      )
    )
    const approvalStages = (details.stages ?? []).filter((stage) =>
      approvalActionStages.has(stage.name) || approvalName(stage.name)
    )
    const waiting = approvalStages.some((stage) => {
      if (stage.status !== "running") return false
      const explicitActions = (details.actions ?? []).filter((action) =>
        action.stageName === stage.name &&
        (
          action.category?.toLocaleLowerCase("en-US") === "approval" ||
          action.provider?.toLocaleLowerCase("en-US") === "manual"
        )
      )
      return explicitActions.length === 0 || explicitActions.some(({ status }) => status === "running")
    })
    gates.push({
      entityId,
      pipelineName: details.pipelineName,
      state: approvalStages.length === 0 ? "missing" : waiting ? "waiting" : "not-waiting"
    })
  }
  return {
    affected: affectedPipelineIds.size,
    gates,
    missing: gates.filter(({ state }) => state === "missing").length,
    notWaiting: gates.filter(({ state }) => state === "not-waiting").length,
    ready: !inspection.truncated && unverifiablePipelines === 0 && gates.every(({ state }) => state === "waiting"),
    unverifiablePipelines,
    waiting: gates.filter(({ state }) => state === "waiting").length
  }
}
