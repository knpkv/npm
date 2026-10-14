/** Synthetic directory readings for the Home grouping, relationship and unknown-host guards. */
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { Schema } from "effect"

/** Export Home identities and recorded families; this mode is separate from generic interaction fixtures. */
const designReading = (now: number, state: string): FleetConnectAgentPage => {
  const fields = [
    {
      name: "coord",
      host: "atlas",
      state: "waiting",
      hue: "iris",
      work: "The new pins are checked. Apply them on atlas?"
    },
    {
      name: "release",
      host: "atlas",
      state: "waiting",
      hue: "lime",
      work: "All checks passed. Publish herdr 0.18?",
      relationship: { parentAgentId: "agent-coord", relation: "delegated" }
    },
    {
      name: "rev-usage",
      host: "birch",
      state: "blocked",
      hue: "moss",
      work: "The backup check needs a writable test directory. Can you reassign this?"
    },
    {
      name: "ds-rly",
      host: "atlas",
      state: "working",
      hue: "rose",
      work: "Porting the new outcome badges into the design system."
    },
    {
      name: "pair-codex",
      host: "atlas",
      state: "working",
      hue: "moss",
      work: "Checking the same changes against the motion spec.",
      relationship: { parentAgentId: "agent-ds-rly", relation: "pair" }
    },
    {
      name: "sec-cc",
      host: "cedar",
      state: "working",
      hue: "rose",
      work: "The sandbox environment checks pass. Reviewing the last finding."
    },
    { name: "pkgsrc", host: "birch", state: "done", hue: "ember", work: "Switchable package sources merged." }
  ]
  if (state === "designready") {
    fields.push(
      { name: "lint-watch", host: "atlas", state: "ready", hue: "ember", work: "Watching for the next assignment" },
      { name: "docs-sync", host: "birch", state: "idle", hue: "sky", work: "Waiting for the next assignment" }
    )
  }
  return Schema.decodeUnknownSync(FleetConnectAgentPage)({
    agents: fields.map((agent) => ({
      ...agent,
      id: `agent-${agent.name}`,
      kind: "worker",
      lastActivityAt: agent.name === "pkgsrc" ?
        now - 42 * 60_000
        : agent.name === "lint-watch" ?
        now - 10 * 60_000
        : agent.name === "docs-sync"
        ? now - 22 * 60_000
        : now
    })),
    hosts: ["atlas", "birch", "cedar"],
    failures: state === "designpartial" ? [{ host: "cedar", reason: "offline" }] : [],
    nextCursor: null
  }, { onExcessProperty: "error" })
}

export const connectFixture = (now: number, state: string): FleetConnectAgentPage => {
  if (state === "design" || state === "designready" || state === "designpartial") return designReading(now, state)
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
