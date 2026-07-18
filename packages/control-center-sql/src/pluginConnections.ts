import { Casing, Column, Function as Fn, Query, Renderer } from "effect-qb"

import type { RenderedSql } from "./types.js"

/** Values required to create one initially unbound executable connection. */
export interface CreatePluginConnectionQueryInput {
  readonly createdAt: string
  readonly displayName: string
  readonly isEnabled: boolean
  readonly pluginConnectionId: string
  readonly providerId: string
  readonly workspaceId: string
}

/** Workspace-scoped plugin-connection lookup. */
export interface PluginConnectionQueryInput {
  readonly pluginConnectionId: string
  readonly workspaceId: string
}

/** Values required for an optimistic plugin-connection metadata update. */
export interface UpdatePluginConnectionQueryInput extends PluginConnectionQueryInput {
  readonly displayName: string
  readonly expectedRevision: number
  readonly isEnabled: boolean
  readonly updatedAt: string
}

/** Values required to bind one executable connection to one followed resource. */
export interface BindPluginConnectionQueryInput extends PluginConnectionQueryInput {
  readonly expectedRevision: number
  readonly followedResourceId: string
  readonly providerAccountId: string
  readonly updatedAt: string
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Renderer.make().pipe(Casing.withCasing("snake_case"))

const pluginConnections = table("pluginConnections", {
  workspaceId: Column.text(),
  pluginConnectionId: Column.text(),
  providerAccountId: Column.text().pipe(Column.nullable),
  followedResourceId: Column.text().pipe(Column.nullable),
  providerId: Column.text(),
  displayName: Column.text(),
  revision: Column.int(),
  isEnabled: Column.int(),
  createdAt: Column.text(),
  updatedAt: Column.text()
})

const selection = {
  workspaceId: pluginConnections.workspaceId,
  pluginConnectionId: pluginConnections.pluginConnectionId,
  providerAccountId: pluginConnections.providerAccountId,
  followedResourceId: pluginConnections.followedResourceId,
  providerId: pluginConnections.providerId,
  displayName: pluginConnections.displayName,
  isEnabled: pluginConnections.isEnabled,
  revision: pluginConnections.revision,
  createdAt: pluginConnections.createdAt,
  updatedAt: pluginConnections.updatedAt
}

/** Render one workspace-scoped plugin-connection lookup. */
export const renderPluginConnectionQuery = (input: PluginConnectionQueryInput): RenderedSql => {
  const output = renderer.render(
    Query.select(selection).pipe(
      Query.from(pluginConnections),
      Query.where(
        Query.and(
          Query.eq(pluginConnections.workspaceId, input.workspaceId),
          Query.eq(pluginConnections.pluginConnectionId, input.pluginConnectionId)
        )
      )
    )
  )
  return { params: output.params, sql: output.sql }
}

/** Render stable workspace plugin-connection listing. */
export const renderPluginConnectionsQuery = (workspaceId: string): RenderedSql => {
  const output = renderer.render(
    Query.select(selection).pipe(
      Query.from(pluginConnections),
      Query.where(Query.eq(pluginConnections.workspaceId, workspaceId)),
      Query.orderBy(pluginConnections.displayName),
      Query.orderBy(pluginConnections.pluginConnectionId)
    )
  )
  return { params: output.params, sql: output.sql }
}

/** Render the current workspace connection count for bounded insertion. */
export const renderPluginConnectionCountQuery = (workspaceId: string): RenderedSql => {
  const output = renderer.render(
    Query.select({ connectionCount: Fn.count(pluginConnections.pluginConnectionId) }).pipe(
      Query.from(pluginConnections),
      Query.where(Query.eq(pluginConnections.workspaceId, workspaceId))
    )
  )
  return { params: output.params, sql: output.sql }
}

/** Render insertion of one initially unbound connection. */
export const renderCreatePluginConnectionQuery = (input: CreatePluginConnectionQueryInput): RenderedSql => {
  const output = renderer.render(
    Query.insert(pluginConnections, {
      workspaceId: input.workspaceId,
      pluginConnectionId: input.pluginConnectionId,
      providerAccountId: null,
      followedResourceId: null,
      providerId: input.providerId,
      displayName: input.displayName,
      revision: 1,
      isEnabled: input.isEnabled ? 1 : 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    })
  )
  return { params: output.params, sql: output.sql }
}

/** Render an optimistic metadata update without changing resource ownership. */
export const renderUpdatePluginConnectionQuery = (input: UpdatePluginConnectionQueryInput): RenderedSql => {
  const output = renderer.render(
    Query.update(pluginConnections, {
      displayName: input.displayName,
      isEnabled: input.isEnabled ? 1 : 0,
      revision: input.expectedRevision + 1,
      updatedAt: input.updatedAt
    }).pipe(
      Query.where(
        Query.and(
          Query.eq(pluginConnections.workspaceId, input.workspaceId),
          Query.eq(pluginConnections.pluginConnectionId, input.pluginConnectionId),
          Query.eq(pluginConnections.revision, input.expectedRevision)
        )
      )
    )
  )
  return { params: output.params, sql: output.sql }
}

/** Render an optimistic one-resource binding transition. */
export const renderBindPluginConnectionQuery = (input: BindPluginConnectionQueryInput): RenderedSql => {
  const output = renderer.render(
    Query.update(pluginConnections, {
      providerAccountId: input.providerAccountId,
      followedResourceId: input.followedResourceId,
      revision: input.expectedRevision + 1,
      updatedAt: input.updatedAt
    }).pipe(
      Query.where(
        Query.and(
          Query.eq(pluginConnections.workspaceId, input.workspaceId),
          Query.eq(pluginConnections.pluginConnectionId, input.pluginConnectionId),
          Query.eq(pluginConnections.revision, input.expectedRevision)
        )
      )
    )
  )
  return { params: output.params, sql: output.sql }
}
