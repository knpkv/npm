import { Casing, Column, Function as SqlFunction, Query } from "effect-qb"
import * as Sqlite from "effect-qb/sqlite"

import type { RenderedSql } from "./types.js"

/** Stable cursor for the newest-first merged Timeline. */
export interface TimelineQueryCursor {
  readonly eventKey: string
  readonly occurredAt: string
}

/** Bounded filters for one merged Timeline page. */
export interface TimelineQueryInput {
  readonly actorKind: "agent" | "human" | "plugin" | "system" | null
  readonly before: TimelineQueryCursor | null
  readonly from: string | null
  readonly limit: number
  readonly to: string | null
  readonly workspaceId: string
}

/** Durable source contributing rows to the merged Timeline. */
export type TimelineSourceKind = "action" | "plugin-sync" | "relationship" | "system"

/** One independently bounded SQL plan contributing to the merged Timeline. */
export interface RenderedTimelineQuery extends RenderedSql {
  readonly sourceKind: TimelineSourceKind
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Sqlite.Renderer.make().pipe(Casing.withCasing("snake_case"))
const nullText = Query.cast(null, Query.type.text())

const auditEvents = table("auditEvents", {
  workspaceId: Column.text(),
  actionId: Column.text(),
  auditEventId: Column.text(),
  eventKind: Column.text(),
  causeKind: Column.text(),
  actorId: Column.text().pipe(Column.nullable),
  jobId: Column.text().pipe(Column.nullable),
  systemComponent: Column.text().pipe(Column.nullable),
  occurredAt: Column.text()
})

const governedActions = table("governedActions", {
  workspaceId: Column.text(),
  actionId: Column.text(),
  pluginConnectionId: Column.text(),
  targetEntityId: Column.text()
})

const persons = table("persons", {
  workspaceId: Column.text(),
  personId: Column.text(),
  displayName: Column.text()
})

const pluginSyncPages = table("pluginSyncPages", {
  workspaceId: Column.text(),
  pluginConnectionId: Column.text(),
  streamKey: Column.text(),
  pageId: Column.text(),
  timelineEventDigest: Column.text(),
  committedAt: Column.text()
})

const pluginConnections = table("pluginConnections", {
  workspaceId: Column.text(),
  pluginConnectionId: Column.text(),
  providerId: Column.text(),
  displayName: Column.text()
})

const relationshipRevisions = table("relationshipRevisions", {
  workspaceId: Column.text(),
  relationshipId: Column.text(),
  revision: Column.int(),
  lifecycle: Column.text(),
  releaseId: Column.text().pipe(Column.nullable),
  provenancePluginConnectionId: Column.text().pipe(Column.nullable),
  recordedByKind: Column.text(),
  recordedByPersonId: Column.text().pipe(Column.nullable),
  recordedByAgentId: Column.text().pipe(Column.nullable),
  recordedByComponent: Column.text().pipe(Column.nullable),
  recordedAt: Column.text(),
  revisionDigest: Column.text()
})

const domainEvents = table("domainEvents", {
  workspaceId: Column.text(),
  eventId: Column.text(),
  eventType: Column.text(),
  releaseId: Column.text().pipe(Column.nullable),
  pluginConnectionId: Column.text().pipe(Column.nullable),
  entityId: Column.text().pipe(Column.nullable),
  jobId: Column.text().pipe(Column.nullable),
  occurredAt: Column.text()
})

const auditQuery = (input: TimelineQueryInput): RenderedTimelineQuery => {
  const eventKey = SqlFunction.concat("audit:", auditEvents.auditEventId)
  const actorPredicate = input.actorKind === null
    ? Query.eq(1, 1)
    : Query.eq(auditEvents.causeKind, input.actorKind)
  const fromPredicate = input.from === null ? Query.eq(1, 1) : Query.gte(auditEvents.occurredAt, input.from)
  const toPredicate = input.to === null ? Query.eq(1, 1) : Query.lte(auditEvents.occurredAt, input.to)
  const cursorPredicate = input.before === null
    ? Query.eq(1, 1)
    : Query.or(
      Query.lt(auditEvents.occurredAt, input.before.occurredAt),
      Query.and(
        Query.eq(auditEvents.occurredAt, input.before.occurredAt),
        Query.lt(eventKey, input.before.eventKey)
      )
    )
  const plan = Query.select({
    eventKey,
    occurredAt: auditEvents.occurredAt,
    actorKind: auditEvents.causeKind,
    actorId: auditEvents.actorId,
    actorLabel: SqlFunction.coalesce(persons.displayName, auditEvents.systemComponent),
    eventType: auditEvents.eventKind,
    sourceKind: Query.literal("action"),
    service: nullText,
    releaseId: nullText,
    entityId: governedActions.targetEntityId,
    actionId: auditEvents.actionId,
    relationshipId: nullText,
    pluginConnectionId: governedActions.pluginConnectionId,
    agentJobId: auditEvents.jobId
  }).pipe(
    Query.from(auditEvents),
    Query.innerJoin(
      governedActions,
      Query.and(
        Query.eq(governedActions.workspaceId, auditEvents.workspaceId),
        Query.eq(governedActions.actionId, auditEvents.actionId)
      )
    ),
    Query.leftJoin(
      persons,
      Query.and(
        Query.eq(persons.workspaceId, auditEvents.workspaceId),
        Query.eq(persons.personId, auditEvents.actorId)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(auditEvents.workspaceId, input.workspaceId),
        actorPredicate,
        fromPredicate,
        toPredicate,
        cursorPredicate
      )
    ),
    Query.orderBy(auditEvents.occurredAt, "desc"),
    Query.orderBy(auditEvents.auditEventId, "desc"),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sourceKind: "action", sql: rendered.sql }
}

const syncQuery = (input: TimelineQueryInput): RenderedTimelineQuery => {
  const eventKey = SqlFunction.concat("sync:", pluginSyncPages.timelineEventDigest)
  const fromPredicate = input.from === null
    ? Query.eq(1, 1)
    : Query.gte(pluginSyncPages.committedAt, input.from)
  const toPredicate = input.to === null ? Query.eq(1, 1) : Query.lte(pluginSyncPages.committedAt, input.to)
  const cursorPredicate = input.before === null
    ? Query.eq(1, 1)
    : Query.or(
      Query.lt(pluginSyncPages.committedAt, input.before.occurredAt),
      Query.and(
        Query.eq(pluginSyncPages.committedAt, input.before.occurredAt),
        Query.lt(eventKey, input.before.eventKey)
      )
    )
  const plan = Query.select({
    eventKey,
    occurredAt: pluginSyncPages.committedAt,
    actorKind: Query.literal("plugin"),
    actorId: pluginSyncPages.pluginConnectionId,
    actorLabel: pluginConnections.displayName,
    eventType: Query.literal("synchronized"),
    sourceKind: Query.literal("plugin-sync"),
    service: pluginConnections.providerId,
    releaseId: nullText,
    entityId: nullText,
    actionId: nullText,
    relationshipId: nullText,
    pluginConnectionId: pluginSyncPages.pluginConnectionId,
    agentJobId: nullText
  }).pipe(
    Query.from(pluginSyncPages),
    Query.innerJoin(
      pluginConnections,
      Query.and(
        Query.eq(pluginConnections.workspaceId, pluginSyncPages.workspaceId),
        Query.eq(pluginConnections.pluginConnectionId, pluginSyncPages.pluginConnectionId)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(pluginSyncPages.workspaceId, input.workspaceId),
        fromPredicate,
        toPredicate,
        cursorPredicate
      )
    ),
    Query.orderBy(pluginSyncPages.committedAt, "desc"),
    Query.orderBy(pluginSyncPages.timelineEventDigest, "desc"),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sourceKind: "plugin-sync", sql: rendered.sql }
}

const relationshipQuery = (input: TimelineQueryInput): RenderedTimelineQuery => {
  const eventKey = SqlFunction.concat("relationship:", relationshipRevisions.revisionDigest)
  const actorPredicate = input.actorKind === null
    ? Query.eq(1, 1)
    : Query.eq(relationshipRevisions.recordedByKind, input.actorKind)
  const fromPredicate = input.from === null
    ? Query.eq(1, 1)
    : Query.gte(relationshipRevisions.recordedAt, input.from)
  const toPredicate = input.to === null
    ? Query.eq(1, 1)
    : Query.lte(relationshipRevisions.recordedAt, input.to)
  const cursorPredicate = input.before === null
    ? Query.eq(1, 1)
    : Query.or(
      Query.lt(relationshipRevisions.recordedAt, input.before.occurredAt),
      Query.and(
        Query.eq(relationshipRevisions.recordedAt, input.before.occurredAt),
        Query.lt(eventKey, input.before.eventKey)
      )
    )
  const plan = Query.select({
    eventKey,
    occurredAt: relationshipRevisions.recordedAt,
    actorKind: relationshipRevisions.recordedByKind,
    actorId: SqlFunction.coalesce(
      relationshipRevisions.recordedByPersonId,
      relationshipRevisions.recordedByAgentId,
      relationshipRevisions.recordedByComponent
    ),
    actorLabel: SqlFunction.coalesce(persons.displayName, relationshipRevisions.recordedByComponent),
    eventType: relationshipRevisions.lifecycle,
    sourceKind: Query.literal("relationship"),
    service: nullText,
    releaseId: relationshipRevisions.releaseId,
    entityId: nullText,
    actionId: nullText,
    relationshipId: relationshipRevisions.relationshipId,
    pluginConnectionId: relationshipRevisions.provenancePluginConnectionId,
    agentJobId: nullText
  }).pipe(
    Query.from(relationshipRevisions),
    Query.leftJoin(
      persons,
      Query.and(
        Query.eq(persons.workspaceId, relationshipRevisions.workspaceId),
        Query.eq(persons.personId, relationshipRevisions.recordedByPersonId)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(relationshipRevisions.workspaceId, input.workspaceId),
        actorPredicate,
        fromPredicate,
        toPredicate,
        cursorPredicate
      )
    ),
    Query.orderBy(relationshipRevisions.recordedAt, "desc"),
    Query.orderBy(relationshipRevisions.revisionDigest, "desc"),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sourceKind: "relationship", sql: rendered.sql }
}

const systemQuery = (input: TimelineQueryInput): RenderedTimelineQuery => {
  const eventKey = SqlFunction.concat("domain:", domainEvents.eventId)
  const fromPredicate = input.from === null ? Query.eq(1, 1) : Query.gte(domainEvents.occurredAt, input.from)
  const toPredicate = input.to === null ? Query.eq(1, 1) : Query.lte(domainEvents.occurredAt, input.to)
  const cursorPredicate = input.before === null
    ? Query.eq(1, 1)
    : Query.or(
      Query.lt(domainEvents.occurredAt, input.before.occurredAt),
      Query.and(
        Query.eq(domainEvents.occurredAt, input.before.occurredAt),
        Query.lt(eventKey, input.before.eventKey)
      )
    )
  const plan = Query.select({
    eventKey,
    occurredAt: domainEvents.occurredAt,
    actorKind: Query.literal("system"),
    actorId: nullText,
    actorLabel: Query.literal("Control Center"),
    eventType: domainEvents.eventType,
    sourceKind: Query.literal("system"),
    service: nullText,
    releaseId: domainEvents.releaseId,
    entityId: domainEvents.entityId,
    actionId: nullText,
    relationshipId: nullText,
    pluginConnectionId: domainEvents.pluginConnectionId,
    agentJobId: domainEvents.jobId
  }).pipe(
    Query.from(domainEvents),
    Query.where(
      Query.and(
        Query.eq(domainEvents.workspaceId, input.workspaceId),
        fromPredicate,
        toPredicate,
        cursorPredicate
      )
    ),
    Query.orderBy(domainEvents.occurredAt, "desc"),
    Query.orderBy(domainEvents.eventId, "desc"),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sourceKind: "system", sql: rendered.sql }
}

/** Render independently bounded source plans for one stable merged Timeline page. */
export const renderTimelineQueries = (input: TimelineQueryInput): ReadonlyArray<RenderedTimelineQuery> => {
  const queries: Array<RenderedTimelineQuery> = [auditQuery(input), relationshipQuery(input)]
  if (input.actorKind === null || input.actorKind === "plugin") {
    queries.push(syncQuery(input))
  }
  if (input.actorKind === null || input.actorKind === "system") {
    queries.push(systemQuery(input))
  }
  return queries
}
