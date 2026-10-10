// Fixtures from packages/herdr-connect/test/stage-crew.test.tsx, packages/herdr-connect/test/stage.test.tsx.
import { AgentStage } from "@knpkv/relay-app-design-system"
import type { ConnectAgent } from "@knpkv/herdr-connect/model"
import type { ComponentProps } from "react"

const noop = () => undefined
const parent: ConnectAgent = {
  host: "nix",
  id: "agent-coordinator",
  kind: "claude",
  lastActivityAt: 1_000,
  name: "agent-coordinator",
  state: "running",
  work: "npm"
}
const child: ConnectAgent = {
  host: "nix",
  id: "agent-reviewer",
  kind: "claude",
  lastActivityAt: 1_000,
  name: "agent-reviewer",
  state: "waiting",
  work: "npm",
  relationship: { parentAgentId: "agent-coordinator", relation: "delegated" }
}
const props = {
  agent: parent,
  crew: [child],
  onClose: noop,
  onOpen: noop,
  onOpenTerminal: noop,
  onPinChange: noop,
  pinned: false,
  stale: false,
  workGoal: { _tag: "missing" }
}

const Stage = (stageProps: ComponentProps<typeof AgentStage>) => (
  <div style={{ contain: "layout", minBlockSize: "44rem" }}>
    <AgentStage {...stageProps} />
  </div>
)

export const Default = () => <Stage {...props} />
export const LinkedGoal = () => (
  <Stage
    {...props}
    crew={[]}
    workGoal={{
      _tag: "available",
      goalId: "pr-knpkv_npm-752",
      href: "/work/?goal=pr-knpkv_npm-752",
      title: "Pin more than one agent"
    }}
  />
)
export const Waiting = () => <Stage {...props} agent={child} agents={[parent, child]} crew={[]} />
export const Pinned = () => <Stage {...props} pinned />
export const Stale = () => <Stage {...props} stale />
