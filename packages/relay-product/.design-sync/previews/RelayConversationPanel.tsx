// Fixtures from packages/relay-product/test/relay-conversation-panel.test.tsx.
import { foldRelayConversation, initialRelayConversation, RelayConversationPanel } from "@knpkv/relay-app-design-system"
import type { RelayClientEvent, RelayConversations, RelayConversationState } from "@knpkv/relay-product/client"
import type { ObjectRef } from "@knpkv/relay/wire"
import * as Exit from "effect/Exit"
import { useMemo, useRef } from "react"

const noop = () => undefined
const fleet: ObjectRef = { product: "herdr", kind: "fleet", id: "SER8" }
const at = { seq: 0, session: "s1" }
const live: RelayClientEvent = { _tag: "Snapshot", ...at, messages: [], runIds: [], queued: [] }
const answering: ReadonlyArray<RelayClientEvent> = [
  live,
  { _tag: "MessagePlaced", ...at, id: "1", requestId: "r1", text: "Status?" },
  { _tag: "RunStarted", ...at, runIds: ["r1"] },
  { _tag: "TextDelta", ...at, seq: 2, text: "Looking." },
  { _tag: "ToolStarted", ...at, call: "t1", capability: "list_agents", summary: "Reading agents", input: {} }
]
const confirmation: RelayClientEvent = {
  _tag: "ConfirmationRequired",
  ...at,
  call: "c1",
  action: { verb: "prompt_agent", target: { product: "herdr", kind: "agent", id: "worker-1" }, args: {} },
  reversible: false
}

/** The test's conversation store, holding one fixed folded state with inert writes. */
const conversationsFor = (events: ReadonlyArray<RelayClientEvent>): RelayConversations => {
  const state = events.reduce<RelayConversationState>(foldRelayConversation, initialRelayConversation)
  const listeners = new Set<Parameters<RelayConversations["subscribe"]>[1]>()
  return {
    cancel: () => Promise.resolve(Exit.void),
    decide: () => Promise.resolve(Exit.void),
    dispose: noop,
    get: () => state,
    newRequestId: () => Promise.resolve(Exit.succeed("r1")),
    retry: noop,
    send: () => Promise.resolve(Exit.void),
    subscribe: (_, listener) => {
      listeners.add(listener)
      listener(state, null)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const Panel = ({ events }: { readonly events: ReadonlyArray<RelayClientEvent> }) => {
  const launcher = useRef<HTMLButtonElement>(null)
  const conversations = useMemo(() => conversationsFor(events), [events])
  return (
    <div style={{ minBlockSize: "44rem" }}>
      <button ref={launcher} type="button">
        Relay
      </button>
      <RelayConversationPanel
        composerRef={noop}
        conversation={fleet}
        conversations={conversations}
        launcher={launcher}
        onClose={noop}
        placeholder="Ask Relay about the fleet"
        presentation="overlay"
        regionRef={noop}
        scope={{ label: "Fleet" }}
        signedOut={{ description: "Open the hub from your tailnet again.", action: <a href="/">Reload</a> }}
        decision={(card) => ({
          body: JSON.stringify(card.action.args),
          copy: {
            ask: `Prompt ${card.action.target.id}?`,
            confirm: "Prompt agent",
            decline: "Don't prompt",
            done: "Prompted",
            working: "Prompting…"
          },
          target: [{ label: "Agent", value: card.action.target.id }]
        })}
      />
    </div>
  )
}

export const Default = () => <Panel events={[live]} />
export const Working = () => <Panel events={answering} />
export const PendingConfirmation = () => <Panel events={[live, confirmation]} />
export const SignedOut = () => <Panel events={[{ _tag: "Unauthorized" }]} />
export const StreamFailed = () => <Panel events={[{ _tag: "StreamFailed" }]} />
