import { Casing, Column, Function as Fn, Query } from "effect-qb"
import * as Sqlite from "effect-qb/sqlite"

import type { RenderedSql } from "./types.js"

/** Stable job states that can be claimed by a durable worker. */
export type ClaimableAgentJobState = "cancel-requested" | "queued" | "running"

/** Workspace-scoped input for the bounded worker dispatch scan. */
export interface AgentJobDispatchCandidatesQueryInput {
  readonly limit: number
  readonly observedAt: string
  readonly taskTags: ReadonlyArray<"pr-review" | "release-chat">
  readonly workspaceId: string
}

/** Compare-and-set input for claiming one dispatch candidate. */
export interface AgentJobClaimQueryInput {
  readonly expectedAttemptSequence: number
  readonly expectedState: ClaimableAgentJobState
  readonly jobId: string
  readonly observedAt: string
  readonly workspaceId: string
}

/** Cursor input for bounded, ordered thread replay. */
export interface AgentThreadReplayQueryInput {
  readonly afterSequence: number
  readonly limit: number
  readonly threadId: string
  readonly workspaceId: string
}

const table = Casing.make({ tables: "snake_case", columns: "snake_case" }).table
const renderer = Sqlite.Renderer.make().pipe(Casing.withCasing("snake_case"))

const agentJobs = table("agentJobs", {
  workspaceId: Column.text(),
  jobId: Column.text(),
  threadId: Column.text(),
  providerId: Column.text(),
  model: Column.text().pipe(Column.nullable),
  access: Column.text(),
  prompt: Column.text(),
  contextFingerprint: Column.text(),
  subjectRevision: Column.text(),
  taskContextJson: Column.text(),
  taskContextDigest: Column.text(),
  state: Column.text(),
  createdAt: Column.text(),
  cancelRequestedAt: Column.text().pipe(Column.nullable),
  terminalAt: Column.text().pipe(Column.nullable)
})

const agentJobAttempts = table("agentJobAttempts", {
  workspaceId: Column.text(),
  jobId: Column.text(),
  attemptSequence: Column.int(),
  contextSnapshotJson: Column.text(),
  contextSnapshotDigest: Column.text(),
  outputBytes: Column.int(),
  providerRunRef: Column.text().pipe(Column.nullable),
  sessionRef: Column.text().pipe(Column.nullable),
  startedAt: Column.text(),
  completedAt: Column.text().pipe(Column.nullable),
  outcome: Column.text().pipe(Column.nullable),
  errorJson: Column.text().pipe(Column.nullable)
})

const agentJobLeases = table("agentJobLeases", {
  workspaceId: Column.text(),
  jobId: Column.text(),
  attemptSequence: Column.int(),
  leaseOwner: Column.text(),
  leaseToken: Column.text(),
  acquiredAt: Column.text(),
  lastRenewedAt: Column.text(),
  leaseExpiresAt: Column.text()
})

const agentThreadEvents = table("agentThreadEvents", {
  workspaceId: Column.text(),
  threadId: Column.text(),
  eventSequence: Column.int(),
  jobId: Column.text(),
  attemptSequence: Column.int().pipe(Column.nullable),
  eventKind: Column.text(),
  payloadJson: Column.text(),
  payloadDigest: Column.text(),
  payloadByteLength: Column.int(),
  occurredAt: Column.text()
})

const jobProjection = {
  workspaceId: agentJobs.workspaceId,
  jobId: agentJobs.jobId,
  threadId: agentJobs.threadId,
  providerId: agentJobs.providerId,
  model: agentJobs.model,
  access: agentJobs.access,
  prompt: agentJobs.prompt,
  contextFingerprint: agentJobs.contextFingerprint,
  subjectRevision: agentJobs.subjectRevision,
  taskContextJson: agentJobs.taskContextJson,
  taskContextDigest: agentJobs.taskContextDigest,
  state: agentJobs.state,
  createdAt: agentJobs.createdAt,
  cancelRequestedAt: agentJobs.cancelRequestedAt,
  terminalAt: agentJobs.terminalAt
}

const liveLeaseForJob = (observedAt: string) =>
  Query.select({ jobId: agentJobLeases.jobId }).pipe(
    Query.from(agentJobLeases),
    Query.where(
      Query.and(
        Query.eq(agentJobLeases.workspaceId, agentJobs.workspaceId),
        Query.eq(agentJobLeases.jobId, agentJobs.jobId),
        Query.gt(agentJobLeases.leaseExpiresAt, observedAt)
      )
    )
  )

const latestAttemptSequenceForJob = () =>
  Query.select({
    attemptSequence: Fn.coalesce(Fn.max(agentJobAttempts.attemptSequence), 0)
  }).pipe(
    Query.from(agentJobAttempts),
    Query.where(
      Query.and(
        Query.eq(agentJobAttempts.workspaceId, agentJobs.workspaceId),
        Query.eq(agentJobAttempts.jobId, agentJobs.jobId)
      )
    )
  )

