// Fixtures from packages/herdr-connect/test/stage.test.tsx, packages/herdr-connect/test/cast-roving.test.tsx.
import { AgentCast } from "@knpkv/relay-app-design-system"
import type { ConnectAgent } from "@knpkv/herdr-connect/model"

const noop = () => undefined
const agent = (id: string, state: string, work = "Review #721"): ConnectAgent => ({
  host: "nix",
  id,
  kind: "claude",
  lastActivityAt: 1_000,
  name: id,
  state,
  work
})
const agents = [agent("agent-one", "working"), agent("agent-two", "blocked"), agent("agent-three", "done")]
const needsYou = [
  agent("agent-one", "waiting", "npm"),
  agent("agent-two", "blocked", "npm"),
  agent("agent-three", "blocked", "npm")
]

export const Default = () => <AgentCast agents={agents} onOpen={noop} stale={false} />
export const Many = () => <AgentCast agents={needsYou} onOpen={noop} stale={false} />
export const Stale = () => <AgentCast agents={needsYou} onOpen={noop} stale />
