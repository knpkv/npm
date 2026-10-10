/**
 * What Relay may read in the Herdr hub: the fleet's agents, the jobs waiting for approval, one job, and the
 * work board. Nothing here changes anything.
 *
 * **Mental model**
 *
 * - **Read-only, by construction.** Every capability is `access: "read"`. There is no capability that
 *   approves, declines, prompts an agent or submits a job, so Relay can only point the person at the
 *   Approvals tab, where those decisions are made.
 * - **Small answers.** Each answer holds at most a fixed number of items, every free-text field is cut to
 *   {@link FIELD_MAX} characters (identities, such as host names and ids, are kept whole), and the whole answer
 *   is trimmed to {@link ANSWER_MAX_BYTES} encoded
 *   bytes. `total` counts what there was, so the model can say how many it left out.
 * - **The hub's own reading.** The capabilities read through {@link HubRelayReads}, which the HTTP server
 *   fills from what it already serves the dashboard: the Connect directory, the sanitized pending jobs, the
 *   fleet's job store and the Work service's `now` snapshot. A job's terminal output never reaches Relay.
 *
 * @module
 */
import { defineContract, implement } from "@knpkv/capability"
import type { FleetConnectAgents } from "@knpkv/herdr-connect"
import type { WorkSnapshot } from "@knpkv/herdr-work"
import { Effect, Schema } from "effect"
import type { SanitizedJobRecord } from "../approval-request.js"

/** The longest free-text field an answer carries; longer text is cut with an ellipsis. */
export const FIELD_MAX = 160

/** The largest encoded answer; items are dropped from the end until it fits. */
export const ANSWER_MAX_BYTES = 24 * 1024

/** The hub could not read what Relay asked for. */
export class HubReadFailed extends Schema.TaggedError<HubReadFailed>()("HubReadFailed", {
  message: Schema.String,
  fix: Schema.String
}) {}

/** No job with that id on that host, among the jobs Relay may read. */
export class JobNotFound extends Schema.TaggedError<JobNotFound>()("JobNotFound", {
  message: Schema.String,
  fix: Schema.String
}) {}

/** One job waiting for approval, as the dashboard lists it (sanitized; no output). */
export interface PendingJob {
  readonly host: string
  readonly jobId: string
  readonly kind: string
  readonly actor: string
  readonly createdAt: number
  readonly expiresAt: number | null
}

/** Pending jobs across the fleet, with the hosts that did not answer. */
export interface PendingJobs {
  readonly jobs: ReadonlyArray<PendingJob>
  /** Whether more pending jobs exist than were read. */
  readonly more: boolean
  readonly unreachable: ReadonlyArray<string>
}

/** The hub's reads, as the dashboard already makes them. */
export interface HubRelayReads {
  readonly host: string
  readonly agents: Effect.Effect<FleetConnectAgents, HubReadFailed>
  readonly pendingJobs: Effect.Effect<PendingJobs, HubReadFailed>
  /** This hub's job by id, or null when it has none by that id. */
  readonly localJob: (jobId: string) => Effect.Effect<SanitizedJobRecord | null, HubReadFailed>
  readonly work: Effect.Effect<WorkSnapshot, HubReadFailed>
}

const clip = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim()
  return flat.length <= FIELD_MAX ? flat : `${flat.slice(0, FIELD_MAX - 1).trimEnd()}…`
}

const encodedBytes = <Answer>(value: Answer): number => new TextEncoder().encode(JSON.stringify(value)).length

/** Drops items from the end until the answer encodes within {@link ANSWER_MAX_BYTES}. */
const withinBytes = <Item, Answer>(
  items: ReadonlyArray<Item>,
  answer: (kept: ReadonlyArray<Item>) => Answer
): Answer => {
  let kept = items
  while (kept.length > 0 && encodedBytes(answer(kept)) > ANSWER_MAX_BYTES) kept = kept.slice(0, -1)
  return answer(kept)
}

const Text = Schema.String
const Host = Schema.String

/** The most unreachable hosts an answer names; the rest are counted in `unreachableOmitted`. */
const UNREACHABLE_MAX = 16

/**
 * Hosts that did not answer, capped in number, so a large fleet's failures can't crowd out the answer. A host
 * name is an identity Relay may pass back to `get_job`, so it is never cut.
 */
const unreachableOf = (hosts: ReadonlyArray<string>) => ({
  unreachableHosts: hosts.slice(0, UNREACHABLE_MAX),
  unreachableOmitted: Math.max(0, hosts.length - UNREACHABLE_MAX)
})

const AgentSummary = Schema.Struct({
  host: Host,
  name: Text,
  kind: Text,
  state: Text,
  work: Text,
  lastActivityAt: Schema.Number
})

/** The agents across the fleet, as Connect lists them. */
export const listAgents = defineContract({
  name: "list_agents",
  description: "The agents running across the fleet, as the Connect tab lists them: host, name, kind, state, " +
    "what each is working on, and when it last did something. At most 50, most recently active first; `total` " +
    "counts them all. `unreachableHosts` names up to 16 hosts that did not answer; `unreachableOmitted` counts the " +
    "rest.",
  access: "read",
  input: Schema.Struct({}),
  output: Schema.Struct({
    agents: Schema.Array(AgentSummary),
    total: Schema.Number,
    unreachableHosts: Schema.Array(Host),
    unreachableOmitted: Schema.Number
  }),
  failure: HubReadFailed,
  cites: () => []
})

const PendingSummary = Schema.Struct({
  host: Host,
  jobId: Text,
  kind: Text,
  requestedBy: Text,
  requestedAt: Schema.Number,
  expiresAt: Schema.NullOr(Schema.Number)
})

