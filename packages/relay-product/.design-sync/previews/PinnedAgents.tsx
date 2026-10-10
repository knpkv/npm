// Fixtures from packages/herdr-connect/test/pinned-agent.test.tsx.
import { PinnedAgents } from "@knpkv/relay-app-design-system"
import type { ConnectAgent } from "@knpkv/herdr-connect/model"
import type { ReactNode } from "react"

const noop = () => undefined
const agent = (name: string): ConnectAgent => ({
  host: "nix",
  id: name,
  kind: "claude",
  lastActivityAt: 1_000,
  name,
  state: "waiting",
  work: "npm"
})
const reviewer = agent("agent-reviewer")
const fleet = ["a", "b", "c", "d", "e"].map((name) => agent(`agent-${name}`))
const pinsFor = (agents: ReadonlyArray<ConnectAgent>) =>
  agents.map((each) => ({
    host: each.host,
    id: each.id,
    key: `${each.host}:${each.id}`,
    name: each.name,
    seenAt: 0
  }))
const byKey = new Map(fleet.map((each) => [`${each.host}:${each.id}`, each]))
const props = { now: 0, onOpen: noop, onUnpin: noop, stale: false }

// Float pins are position: fixed in the app; the transform makes this frame their containing block,
// so they sit in the card's end corner instead of the page's.
const Corner = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ blockSize: 240, position: "relative", transform: "translateZ(0)" }}>{children}</div>
)

export const Default = () => (
  <Corner>
    <PinnedAgents {...props} agentFor={() => reviewer} pins={pinsFor([reviewer])} placement="float" />
  </Corner>
)
export const Overflow = () => (
  <Corner>
    <PinnedAgents {...props} agentFor={(key) => byKey.get(key)} pins={pinsFor(fleet)} placement="float" />
  </Corner>
)
export const TerminalBar = () => (
  <PinnedAgents {...props} agentFor={(key) => byKey.get(key)} pins={pinsFor(fleet)} placement="bar" />
)
export const NoChipRoom = () => (
  <PinnedAgents
    {...props}
    agentFor={(key) => byKey.get(key)}
    pins={pinsFor(fleet.slice(0, 2))}
    placement="bar"
    room={0}
  />
)
