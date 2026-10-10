import { describe, expect, it } from "@effect/vitest"
import { invoke } from "@knpkv/capability"
import { FleetConnectAgents } from "@knpkv/herdr-connect"
import { WorkSnapshot } from "@knpkv/herdr-work"
import { Effect, Schema } from "effect"

import { SanitizedJobRecord } from "../src/approval-request.js"
import {
  ANSWER_MAX_BYTES,
  FIELD_MAX,
  getJob,
  getWorkBoard,
  hubCapabilities,
  type HubRelayReads,
  listAgents,
  listPendingApprovals,
  type PendingJob
} from "../src/relay/capabilities.js"

const agents = (count: number, long?: string) =>
  Schema.decodeUnknownSync(FleetConnectAgents)({
    agents: Array.from({ length: count }, (_, index) => ({
      id: `agent-${index}`,
      host: index % 2 === 0 ? "SER8" : "ALPHA",
      name: `worker-${index}`,
      kind: long ?? "claude",
      state: long ?? "working",
      work: long ?? "Reviewing #712",
      lastActivityAt: index
    })),
    failures: [{ host: "BETA", reason: "offline" }]
  })

const pending = (count: number): ReadonlyArray<PendingJob> =>
  Array.from({ length: count }, (_, index) => ({
    host: "ALPHA",
    jobId: `alpha-job-${index}`,
    kind: "nix.check",
    actor: "andrey@example.com",
    createdAt: 1_000 - index,
    expiresAt: null
  }))

const localRecord = Schema.decodeUnknownSync(SanitizedJobRecord)({
  id: "ser8-job-1",
  createdAt: 10,
  updatedAt: 20,
  actor: "andrey@example.com",
  approvedBy: "andrey@example.com",
  status: "succeeded",
  approvalAvailable: false,
  payload: { kind: "nix.check" }
})

const board = (count: number) =>
  Schema.decodeUnknownSync(WorkSnapshot)({
    window: "now",
    observedAt: 1,
    asOf: 1,
    goals: Array.from({ length: count }, (_, index) => ({
      id: `goal-${index}`,
      title: `Goal ${index}`,
      summary: "s",
      detail: "d",
      state: index === 0 ? "blocked" : "working",
      owner: { id: `agent-${index}`, name: `worker-${index}` },
      repository: { repository: "knpkv/npm", branch: `feat/goal-${index}` },
      spend: null,
      delivery: "pull_request",
      blocker: index === 0 ? { summary: "Waiting on CI", since: 1 } : null,
      connectTarget: null,
      createdAt: 1,
      updatedAt: 1
    }))
  })

const reads = (overrides: Partial<HubRelayReads> = {}): HubRelayReads => ({
  host: "SER8",
  agents: Effect.succeed(agents(3)),
  pendingJobs: Effect.succeed({ jobs: pending(2), more: false, unreachable: [] }),
  localJob: (jobId) => Effect.succeed(jobId === localRecord.id ? localRecord : null),
  work: Effect.succeed(board(2)),
  ...overrides
})

