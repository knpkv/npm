import { Casing, Column, Query, Renderer } from "effect-qb"

import type { RenderedSql } from "./types.js"

/** Host-owned provider identity for one canonical entity. */
export interface EntitySourceIdentityQueryInput {
  readonly pluginConnectionId: string
  readonly providerId: string
  readonly vendorImmutableId: string
  readonly workspaceId: string
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Renderer.make().pipe(Casing.withCasing("snake_case"))

const entities = table("entities", {
  workspaceId: Column.text(),
  entityId: Column.text(),
  pluginConnectionId: Column.text(),
  providerId: Column.text(),
  vendorImmutableId: Column.text()
})

/** Render the exact workspace/connection/provider lookup for a canonical entity. */
export const renderEntitySourceIdentityQuery = (
  input: EntitySourceIdentityQueryInput
): RenderedSql => {
  const plan = Query.select({ entityId: entities.entityId }).pipe(
    Query.from(entities),
    Query.where(
      Query.and(
        Query.eq(entities.workspaceId, input.workspaceId),
        Query.eq(entities.pluginConnectionId, input.pluginConnectionId),
        Query.eq(entities.providerId, input.providerId),
        Query.eq(entities.vendorImmutableId, input.vendorImmutableId)
      )
    )
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}
