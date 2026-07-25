import { Casing, Column, Query, Renderer } from "effect-qb"

import type { RenderedSql } from "./types.js"

/** Exact idempotency lookup for one governed action. */
export interface GovernedActionIdempotencyQueryInput {
  readonly idempotencyKey: string
  readonly pluginConnectionId: string
  readonly workspaceId: string
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Renderer.make().pipe(Casing.withCasing("snake_case"))

const governedActions = table("governedActions", {
  workspaceId: Column.text(),
  actionId: Column.text(),
  pluginConnectionId: Column.text(),
  idempotencyKey: Column.text()
})

/** Render the unique workspace/connection/idempotency lookup for a governed action. */
export const renderGovernedActionIdempotencyQuery = (
  input: GovernedActionIdempotencyQueryInput
): RenderedSql => {
  const plan = Query.select({ actionId: governedActions.actionId }).pipe(
    Query.from(governedActions),
    Query.where(
      Query.and(
        Query.eq(governedActions.workspaceId, input.workspaceId),
        Query.eq(governedActions.pluginConnectionId, input.pluginConnectionId),
        Query.eq(governedActions.idempotencyKey, input.idempotencyKey)
      )
    )
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}
