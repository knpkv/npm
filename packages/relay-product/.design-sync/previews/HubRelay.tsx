// Fixtures from packages/herdr-hub/test/hub-relay.test.tsx.
import { HubRelay } from "@knpkv/relay-app-design-system"
import type { RelayConversations, RelayConversationState } from "@knpkv/relay-product/client"
import * as Exit from "effect/Exit"

const noop = () => undefined
const fleet = { product: "herdr", kind: "fleet", id: "hub.tail" }

const idle: RelayConversationState = {
  backend: null,
  confirmations: [],
  connection: "live",
  failure: null,
  generation: 1,
  messages: [],
  outbox: [],
  outcomes: [],
  queued: [],
  runIds: [],
  tools: []
}

const working: RelayConversationState = { ...idle, runIds: ["r1"] }
const reading: RelayConversationState = {
  ...working,
  tools: [
    {
      after: null,
      call: "t1",
      capability: "list_agents",
      receipt: null,
      state: "running",
      summary: "Reading agents"
    }
  ]
}
const awaitingDecision: RelayConversationState = {
  ...working,
  confirmations: [
    {
      action: { verb: "prompt_agent", target: fleet, args: {} },
      call: "c1",
      decision: "pending",
      reversible: false
    }
  ]
}

/** The test's in-memory service, held at one folded fixture state for each card. */
const conversation = (state: RelayConversationState) => {
  const conversations: RelayConversations = {
    cancel: () => Promise.resolve(Exit.void),
    decide: () => Promise.resolve(Exit.void),
    dispose: noop,
    get: () => state,
    newRequestId: () => Promise.resolve(Exit.succeed("r1")),
    retry: noop,
    send: () => Promise.resolve(Exit.void),
    subscribe: (_, listener) => {
      listener(state, null)
      return noop
    }
  }
  return { conversation: fleet, conversations }
}

const idleRelay = conversation(idle)
const workingRelay = conversation(working)
const readingRelay = conversation(reading)
const decisionRelay = conversation(awaitingDecision)

export const Default = () => <HubRelay relay={idleRelay} terminalOwnsKeys={false} />
export const Working = () => <HubRelay relay={workingRelay} terminalOwnsKeys={false} />
export const Reading = () => <HubRelay relay={readingRelay} terminalOwnsKeys={false} />
export const NeedsDecision = () => <HubRelay relay={decisionRelay} terminalOwnsKeys={false} />
