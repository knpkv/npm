import { Casing, Column, Query } from "effect-qb"
import * as Sqlite from "effect-qb/sqlite"

import type { RenderedSql } from "./types.js"

/** Bounded process-start recovery scan input. */
export interface GovernedActionRecoveryQueryInput {
  readonly limit: number
  readonly observedAt: string
  readonly workspaceId: string
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Sqlite.Renderer.make().pipe(Casing.withCasing("snake_case"))

const governedActions = table("governedActions", {
  workspaceId: Column.text(),
  actionId: Column.text(),
  state: Column.text()
})

const executionLeases = table("governedActionExecutionLeases", {
  workspaceId: Column.text(),
  actionId: Column.text(),
  recoveryEligibleAt: Column.text()
})

const recoveryClaims = table("governedActionRecoveryClaims", {
  workspaceId: Column.text(),
  actionId: Column.text(),
  leaseExpiresAt: Column.text()
})

/** Render a stable, bounded scan for recoverable actions without a live recovery claim. */
export const renderGovernedActionRecoveryQuery = (
  input: GovernedActionRecoveryQueryInput
): RenderedSql => {
  const liveClaim = Query.select({ actionId: recoveryClaims.actionId }).pipe(
    Query.from(recoveryClaims),
    Query.where(
      Query.and(
        Query.eq(recoveryClaims.workspaceId, governedActions.workspaceId),
        Query.eq(recoveryClaims.actionId, governedActions.actionId),
        Query.gt(recoveryClaims.leaseExpiresAt, input.observedAt)
      )
    )
  )
  const plan = Query.select({
    workspaceId: governedActions.workspaceId,
    actionId: governedActions.actionId
  }).pipe(
    Query.from(governedActions),
    Query.innerJoin(
      executionLeases,
      Query.and(
        Query.eq(executionLeases.workspaceId, governedActions.workspaceId),
        Query.eq(executionLeases.actionId, governedActions.actionId)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(governedActions.workspaceId, input.workspaceId),
        Query.in(
          governedActions.state,
          "started",
          "cancel-requested",
          "unknown",
          "cancel-requested-unknown"
        ),
        Query.lte(executionLeases.recoveryEligibleAt, input.observedAt),
        Query.not(Query.exists(liveClaim))
      )
    ),
    Query.orderBy(executionLeases.recoveryEligibleAt),
    Query.orderBy(governedActions.workspaceId),
    Query.orderBy(governedActions.actionId),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}
