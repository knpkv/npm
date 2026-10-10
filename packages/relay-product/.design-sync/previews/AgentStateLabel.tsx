// Fixtures from packages/herdr-connect/test/agent-state.test.tsx.
import { AgentStateLabel } from "@knpkv/relay-app-design-system"

export const Default = () => <AgentStateLabel state="working" />
export const Waiting = () => <AgentStateLabel state="waiting" />
export const NeedsAttention = () => <AgentStateLabel state="blocked" />
export const Done = () => <AgentStateLabel state="done" />
export const Unknown = () => <AgentStateLabel state="compacting" />
