import { describe, expect, it } from "@effect/vitest"
import { agentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { WorkGoal, WorkSnapshots } from "@knpkv/herdr-work/model"
import { Schema } from "effect"
import { ConnectAgent } from "../src/model.js"
import { resolveConnectWorkGoal } from "../src/work-goal-link.js"

const worker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
  agentId: "agent-reviewer",
  host: "SER8",
  name: "Review worker",
  paneId: "wE:p3"
})

const workGoal = Schema.decodeUnknownSync(WorkGoal)({
  agentHierarchy: { agent: worker },
  blocker: null,
  connectTarget: agentConnectTarget(worker),
  createdAt: 1_000,
  delivery: "review",
  detail: "Review the current change",
  id: "goal-review",
  owner: { id: "owner-reviewer", name: "Reviewer" },
  repository: { branch: "feat/review", repository: "npm" },
  spend: null,
  state: "review",
  summary: "Review work",
  title: "Review browser pairing",
  updatedAt: 1_000
})

const connectAgent = Schema.decodeUnknownSync(ConnectAgent)({
  host: worker.host,
  id: worker.agentId,
  kind: "codex",
  lastActivityAt: 1_000,
  name: worker.name,
  state: "connected",
  work: "npm"
})

const snapshot = (goals: ReadonlyArray<typeof workGoal>): typeof WorkSnapshots.Type =>
  Schema.decodeUnknownSync(WorkSnapshots)({
    day: { asOf: 1_000, goals: [], observedAt: 1_000, window: "day" },
    month: { asOf: 1_000, goals: [], observedAt: 1_000, window: "month" },
    now: { asOf: 1_000, goals, observedAt: 1_000, window: "now" },
    observedAt: 1_000,
    week: { asOf: 1_000, goals: [], observedAt: 1_000, window: "week" }
  })

describe("Connect Work goal association", () => {
  it("resolves an exact current Work goal and canonical same-origin URL", () => {
    expect(resolveConnectWorkGoal(connectAgent, snapshot([workGoal]))).toEqual({
      _tag: "available",
      goalId: "goal-review",
      href: "/?tab=work&window=now&goal=goal-review",
      title: "Review browser pairing"
    })
  })

  it("follows a refreshed Work snapshot when ownership changes", () => {
    const replacement = Schema.decodeUnknownSync(WorkGoal)({
      ...workGoal,
      id: "goal-replacement",
      title: "Replacement goal"
    })
    expect(resolveConnectWorkGoal(connectAgent, snapshot([]))).toEqual({ _tag: "missing" })
    expect(resolveConnectWorkGoal(connectAgent, snapshot([replacement]))).toEqual({
      _tag: "available",
      goalId: "goal-replacement",
      href: "/?tab=work&window=now&goal=goal-replacement",
      title: "Replacement goal"
    })
  })

  it("does not use historical or unrelated goals as an association", () => {
    const unrelated = Schema.decodeUnknownSync(WorkGoal)({
      ...workGoal,
      agentHierarchy: null,
      connectTarget: null,
      id: "goal-unrelated",
      title: "Unrelated work"
    })
    expect(resolveConnectWorkGoal(connectAgent, snapshot([unrelated]))._tag).toBe("missing")
  })

  it("fails closed when more than one current goal owns the agent", () => {
    const second = Schema.decodeUnknownSync(WorkGoal)({
      ...workGoal,
      id: "goal-second",
      title: "Second goal"
    })
    expect(resolveConnectWorkGoal(connectAgent, snapshot([workGoal, second]))).toEqual({
      _tag: "ambiguous",
      goalIds: ["goal-review", "goal-second"]
    })
  })

  it("fails closed when a duplicated goal record makes ownership ambiguous", () => {
    const duplicate = Schema.decodeUnknownSync(WorkGoal)({
      ...workGoal,
      title: "Duplicated review goal"
    })
    expect(resolveConnectWorkGoal(connectAgent, snapshot([workGoal, duplicate]))).toEqual({
      _tag: "ambiguous",
      goalIds: ["goal-review", "goal-review"]
    })
  })

  it("requires both stable host and agent identity", () => {
    const foreignWorker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
      ...worker,
      host: "PI"
    })
    const foreignGoal = Schema.decodeUnknownSync(WorkGoal)({
      ...workGoal,
      agentHierarchy: { agent: foreignWorker },
      connectTarget: agentConnectTarget(foreignWorker)
    })
    expect(resolveConnectWorkGoal(connectAgent, snapshot([foreignGoal]))._tag).toBe("missing")
  })
})