describe("Relay's hub capabilities", () => {
  it("only read: none approves, declines, prompts or submits", () => {
    const contracts = [listAgents, listPendingApprovals, getJob, getWorkBoard]
    expect(contracts.map(({ access }) => access)).toEqual(["read", "read", "read", "read"])
    expect(Object.keys(hubCapabilities(reads()))).toHaveLength(4)
  })

  it.effect("lists at most 50 agents, most recently active first, and says how many there were", () =>
    Effect.gen(function*() {
      const { output } = yield* invoke(hubCapabilities(reads({ agents: Effect.succeed(agents(80)) })).listAgents, {})
      const answer = Schema.decodeUnknownSync(Schema.Struct({
        agents: Schema.Array(Schema.Struct({ name: Schema.String })),
        total: Schema.Number,
        unreachableHosts: Schema.Array(Schema.String)
      }))(output)
      expect(answer.agents).toHaveLength(50)
      expect(answer.agents[0]?.name).toBe("worker-79")
      expect(answer.total).toBe(80)
      expect(answer.unreachableHosts).toEqual(["BETA"])
    }))

  it.effect("cuts long text and keeps every answer within its byte budget", () =>
    Effect.gen(function*() {
      const long = "x".repeat(255)
      const { output } = yield* invoke(
        hubCapabilities(reads({ agents: Effect.succeed(agents(80, long)) })).listAgents,
        {}
      )
      const answer = Schema.decodeUnknownSync(
        Schema.Struct({ agents: Schema.Array(Schema.Struct({ work: Schema.String })), total: Schema.Number })
      )(output)
      expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThanOrEqual(ANSWER_MAX_BYTES)
      // Three long fields on 50 agents is over the budget: some are left out, the rest fit.
      expect(answer.agents.length).toBeGreaterThan(0)
      expect(answer.agents.length).toBeLessThan(50)
      expect(answer.agents[0]?.work).toHaveLength(FIELD_MAX)
      expect(answer.agents[0]?.work.endsWith("…")).toBe(true)
      expect(answer.total).toBe(80)
    }))

  it.effect("keeps a large fleet's unreachable hosts within the budget too, and counts the ones it leaves out", () =>
    Effect.gen(function*() {
      const hosts = Array.from({ length: 128 }, (_, index) => `${"h".repeat(200)}-${index}`)
      const capabilities = hubCapabilities(reads({
        agents: Effect.succeed({ agents: [], failures: hosts.map((host) => ({ host, reason: "offline" })) }),
        pendingJobs: Effect.succeed({ jobs: [], more: false, unreachable: hosts })
      }))
      const answers = [
        (yield* invoke(capabilities.listAgents, {})).output,
        (yield* invoke(capabilities.listPendingApprovals, {})).output
      ]
      for (const output of answers) {
        expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThanOrEqual(ANSWER_MAX_BYTES)
        expect(output).toMatchObject({ unreachableOmitted: 112 })
      }
      const one = yield* invoke(
        hubCapabilities(reads({ pendingJobs: Effect.succeed({ jobs: [], more: false, unreachable: ["BETA"] }) }))
          .listPendingApprovals,
        {}
      )
      expect(one.output).toMatchObject({ unreachableHosts: ["BETA"], unreachableOmitted: 0 })
    }))

  it.effect("keeps host names whole: they are identities Relay passes back", () =>
    Effect.gen(function*() {
      const near = `${"a".repeat(190)}-one`
      const far = `${"a".repeat(190)}-two`
      const capabilities = hubCapabilities(reads({
        agents: Effect.succeed({
          agents: Schema.decodeUnknownSync(FleetConnectAgents)({
            agents: [near, far].map((host, index) => ({
              id: `agent-${index}`,
              host,
              name: `worker-${index}`,
              kind: "claude",
              state: "working",
              work: "Reviewing",
              lastActivityAt: index
            })),
            failures: []
          }).agents,
          failures: [{ host: near, reason: "offline" }, { host: "BETA", reason: "offline" }]
        }),
        pendingJobs: Effect.succeed({ jobs: [], more: false, unreachable: [near, far, "BETA"] })
      }))
      const agentsAnswer = (yield* invoke(capabilities.listAgents, {})).output
      expect(agentsAnswer).toMatchObject({ unreachableHosts: [near, "BETA"] })
      const agentHosts = Schema.decodeUnknownSync(
        Schema.Struct({ agents: Schema.Array(Schema.Struct({ host: Schema.String })) })
      )(
        agentsAnswer
      ).agents.map(({ host }) => host)
      expect(agentHosts.toSorted()).toEqual([near, far])
      const pendingAnswer = (yield* invoke(capabilities.listPendingApprovals, {})).output
      expect(pendingAnswer).toMatchObject({ unreachableHosts: [near, far, "BETA"] })
      expect(new TextEncoder().encode(JSON.stringify(pendingAnswer)).length).toBeLessThanOrEqual(ANSWER_MAX_BYTES)
    }))

  it.effect("lists the 25 oldest pending approvals and says more are waiting", () =>
    Effect.gen(function*() {
      const { output } = yield* invoke(
        hubCapabilities(
          reads({ pendingJobs: Effect.succeed({ jobs: pending(30), more: false, unreachable: ["BETA"] }) })
        )
          .listPendingApprovals,
        {}
      )
      const answer = Schema.decodeUnknownSync(Schema.Struct({
        approvals: Schema.Array(Schema.Struct({ jobId: Schema.String })),
        more: Schema.Boolean,
        unreachableHosts: Schema.Array(Schema.String)
      }))(output)
      expect(answer.approvals).toHaveLength(25)
      expect(answer.approvals[0]?.jobId).toBe("alpha-job-29")
      expect(answer.more).toBe(true)
      expect(answer.unreachableHosts).toEqual(["BETA"])
    }))

  it.effect("reads a job's state, never its output: this hub's jobs and other hosts' pending ones", () =>
    Effect.gen(function*() {
      const capabilities = hubCapabilities(reads())
      const local = yield* invoke(capabilities.getJob, { host: "ser8", jobId: "ser8-job-1" })
      expect(local.output).toEqual({
        host: "SER8",
        jobId: "ser8-job-1",
        kind: "nix.check",
        status: "succeeded",
        requestedBy: "andrey@example.com",
        createdAt: 10,
        updatedAt: 20,
        approvedBy: "andrey@example.com",
        rejectedBy: null
      })
      const remote = yield* invoke(capabilities.getJob, { host: "ALPHA", jobId: "alpha-job-1" })
      expect(remote.output).toMatchObject({ host: "ALPHA", status: "pending_approval" })
      const missing = yield* Effect.flip(invoke(capabilities.getJob, { host: "ALPHA", jobId: "alpha-job-99" }))
      expect(missing).toMatchObject({ _tag: "CapabilityFailed", tag: "JobNotFound" })
      const unknownLocal = yield* Effect.flip(invoke(capabilities.getJob, { host: "SER8", jobId: "nope" }))
      expect(unknownLocal).toMatchObject({ _tag: "CapabilityFailed", tag: "JobNotFound" })
    }))

  it.effect("counts the older goals a large board leaves out, so Relay can say they are not shown", () =>
    Effect.gen(function*() {
      const cut = { ...board(2), goalsOmitted: 40 }
      const { output } = yield* invoke(hubCapabilities(reads({ work: Effect.succeed(cut) })).getWorkBoard, {})
      expect(output).toMatchObject({ total: 42, notShown: 40 })
      const whole = yield* invoke(hubCapabilities(reads()).getWorkBoard, {})
      expect(whole.output).toMatchObject({ total: 2, notShown: 0 })
    }))

  it.effect("summarizes at most 30 goals of the Work board as it stands now", () =>
    Effect.gen(function*() {
      const { output } = yield* invoke(hubCapabilities(reads({ work: Effect.succeed(board(40)) })).getWorkBoard, {})
      const answer = Schema.decodeUnknownSync(Schema.Struct({
        goals: Schema.Array(Schema.Struct({ id: Schema.String, blocker: Schema.NullOr(Schema.String) })),
        total: Schema.Number,
        notShown: Schema.Number
      }))(output)
      expect(answer.goals).toHaveLength(30)
      expect(answer.total).toBe(40)
      expect(answer.notShown).toBe(10)
      expect(answer.goals[0]?.blocker).toBe("Waiting on CI")
    }))
})
