// @vitest-environment happy-dom

import { agentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { WorkGoal, WorkSnapshots } from "@knpkv/herdr-work/model"
import { Schema } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import { ConnectAgent } from "../src/model.js"
import { AgentStage, connectOwnedPullRequests } from "../src/stage.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const agent = (id: string, parent?: string, relation = "pair") => {
  const fields = {
    host: "ALPHA",
    id,
    name: id,
    kind: "codex",
    state: "working",
    work: "Package work",
    lastActivityAt: 1_000
  }
  return Schema.decodeUnknownSync(ConnectAgent)(
    parent === undefined ? fields : { ...fields, relationship: { parentAgentId: parent, relation } }
  )
}
const primary = agent("agent-primary")
const partner = agent("agent-partner", primary.id)
const goal = Schema.decodeUnknownSync(WorkGoal)({
  id: "pr-example_package-12",
  title: "Package fix",
  summary: "Package work",
  detail: "Review package",
  state: "review",
  owner: { id: "owner-example", name: "Package owner" },
  repository: { repository: "package", branch: "feat/fix" },
  delivery: "pull_request",
  blocker: null,
  spend: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  agentHierarchy: { agent: { host: "ALPHA", agentId: primary.id, name: primary.name, paneId: "w1:p1" } },
  connectTarget: agentConnectTarget(
    Schema.decodeUnknownSync(AgentWorkerIdentity)({
      host: "ALPHA",
      agentId: primary.id,
      name: primary.name,
      paneId: "w1:p1"
    })
  ),
  review: { state: "requested", summary: null, updatedAt: 1_000, url: "https://github.com/example/package/pull/12" }
})
const snapshot = (now: ReadonlyArray<typeof goal>, history: ReadonlyArray<typeof goal> = []) =>
  Schema.decodeUnknownSync(WorkSnapshots)({
    observedAt: 2_000,
    now: { window: "now", observedAt: 2_000, asOf: 2_000, goals: now },
    day: { window: "day", observedAt: 2_000, asOf: 2_000, goals: history },
    week: { window: "week", observedAt: 2_000, asOf: 2_000, goals: history },
    month: { window: "month", observedAt: 2_000, asOf: 2_000, goals: history }
  })

describe("Stage lineage and PR evidence", () => {
  it("counts unique actual PR URLs bound to the exact agent, including completed goals", () => {
    const complete = Schema.decodeUnknownSync(WorkGoal)({ ...goal, state: "completed" })
    expect(connectOwnedPullRequests(primary, snapshot([complete], [complete]))).toEqual([goal.review?.url])
    expect(connectOwnedPullRequests(partner, snapshot([complete]))).toEqual([])
    const otherHost = Schema.decodeUnknownSync(ConnectAgent)({ ...primary, host: "BETA" })
    expect(connectOwnedPullRequests(otherHost, snapshot([complete]))).toEqual([])
    expect(connectOwnedPullRequests(primary, snapshot([{ ...goal, review: null }]))).toEqual([])
    const transferred = Schema.decodeUnknownSync(WorkGoal)({
      ...goal,
      updatedAt: 2_000,
      agentHierarchy: null,
      connectTarget: null
    })
    expect(connectOwnedPullRequests(primary, snapshot([transferred], [goal]))).toEqual([])
  })

  it("opens the recorded primary from a paired stage and never invents an opened PR count", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const open = vi.fn()
    try {
      await act(async () =>
        root.render(
          <AgentStage
            agent={partner}
            agents={[primary, partner]}
            crew={[]}
            onClose={() => undefined}
            onOpen={open}
            onOpenTerminal={() => undefined}
            onPinChange={() => undefined}
            pinned={false}
            stale={false}
            workGoal={{ _tag: "missing" }}
            workSnapshots={snapshot([goal])}
          />
        )
      )
      const lineage = document.querySelector("section[aria-label='Lineage']")
      expect(lineage?.textContent).toContain("Paired with")
      const parent = lineage?.querySelector<HTMLButtonElement>("button")
      expect(parent?.textContent).toContain(primary.name)
      await act(async () => parent?.click())
      expect(open).toHaveBeenCalledWith(primary)
      const prs = document.querySelector("section[aria-label='Pull requests']")
      expect(prs?.textContent).toContain("owned 0")
      expect(prs?.textContent).not.toContain("opened")
      await act(async () =>
        root.render(
          <AgentStage
            agent={primary}
            agents={[primary, partner]}
            crew={[partner]}
            onClose={() => undefined}
            onOpen={open}
            onOpenTerminal={() => undefined}
            onPinChange={() => undefined}
            pinned={false}
            stale={false}
            workGoal={{ _tag: "missing" }}
            workSnapshots={snapshot([goal])}
          />
        )
      )
      expect(document.querySelector("nav[aria-label='Pair partners']")?.textContent).toContain(partner.name)
      expect(document.querySelector("section[aria-label='Pull requests']")?.textContent).toContain("owned 1")
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
