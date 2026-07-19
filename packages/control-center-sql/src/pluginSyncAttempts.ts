import { Casing, Column, Query, Table } from "effect-qb"
import * as Sqlite from "effect-qb/sqlite"

import type { RenderedSql } from "./types.js"

/** Exact stream scope used to find crash-left sync attempts. */
export interface OpenPluginSyncAttemptsQueryInput {
  readonly pluginConnectionId: string
  readonly streamKey: string
  readonly workspaceId: string
}

/** Exact stream scope used to inspect its immutable attempt history. */
export type PluginSyncAttemptsQueryInput = OpenPluginSyncAttemptsQueryInput

/** Exact stream scope used to materialize bounded current synchronization state. */
export type PluginSyncAttemptStateQueryInput = OpenPluginSyncAttemptsQueryInput

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Sqlite.Renderer.make().pipe(Casing.withCasing("snake_case"))

const attempts = table("pluginSyncAttempts", {
  workspaceId: Column.text(),
  pluginConnectionId: Column.text(),
  providerId: Column.text(),
  streamKey: Column.text(),
  attemptSequence: Column.int(),
  startedRevision: Column.int(),
  startedAt: Column.text()
})

const completions = table("pluginSyncAttemptCompletions", {
  workspaceId: Column.text(),
  pluginConnectionId: Column.text(),
  streamKey: Column.text(),
  attemptSequence: Column.int(),
  outcome: Column.text(),
  endingRevision: Column.int(),
  pagesCommitted: Column.int(),
  completedAt: Column.text()
})

/** Render the stable effect-qb plan for every unclosed attempt in one stream. */
export const renderOpenPluginSyncAttemptsQuery = (
  input: OpenPluginSyncAttemptsQueryInput
): RenderedSql => {
  const completion = Query.select({ attemptSequence: completions.attemptSequence }).pipe(
    Query.from(completions),
    Query.where(
      Query.and(
        Query.eq(completions.workspaceId, attempts.workspaceId),
        Query.eq(completions.pluginConnectionId, attempts.pluginConnectionId),
        Query.eq(completions.streamKey, attempts.streamKey),
        Query.eq(completions.attemptSequence, attempts.attemptSequence)
      )
    )
  )
  const plan = Query.select({
    attemptSequence: attempts.attemptSequence,
    startedRevision: attempts.startedRevision
  }).pipe(
    Query.from(attempts),
    Query.where(
      Query.and(
        Query.eq(attempts.workspaceId, input.workspaceId),
        Query.eq(attempts.pluginConnectionId, input.pluginConnectionId),
        Query.eq(attempts.streamKey, input.streamKey),
        Query.not(Query.exists(completion))
      )
    ),
    Query.orderBy(attempts.attemptSequence)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render the stable effect-qb plan for one stream's append-only attempt history. */
export const renderPluginSyncAttemptsQuery = (input: PluginSyncAttemptsQueryInput): RenderedSql => {
  const plan = Query.select({
    workspaceId: attempts.workspaceId,
    pluginConnectionId: attempts.pluginConnectionId,
    providerId: attempts.providerId,
    streamKey: attempts.streamKey,
    attemptSequence: attempts.attemptSequence,
    startedRevision: attempts.startedRevision,
    startedAt: attempts.startedAt,
    outcome: completions.outcome,
    endingRevision: completions.endingRevision,
    pagesCommitted: completions.pagesCommitted,
    completedAt: completions.completedAt
  }).pipe(
    Query.from(attempts),
    Query.leftJoin(
      completions,
      Query.and(
        Query.eq(completions.workspaceId, attempts.workspaceId),
        Query.eq(completions.pluginConnectionId, attempts.pluginConnectionId),
        Query.eq(completions.streamKey, attempts.streamKey),
        Query.eq(completions.attemptSequence, attempts.attemptSequence)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(attempts.workspaceId, input.workspaceId),
        Query.eq(attempts.pluginConnectionId, input.pluginConnectionId),
        Query.eq(attempts.streamKey, input.streamKey)
      )
    ),
    Query.orderBy(attempts.attemptSequence)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render one bounded effect-qb plan for current state without scanning attempt history into memory. */
export const renderPluginSyncAttemptStateQuery = (
  input: PluginSyncAttemptStateQueryInput
): RenderedSql => {
  const latestAttempts = Table.alias(attempts, "latestAttempts")
  const latestSynchronizedAttempts = Table.alias(attempts, "latestSynchronizedAttempts")
  const synchronizedCompletions = Table.alias(completions, "synchronizedCompletions")
  const latestAttemptSequence = Query.select({
    attemptSequence: Query.max(latestAttempts.attemptSequence)
  }).pipe(
    Query.from(latestAttempts),
    Query.where(
      Query.and(
        Query.eq(latestAttempts.workspaceId, input.workspaceId),
        Query.eq(latestAttempts.pluginConnectionId, input.pluginConnectionId),
        Query.eq(latestAttempts.streamKey, input.streamKey)
      )
    )
  )
  const latestSynchronizedSequence = Query.select({
    attemptSequence: Query.max(latestSynchronizedAttempts.attemptSequence)
  }).pipe(
    Query.from(latestSynchronizedAttempts),
    Query.innerJoin(
      synchronizedCompletions,
      Query.and(
        Query.eq(synchronizedCompletions.workspaceId, latestSynchronizedAttempts.workspaceId),
        Query.eq(synchronizedCompletions.pluginConnectionId, latestSynchronizedAttempts.pluginConnectionId),
        Query.eq(synchronizedCompletions.streamKey, latestSynchronizedAttempts.streamKey),
        Query.eq(synchronizedCompletions.attemptSequence, latestSynchronizedAttempts.attemptSequence)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(latestSynchronizedAttempts.workspaceId, input.workspaceId),
        Query.eq(latestSynchronizedAttempts.pluginConnectionId, input.pluginConnectionId),
        Query.eq(latestSynchronizedAttempts.streamKey, input.streamKey),
        Query.eq(synchronizedCompletions.outcome, "synchronized")
      )
    )
  )
  const plan = Query.select({
    workspaceId: attempts.workspaceId,
    pluginConnectionId: attempts.pluginConnectionId,
    providerId: attempts.providerId,
    streamKey: attempts.streamKey,
    attemptSequence: attempts.attemptSequence,
    startedRevision: attempts.startedRevision,
    startedAt: attempts.startedAt,
    outcome: completions.outcome,
    endingRevision: completions.endingRevision,
    pagesCommitted: completions.pagesCommitted,
    completedAt: completions.completedAt
  }).pipe(
    Query.from(attempts),
    Query.leftJoin(
      completions,
      Query.and(
        Query.eq(completions.workspaceId, attempts.workspaceId),
        Query.eq(completions.pluginConnectionId, attempts.pluginConnectionId),
        Query.eq(completions.streamKey, attempts.streamKey),
        Query.eq(completions.attemptSequence, attempts.attemptSequence)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(attempts.workspaceId, input.workspaceId),
        Query.eq(attempts.pluginConnectionId, input.pluginConnectionId),
        Query.eq(attempts.streamKey, input.streamKey),
        Query.or(
          Query.eq(attempts.attemptSequence, Query.scalar(latestAttemptSequence)),
          Query.eq(attempts.attemptSequence, Query.scalar(latestSynchronizedSequence))
        )
      )
    ),
    Query.orderBy(attempts.attemptSequence, "desc")
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}
