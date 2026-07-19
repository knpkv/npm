import { Casing, Column, Query, Renderer } from "effect-qb"

import type { RenderedSql } from "./types.js"

/** Exact workspace entity identity used by canonical delivery-graph reads. */
export interface WorkspaceEntityQueryInput {
  readonly entityId: string
  readonly workspaceId: string
}

/** Bounded current relationships touching one exact workspace entity. */
export interface WorkspaceEntityRelationshipsQueryInput extends WorkspaceEntityQueryInput {
  readonly limit: number
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Renderer.make().pipe(Casing.withCasing("snake_case"))

const deliveryNodes = table("deliveryNodes", {
  workspaceId: Column.text(),
  nodeId: Column.text(),
  resolutionState: Column.text(),
  entityId: Column.text().pipe(Column.nullable)
})

const relationshipRevisions = table("relationshipRevisions", {
  workspaceId: Column.text(),
  relationshipId: Column.text(),
  revision: Column.int(),
  sourceNodeId: Column.text(),
  targetNodeId: Column.text(),
  lifecycle: Column.text(),
  releaseId: Column.text().pipe(Column.nullable),
  recordedAt: Column.text()
})

const relationshipHeads = table("relationshipHeads", {
  workspaceId: Column.text(),
  relationshipId: Column.text(),
  currentRevision: Column.int()
})

const roleAssignments = table("roleAssignments", {
  workspaceId: Column.text(),
  personId: Column.text().pipe(Column.nullable),
  role: Column.text(),
  scopeKind: Column.text(),
  entityId: Column.text().pipe(Column.nullable),
  actorKind: Column.text(),
  lifecycleKind: Column.text()
})

const persons = table("persons", {
  workspaceId: Column.text(),
  personId: Column.text(),
  displayName: Column.text(),
  avatarJson: Column.text(),
  isActive: Column.int()
})

const currentEntityNodeIds = (input: WorkspaceEntityQueryInput) =>
  Query.select({ nodeId: deliveryNodes.nodeId }).pipe(
    Query.from(deliveryNodes),
    Query.where(
      Query.and(
        Query.eq(deliveryNodes.workspaceId, input.workspaceId),
        Query.eq(deliveryNodes.entityId, input.entityId),
        Query.eq(deliveryNodes.resolutionState, "resolved")
      )
    )
  )

const currentRelationshipPredicate = (input: WorkspaceEntityQueryInput) =>
  Query.and(
    Query.eq(relationshipRevisions.workspaceId, input.workspaceId),
    Query.or(
      Query.inSubquery(relationshipRevisions.sourceNodeId, currentEntityNodeIds(input)),
      Query.inSubquery(relationshipRevisions.targetNodeId, currentEntityNodeIds(input))
    )
  )

const currentRelationshipPlan = (input: WorkspaceEntityQueryInput) =>
  Query.select({
    relationshipId: relationshipRevisions.relationshipId,
    releaseId: relationshipRevisions.releaseId,
    lifecycle: relationshipRevisions.lifecycle,
    recordedAt: relationshipRevisions.recordedAt
  }).pipe(
    Query.from(relationshipRevisions),
    Query.innerJoin(
      relationshipHeads,
      Query.and(
        Query.eq(relationshipHeads.workspaceId, relationshipRevisions.workspaceId),
        Query.eq(relationshipHeads.relationshipId, relationshipRevisions.relationshipId),
        Query.eq(relationshipHeads.currentRevision, relationshipRevisions.revision)
      )
    ),
    Query.where(currentRelationshipPredicate(input))
  )

/** Render active human collaborator roles for one exact entity. */
export const renderWorkspaceEntityOwnersQuery = (input: WorkspaceEntityQueryInput): RenderedSql => {
  const plan = Query.select({
    avatarJson: persons.avatarJson,
    displayName: persons.displayName,
    personId: persons.personId,
    role: roleAssignments.role
  }).pipe(
    Query.from(roleAssignments),
    Query.innerJoin(
      persons,
      Query.and(
        Query.eq(persons.workspaceId, roleAssignments.workspaceId),
        Query.eq(persons.personId, roleAssignments.personId)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(roleAssignments.workspaceId, input.workspaceId),
        Query.eq(roleAssignments.entityId, input.entityId),
        Query.eq(roleAssignments.scopeKind, "entity"),
        Query.eq(roleAssignments.actorKind, "human"),
        Query.eq(roleAssignments.lifecycleKind, "active"),
        Query.eq(persons.isActive, 1),
        Query.in(
          roleAssignments.role,
          "change-owner",
          "issue-owner",
          "issue-assignee",
          "page-owner",
          "author",
          "operator",
          "contributor",
          "reviewer",
          "watcher",
          "deployment-approver",
          "merge-approver"
        )
      )
    ),
    Query.orderBy(persons.displayName),
    Query.orderBy(persons.personId),
    Query.orderBy(roleAssignments.role),
    Query.limit(321)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render a deterministic bounded current relationship identity prefix for one entity. */
export const renderWorkspaceEntityRelationshipsQuery = (
  input: WorkspaceEntityRelationshipsQueryInput
): RenderedSql => {
  const plan = currentRelationshipPlan(input).pipe(
    Query.orderBy(relationshipRevisions.recordedAt, "desc"),
    Query.orderBy(relationshipRevisions.relationshipId),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render every bounded active release membership currently touching one entity. */
export const renderWorkspaceEntityReleasesQuery = (input: WorkspaceEntityQueryInput): RenderedSql => {
  const plan = Query.select({ releaseId: relationshipRevisions.releaseId }).pipe(
    Query.from(relationshipRevisions),
    Query.innerJoin(
      relationshipHeads,
      Query.and(
        Query.eq(relationshipHeads.workspaceId, relationshipRevisions.workspaceId),
        Query.eq(relationshipHeads.relationshipId, relationshipRevisions.relationshipId),
        Query.eq(relationshipHeads.currentRevision, relationshipRevisions.revision)
      )
    ),
    Query.where(
      Query.and(
        currentRelationshipPredicate(input),
        Query.isNotNull(relationshipRevisions.releaseId),
        Query.notIn(relationshipRevisions.lifecycle, "rejected", "superseded")
      )
    ),
    Query.distinct(),
    Query.orderBy(relationshipRevisions.releaseId),
    Query.limit(501)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}
