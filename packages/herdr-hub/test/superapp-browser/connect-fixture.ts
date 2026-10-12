/** Synthetic directory readings for the Home grouping, relationship and unknown-host guards. */
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { Schema } from "effect"

export const connectFixture = (now: number, state: string): FleetConnectAgentPage => {
  const agents = [
    { id: "agent-1", host: "hub", name: "Agent", state: "waiting", work: "Apply the checked pins?" },
    {
      id: "agent-release",
      host: "hub",
      name: "Release",
      state: "waiting",
      work: "Publish the checked package?",
      relationship: { parentAgentId: "agent-1", relation: "delegated" }
    },
    { id: "agent-review", host: "birch", name: "Review", state: "blocked", work: "A review needs a decision" },
    { id: "agent-build", host: "hub", name: "Build", state: "working", work: "Checking the changes" },
    {
      id: "agent-pair",
      host: "hub",
      name: "Pair",
      state: "working",
      work: "Checking the same changes",
      relationship: { parentAgentId: "agent-build", relation: "pair" }
    },
    { id: "agent-peer", host: "cedar", name: "Peer", state: "working", work: "Reviewing the last finding" },
    { id: "agent-finished", host: "birch", name: "Finished", state: "done", work: "Checks complete" }
  ]
  if (state === "ready") {
    agents.push(
      { id: "agent-idle", host: "birch", name: "Idle watcher", state: "idle", work: "Waiting for the next assignment" },
      {
        id: "agent-ready",
        host: "hub",
        name: "Ready watcher",
        state: "ready",
        work: "Watching for the next assignment"
      }
    )
  }
  if (state === "unknown") {
    agents.push(
      { id: "agent-new", host: "hub", name: "New state", state: "new-wire-state", work: "Unrecognized state" }
    )
  }
  return Schema.decodeUnknownSync(FleetConnectAgentPage)({
    agents: state === "empty" ? [] : agents.map((agent, index) => ({
      ...agent,
      kind: index % 2 === 0 ? "claude" : "codex",
      lastActivityAt: now - index * 60_000
    })),
    hosts: ["hub", "birch", "cedar"],
    failures: state === "partial" ? [{ host: "cedar", reason: "offline" }] : [],
    nextCursor: null
  }, { onExcessProperty: "error" })
}