/** The jobs waiting for someone's approval. Relay cannot approve or decline them. */
export const listPendingApprovals = defineContract({
  name: "list_pending_approvals",
  description: "Jobs across the fleet waiting for approval: host, job id, kind, who asked and when, and when the " +
    "request expires. Read from each host's 64 most recent waiting jobs and listed oldest first, at most 25; `more` " +
    "says more are waiting than were read or listed. You cannot approve or decline them; the person does that in " +
    "the Approvals tab.",
  access: "read",
  input: Schema.Struct({}),
  output: Schema.Struct({
    approvals: Schema.Array(PendingSummary),
    more: Schema.Boolean,
    unreachableHosts: Schema.Array(Host),
    unreachableOmitted: Schema.Number
  }),
  failure: HubReadFailed,
  cites: () => []
})

const JobSummary = Schema.Struct({
  host: Host,
  jobId: Text,
  kind: Text,
  status: Text,
  requestedBy: Text,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  approvedBy: Schema.NullOr(Text),
  rejectedBy: Schema.NullOr(Text)
})

/** One job's state. Never its terminal output. */
export const getJob = defineContract({
  name: "get_job",
  description: "One job's kind, status, who asked for it, who approved or rejected it, and when. This hub's jobs, " +
    "and other hosts' jobs among the 64 most recent waiting for approval there. Never the job's output.",
  access: "read",
  input: Schema.Struct({ host: Host, jobId: Text }),
  output: JobSummary,
  failure: Schema.Union([HubReadFailed, JobNotFound]),
  cites: () => []
})

const GoalSummary = Schema.Struct({
  id: Text,
  title: Text,
  state: Text,
  owner: Text,
  repository: Text,
  branch: Text,
  delivery: Text,
  blocker: Schema.NullOr(Text)
})

/** The work board's goals, as the Work tab shows them now. */
export const getWorkBoard = defineContract({
  name: "get_work_board",
  description: "The goals on the Work board as it stands now: title, state, owner agent, repository and branch, " +
    "delivery stage, and what blocks it. At most 30, in the board's order; `total` counts them all.",
  access: "read",
  input: Schema.Struct({}),
  output: Schema.Struct({ goals: Schema.Array(GoalSummary), total: Schema.Number }),
  failure: HubReadFailed,
  cites: () => []
})

const summarizeJob = (host: string, record: SanitizedJobRecord): typeof JobSummary.Type => ({
  host,
  jobId: record.id,
  kind: record.payload.kind,
  status: record.status,
  requestedBy: clip(record.actor),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  approvedBy: record.approvedBy === null ? null : clip(record.approvedBy),
  rejectedBy: record.rejectedBy === undefined || record.rejectedBy === null ? null : clip(record.rejectedBy)
})

/** The hub's capabilities over its reads; register each with Relay. */
export const hubCapabilities = (reads: HubRelayReads) => ({
  listAgents: implement(listAgents, () =>
    Effect.map(reads.agents, ({ agents, failures }) => {
      const recent = [...agents].sort((left, right) => right.lastActivityAt - left.lastActivityAt).slice(0, 50)
      return withinBytes(
        recent.map((agent) => ({
          host: agent.host,
          name: clip(agent.name),
          kind: clip(agent.kind),
          state: clip(agent.state),
          work: clip(agent.work),
          lastActivityAt: agent.lastActivityAt
        })),
        (kept) => ({ agents: kept, total: agents.length, ...unreachableOf(failures.map(({ host }) => host)) })
      )
    })),
  listPendingApprovals: implement(
    listPendingApprovals,
    () =>
      Effect.map(reads.pendingJobs, ({ jobs, more, unreachable }) => {
        const oldest = [...jobs].sort((left, right) => left.createdAt - right.createdAt)
        const shown = oldest.slice(0, 25).map((job) => ({
          host: job.host,
          jobId: job.jobId,
          kind: job.kind,
          requestedBy: clip(job.actor),
          requestedAt: job.createdAt,
          expiresAt: job.expiresAt
        }))
        return withinBytes(shown, (kept) => ({
          approvals: kept,
          more: more || kept.length < jobs.length,
          ...unreachableOf(unreachable)
        }))
      })
  ),
  getJob: implement(getJob, ({ host, jobId }) =>
    Effect.gen(function*() {
      const notFound = new JobNotFound({
        message: `No job ${jobId} on ${host} that Relay can read.`,
        fix: "Relay reads this hub's jobs and other hosts' pending ones; open that host's Approvals page for the rest."
      })
      if (host.toLowerCase() === reads.host.toLowerCase()) {
        const record = yield* reads.localJob(jobId)
        return record === null ? yield* notFound : summarizeJob(reads.host, record)
      }
      const { jobs } = yield* reads.pendingJobs
      const pending = jobs.find((job) => job.host.toLowerCase() === host.toLowerCase() && job.jobId === jobId)
      if (pending === undefined) return yield* notFound
      return {
        host: pending.host,
        jobId: pending.jobId,
        kind: pending.kind,
        status: "pending_approval",
        requestedBy: clip(pending.actor),
        createdAt: pending.createdAt,
        updatedAt: pending.createdAt,
        approvedBy: null,
        rejectedBy: null
      }
    })),
  getWorkBoard: implement(getWorkBoard, () =>
    Effect.map(reads.work, ({ goals }) =>
      withinBytes(
        goals.slice(0, 30).map((goal) => ({
          id: goal.id,
          title: clip(goal.title),
          state: goal.state,
          owner: clip(goal.owner.name),
          repository: clip(goal.repository.repository),
          branch: clip(goal.repository.branch),
          delivery: goal.delivery,
          blocker: goal.blocker === null ? null : clip(goal.blocker.summary)
        })),
        (kept) => ({ goals: kept, total: goals.length })
      )))
})
