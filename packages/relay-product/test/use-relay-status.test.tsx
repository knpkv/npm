// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import type { ObjectRef } from "@knpkv/relay/wire"
import * as Exit from "effect/Exit"
import { act, type ReactElement } from "react"
import { createRoot } from "react-dom/client"

import {
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConversationListener,
  type RelayConversations,
  type RelayConversationState,
  useRelayStatus
} from "../src/client.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const ref: ObjectRef = { product: "codecommit", kind: "pull-request", id: "pr-1" }
const at = { seq: 0, session: "s1" }

/** One conversation driven by hand: `emit` folds an event and tells every reader, as the client does. */
const fakeConversations = () => {
  let state: RelayConversationState = initialRelayConversation
  const listeners = new Set<RelayConversationListener>()
  const conversations: RelayConversations = {
    cancel: () => Promise.resolve(Exit.die("unused")),
    decide: () => Promise.resolve(Exit.die("unused")),
    dispose: () => undefined,
    get: () => state,
    newRequestId: () => Promise.resolve(Exit.die("unused")),
    retry: () => undefined,
    send: () => Promise.resolve(Exit.die("unused")),
    subscribe: (_, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const emit = (event: RelayClientEvent): void => {
    state = foldRelayConversation(state, event)
    for (const listener of listeners) listener(state, event)
  }
  return { conversations, emit }
}

const Probe = (props: { readonly conversations: RelayConversations; readonly open: boolean }): ReactElement => {
  const status = useRelayStatus(props.conversations, ref, props.open)
  return <output data-activity={status.activity}>{status.words}</output>
}

describe("useRelayStatus", () => {
  // The mark's unread pose survives re-renders and goes once the panel shows the reply.
  it("marks a reply that lands while closed unread, and clears it when the panel opens", async () => {
    const { conversations, emit } = fakeConversations()
    const host = document.createElement("div")
    const root = createRoot(host)
    const render = (open: boolean) => act(async () => root.render(<Probe conversations={conversations} open={open} />))
    const shown = () => host.querySelector("output")?.getAttribute("data-activity")
    try {
      await render(false)
      await act(async () => {
        emit({
          _tag: "Snapshot",
          ...at,
          messages: [{ id: "1", role: "relay", text: "Earlier." }],
          runIds: [],
          queued: []
        })
      })
      expect(shown()).toBe("idle")
      await act(async () => {
        emit({ _tag: "MessagePlaced", ...at, id: "2", requestId: "r1", text: "Check the stacked view." })
        emit({ _tag: "RunStarted", ...at, runIds: ["r1"] })
      })
      expect(shown()).toBe("working")
      await act(async () => {
        emit({ _tag: "TextDelta", ...at, text: "Done." })
        emit({ _tag: "RunFinished", ...at, runIds: ["r1"] })
      })
      expect(shown()).toBe("unread")
      expect(host.textContent).toBe("Relay replied")
      await render(true)
      expect(shown()).toBe("idle")
      await render(false)
      expect(shown()).toBe("idle")
    } finally {
      await act(async () => root.unmount())
    }
  })
})
