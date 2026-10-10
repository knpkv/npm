import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { agentBucketsOf, arrivalsBetween } from "../src/arrivals.js"
import { ConnectAgent } from "../src/model.js"

const agent = (id: string, state: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "nix",
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
})
