import * as DateTime from "effect/DateTime"

import type { WorkspaceEntityInspection } from "../../api/deliveryGraph.js"
import type { DeliveryEntityDetails, DeliveryRelationship } from "../../domain/deliveryGraph.js"
import type { EntityId, WorkspaceId } from "../../domain/identifiers.js"
import { workspaceEntityPath } from "../workspaceEntityPaths.js"

type TimeEntryDetails = Extract<DeliveryEntityDetails, { readonly _tag: "time-entry" }>

export interface WorkspaceClockifyJiraAssociation {
  readonly evidenceLabel: string
  readonly href: string
  readonly key: string
  readonly state: "inferred" | "linked"
  readonly title: string
}

export interface WorkspaceClockifyTimeEntryPresentation {
  readonly approvalLabel: string
  readonly approvers: ReadonlyArray<string>
  readonly associationDetail: string
  readonly associationLabel: string
  readonly billableLabel: string
  readonly contributorLabel: string
  readonly description: string
  readonly durationLabel: string
  readonly endedAt: string
  readonly jiraAssociations: ReadonlyArray<WorkspaceClockifyJiraAssociation>
  readonly projectLabel: string
  readonly rollupLabel: string
  readonly startedAt: string
  readonly timerLabel: string
  readonly totalMinutes: number
}

const timestampFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
})

const titleCase = (value: string): string =>
  value
    .split(/[_\-\s]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1).toLocaleLowerCase("en-US")}`)
    .join(" ")

const durationLabel = (minutes: number): string => {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) return `${String(remainder)}m`
  return remainder === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(remainder)}m`
}

const timestampLabel = (value: DateTime.DateTime | null | undefined): string =>
  value === null || value === undefined ? "Not synchronized" : timestampFormatter.format(DateTime.toDateUtc(value))

const acceptedRelationship = (relationship: DeliveryRelationship): boolean =>
  relationship.lifecycle._tag !== "missing" &&
  relationship.lifecycle._tag !== "rejected" &&
  relationship.lifecycle._tag !== "superseded"

const jiraAssociationsFor = (
  workspaceId: WorkspaceId,
  inspection: WorkspaceEntityInspection
): ReadonlyArray<WorkspaceClockifyJiraAssociation> => {
  const subjectNodeIds = new Set(
    inspection.graph.nodes.flatMap(({ nodeId, resolution }) =>
      resolution._tag === "resolved" &&
        resolution.target._tag === "entity" &&
        resolution.target.entityId === inspection.entity.projection.entityId
        ? [nodeId]
        : []
    )
  )
  const issueIdByNode = new Map<string, EntityId>()
  for (const { nodeId, resolution } of inspection.graph.nodes) {
    if (
      resolution._tag === "resolved" &&
      resolution.target._tag === "entity" &&
      resolution.target.entityKind === "issue"
    ) issueIdByNode.set(nodeId, resolution.target.entityId)
  }
  const issues = new Map<EntityId, WorkspaceEntityInspection["entity"]["projection"]>()
  for (const { projection } of inspection.graph.relatedEntityProjections) {
    if (projection.entityState === "present" && projection.entityType === "issue") {
      issues.set(projection.entityId, projection)
    }
  }

  return inspection.graph.relationships.flatMap((relationship) => {
    if (
      relationship.kind !== "tracks-time-for" ||
      !subjectNodeIds.has(relationship.sourceNodeId) ||
      !acceptedRelationship(relationship)
    ) return []
    const issueId = issueIdByNode.get(relationship.targetNodeId)
    const issue = issueId === undefined ? undefined : issues.get(issueId)
    if (issueId === undefined || issue === undefined) return []
    const inferred = relationship.lifecycle._tag === "inferred" || relationship.confidence._tag === "inferred"
    return [{
      evidenceLabel: `${String(relationship.evidenceClaimIds.length)} evidence claim${
        relationship.evidenceClaimIds.length === 1 ? "" : "s"
      }`,
      href: workspaceEntityPath(workspaceId, issueId),
      key: issue.displayKey,
      state: inferred ? "inferred" : "linked",
      title: issue.title
    }]
  })
}

/** Present one immutable Clockify entry as a deterministic, read-only time ledger. */
export const presentWorkspaceClockifyTimeEntry = (
  workspaceId: WorkspaceId,
  details: TimeEntryDetails,
  inspection: WorkspaceEntityInspection
): WorkspaceClockifyTimeEntryPresentation => {
  const jiraAssociations = jiraAssociationsFor(workspaceId, inspection)
  const inferredCount = jiraAssociations.filter(({ state }) => state === "inferred").length
  const approvers = inspection.entity.owners
    .filter(({ roles }) => roles.some((role) => role.includes("approver")))
    .map(({ displayName }) => displayName)
  const contributor = details.userId === undefined
    ? undefined
    : inspection.entity.owners.find(({ sourceIdentities }) =>
      sourceIdentities?.some(
        ({ providerId, vendorPersonId }) => providerId === "clockify" && vendorPersonId === details.userId
      ) ?? false
    )
  return {
    approvalLabel: titleCase(details.approvalState),
    approvers,
    associationDetail: jiraAssociations.length === 0
      ? "No current Jira relationship explains where this time belongs. The entry remains visible."
      : inferredCount === 0
      ? `${String(jiraAssociations.length)} current Jira link${jiraAssociations.length === 1 ? "" : "s"}`
      : `${String(inferredCount)} inferred Jira link${inferredCount === 1 ? "" : "s"} — verify before reporting`,
    associationLabel: jiraAssociations.length === 0 ? "Unattributed" : "Attributed",
    billableLabel: details.billable ? "Billable" : "Non-billable",
    contributorLabel: contributor?.displayName ?? details.userId ?? "Contributor not synchronized",
    description: inspection.entity.projection.title,
    durationLabel: durationLabel(details.durationMinutes),
    endedAt: timestampLabel(details.endedAt),
    jiraAssociations,
    projectLabel: details.projectId ?? "No Clockify project",
    rollupLabel: `1 visible entry · ${String(details.durationMinutes)} exact minute${
      details.durationMinutes === 1 ? "" : "s"
    }`,
    startedAt: timestampLabel(details.startedAt),
    timerLabel: details.startedAt === undefined || details.endedAt === undefined
      ? "Timer state not synchronized"
      : details.endedAt === null
      ? "Timer running"
      : "Completed",
    totalMinutes: details.durationMinutes
  }
}