/** Render the stable, bounded scan for queued jobs and crash-recoverable active jobs. */
export const renderAgentJobDispatchCandidatesQuery = (
  input: AgentJobDispatchCandidatesQueryInput
): RenderedSql => {
  const releaseChat = Query.like(agentJobs.taskContextJson, "{\"_tag\":\"release-chat\"%")
  const prReview = Query.like(agentJobs.taskContextJson, "{\"_tag\":\"pr-review\"%")
  const taskMatches = input.taskTags.includes("release-chat") &&
      input.taskTags.includes("pr-review")
    ? Query.or(releaseChat, prReview)
    : input.taskTags.includes("release-chat")
    ? releaseChat
    : prReview
  const plan = Query.select({
    ...jobProjection,
    attemptSequence: Query.scalar(latestAttemptSequenceForJob())
  }).pipe(
    Query.from(agentJobs),
    Query.where(
      Query.and(
        Query.eq(agentJobs.workspaceId, input.workspaceId),
        taskMatches,
        Query.or(
          Query.eq(agentJobs.state, "queued"),
          Query.and(
            Query.in(agentJobs.state, "running", "cancel-requested"),
            Query.not(Query.exists(liveLeaseForJob(input.observedAt)))
          )
        )
      )
    ),
    Query.orderBy(agentJobs.createdAt),
    Query.orderBy(agentJobs.jobId),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render an atomic job-state compare-and-set with the claimed job returned by SQLite. */
export const renderAgentJobClaimQuery = (input: AgentJobClaimQueryInput): RenderedSql => {
  const anyAttempt = Query.select({ jobId: agentJobAttempts.jobId }).pipe(
    Query.from(agentJobAttempts),
    Query.where(
      Query.and(
        Query.eq(agentJobAttempts.workspaceId, agentJobs.workspaceId),
        Query.eq(agentJobAttempts.jobId, agentJobs.jobId)
      )
    )
  )
  const expectedAttempt = Query.select({ jobId: agentJobAttempts.jobId }).pipe(
    Query.from(agentJobAttempts),
    Query.where(
      Query.and(
        Query.eq(agentJobAttempts.workspaceId, agentJobs.workspaceId),
        Query.eq(agentJobAttempts.jobId, agentJobs.jobId),
        Query.eq(agentJobAttempts.attemptSequence, input.expectedAttemptSequence)
      )
    )
  )
  const newerAttempt = Query.select({ jobId: agentJobAttempts.jobId }).pipe(
    Query.from(agentJobAttempts),
    Query.where(
      Query.and(
        Query.eq(agentJobAttempts.workspaceId, agentJobs.workspaceId),
        Query.eq(agentJobAttempts.jobId, agentJobs.jobId),
        Query.gt(agentJobAttempts.attemptSequence, input.expectedAttemptSequence)
      )
    )
  )
  const attemptGuard = input.expectedAttemptSequence === 0
    ? Query.not(Query.exists(anyAttempt))
    : Query.and(Query.exists(expectedAttempt), Query.not(Query.exists(newerAttempt)))
  const claimedState = input.expectedState === "cancel-requested" ? "cancel-requested" : "running"
  const plan = Query.update(agentJobs, { state: claimedState }).pipe(
    Query.where(
      Query.and(
        Query.eq(agentJobs.workspaceId, input.workspaceId),
        Query.eq(agentJobs.jobId, input.jobId),
        Query.eq(agentJobs.state, input.expectedState),
        attemptGuard,
        Query.not(Query.exists(liveLeaseForJob(input.observedAt)))
      )
    ),
    Query.returning(jobProjection)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}

/** Render one cursor-bounded page of immutable thread events in replay order. */
export const renderAgentThreadReplayQuery = (input: AgentThreadReplayQueryInput): RenderedSql => {
  const plan = Query.select({
    workspaceId: agentThreadEvents.workspaceId,
    threadId: agentThreadEvents.threadId,
    eventSequence: agentThreadEvents.eventSequence,
    jobId: agentThreadEvents.jobId,
    attemptSequence: agentThreadEvents.attemptSequence,
    eventKind: agentThreadEvents.eventKind,
    payloadJson: agentThreadEvents.payloadJson,
    payloadDigest: agentThreadEvents.payloadDigest,
    payloadByteLength: agentThreadEvents.payloadByteLength,
    taskContextJson: agentJobs.taskContextJson,
    taskContextDigest: agentJobs.taskContextDigest,
    occurredAt: agentThreadEvents.occurredAt
  }).pipe(
    Query.from(agentThreadEvents),
    Query.innerJoin(
      agentJobs,
      Query.and(
        Query.eq(agentJobs.workspaceId, agentThreadEvents.workspaceId),
        Query.eq(agentJobs.jobId, agentThreadEvents.jobId)
      )
    ),
    Query.where(
      Query.and(
        Query.eq(agentThreadEvents.workspaceId, input.workspaceId),
        Query.eq(agentThreadEvents.threadId, input.threadId),
        Query.gt(agentThreadEvents.eventSequence, input.afterSequence)
      )
    ),
    Query.orderBy(agentThreadEvents.eventSequence),
    Query.limit(input.limit)
  )
  const rendered = renderer.render(plan)
  return { params: rendered.params, sql: rendered.sql }
}
