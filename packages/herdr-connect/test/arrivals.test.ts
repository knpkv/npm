import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { agentBucketsOf, arrivalsBetween, nextAgentBuckets } from "../src/arrivals.js"
import { ConnectAgent } from "../src/model.js"

const agent = (id: string, state: string, host = "nix") =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host,
    id: Schema.decodeUnknownSync(AgentStableId)(id),
    kind: "claude",
    lastActivityAt: 1_000,
    name: id,
    state,
    work: "npm"
  })

const poll = (...agents: ReadonlyArray<ReturnType<typeof agent>>) => agentBucketsOf(agents)

describe("arrivalsBetween", () => {
  // Opening Connect must not make every waiting agent lean at once.
  it("treats the first poll as history", () => {
    expect([...arrivalsBetween(null, poll(agent("agent-one", "waiting")))]).toEqual([])
  })

  it("names an agent that moved into needs-you, once", () => {
    const before = poll(agent("agent-one", "working"), agent("agent-two", "blocked"))
    const now = poll(agent("agent-one", "waiting"), agent("agent-two", "blocked"))
    expect([...arrivalsBetween(before, now)]).toEqual(["nix:agent-one"])
    // Still waiting on the next poll: that is not news.
    expect([...arrivalsBetween(now, now)]).toEqual([])
  })

  it("names an agent that appeared already needing you, and never one that stopped", () => {
    const before = poll(agent("agent-one", "blocked"))
    const now = poll(agent("agent-one", "working"), agent("agent-two", "error"))
    expect([...arrivalsBetween(before, now)]).toEqual(["nix:agent-two"])
  })

  // A flapping host must not make its waiting agents turn to you every time it comes back.
  it("does not count a waiting agent again after its host misses a poll", () => {
    const waiting = agent("agent-one", "waiting", "mbp")
    const first = poll(waiting, agent("agent-two", "working"))
    // mbp misses the next poll: its agents are absent and it is listed as silent.
    const silentPoll = poll(agent("agent-two", "working"))
    const carried = nextAgentBuckets(first, silentPoll, new Set(["mbp"]))
    expect([...arrivalsBetween(first, silentPoll)]).toEqual([])
    // mbp answers again with agent-one still waiting, and a new agent already needing you.
    const back = poll(waiting, agent("agent-two", "working"), agent("agent-three", "blocked", "mbp"))
    expect([...arrivalsBetween(carried, back)]).toEqual(["mbp:agent-three"])
  })

  it("forgets a host's agents once that host answers without them", () => {
    const first = poll(agent("agent-one", "waiting", "mbp"))
    const answered = poll()
    const next = nextAgentBuckets(first, answered, new Set())
    expect([...arrivalsBetween(next, poll(agent("agent-one", "waiting", "mbp")))]).toEqual(["mbp:agent-one"])
  })
})
