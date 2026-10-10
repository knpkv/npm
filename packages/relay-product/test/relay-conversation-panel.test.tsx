// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import type { ObjectRef } from "@knpkv/relay/wire"
import { RelayConflictError, RelayUnavailableError } from "@knpkv/relay/wire"
import { PortalProvider } from "@knpkv/rly/foundations"
import * as Exit from "effect/Exit"
import { act, type ReactElement, useRef } from "react"
import { createRoot } from "react-dom/client"

import {
  type RelayConfirmationCard,
  type RelayRequestFailure,
  RelayTransportFailed,
  SendIdUnavailable,
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConversationListener,
  type RelayConversations,
  type RelayConversationState,
  type RelayOutgoingMessage
} from "../src/client.js"
import { RelayConversationPanel } from "../src/relay-conversation-panel.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const fleet: ObjectRef = { product: "herdr", kind: "fleet", id: "SER8" }
const at = { seq: 0, session: "s1" }
const live: RelayClientEvent = { _tag: "Snapshot", ...at, messages: [], runIds: [], queued: [] }

/** One conversation driven by hand, with the writes recorded and answered as the test says. */
const fakeConversations = (
  answer: (message: RelayOutgoingMessage) => Exit.Exit<void, RelayUnavailableError>,
  options: {
    readonly ids?: () => Exit.Exit<string, SendIdUnavailable>
    readonly decide?: () => Exit.Exit<void, RelayRequestFailure>
  } = {}
) => {
  let state: RelayConversationState = initialRelayConversation
  const listeners = new Set<RelayConversationListener>()
  const sent: Array<RelayOutgoingMessage> = []
  const retries: Array<ObjectRef> = []
  const decisions: Array<{ readonly call: string; readonly allow: boolean }> = []
  let ids = 0
  const conversations: RelayConversations = {
    cancel: () => Promise.resolve(Exit.void),
    decide: (_, call, allow) => {
      decisions.push({ allow, call })
      return Promise.resolve(options.decide?.() ?? Exit.void)
    },
    dispose: () => undefined,
    get: () => state,
    newRequestId: () => {
      ids += 1
      return Promise.resolve(options.ids?.() ?? Exit.succeed(`r${String(ids)}`))
    },
    retry: (ref) => void retries.push(ref),
    send: (_, message) => {
      sent.push(message)
      return Promise.resolve(answer(message))
    },
    subscribe: (_, listener) => {
      listeners.add(listener)
      listener(state, null)
      return () => listeners.delete(listener)
    }
  }
  const emit = (event: RelayClientEvent): void => {
    state = foldRelayConversation(state, event)
    for (const listener of listeners) listener(state, event)
  }
  return { conversations, decisions, emit, retries, sent }
}

const Hub = ({ conversations }: { readonly conversations: RelayConversations }): ReactElement => {
  const launcher = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={launcher} type="button">
        Relay
      </button>
      <RelayConversationPanel
        composerRef={() => undefined}
        conversation={fleet}
        conversations={conversations}
        launcher={launcher}
        onClose={() => undefined}
        placeholder="Ask Relay about the fleet"
        presentation="overlay"
        regionRef={() => undefined}
        scope={{ label: "Fleet" }}
        signedOut={{ description: "Open the hub from your tailnet again.", action: <a href="/">Reload</a> }}
        decision={(card: RelayConfirmationCard) => ({
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
    </>
  )
}

const mount = async (conversations: RelayConversations) => {
  const host = document.createElement("div")
  const portal = document.createElement("div")
  document.body.append(host, portal)
  const root = createRoot(host)
  await act(async () =>
    root.render(<PortalProvider container={portal}>{<Hub conversations={conversations} />}</PortalProvider>)
  )
  const text = () => `${host.textContent ?? ""}${portal.textContent ?? ""}`
  const find = <E extends Element>(selector: string) =>
    host.querySelector<E>(selector) ?? portal.querySelector<E>(selector)
  const type = async (value: string) => {
    const field = find<HTMLTextAreaElement>("textarea")
    if (field === null) throw new Error("no composer")
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      setter?.call(field, value)
      field.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button"), ...portal.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label
    )
    if (button === undefined) throw new Error(`no button ${label}`)
    await act(async () => button.click())
  }
  /** A keyboard or pointer press: the button takes focus, then is clicked. */
  const press = async (label: string) => {
    const button = [...host.querySelectorAll("button"), ...portal.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label
    )
    if (button === undefined) throw new Error(`no button ${label}`)
    button.focus()
    await act(async () => button.click())
  }
  const unmount = () => act(async () => root.unmount())
  return { click, find, press, text, type, unmount }
}

describe("RelayConversationPanel", () => {
  it("says why Send would lose the message, and clears it once the stream is live", async () => {
    const { conversations, emit } = fakeConversations(() => Exit.void)
    const panel = await mount(conversations)
    expect(panel.text()).toContain("Relay is reconnecting.")
    await act(async () => emit(live))
    expect(panel.text()).not.toContain("Relay is reconnecting.")
    await act(async () => {
      emit({ _tag: "RunStarted", ...at, runIds: ["r0"] })
    })
    expect(panel.text()).toContain("Relay is answering.")
    await panel.unmount()
  })

  it("sends with a prepared id, keeps a refused message, and resends it with the same id", async () => {
    let refuse = true
    const { conversations, emit, sent } = fakeConversations(() =>
      refuse ? Exit.fail(new RelayUnavailableError({ message: "locked", fix: "Stop the other hostd" })) : Exit.void
    )
    const panel = await mount(conversations)
    await act(async () => emit(live))
    await panel.type("What waits for approval?")
    await panel.click("Send")
    expect(panel.text()).toContain("locked Stop the other hostd Your message is kept")
    expect(panel.find<HTMLTextAreaElement>("textarea")?.value).toBe("What waits for approval?")
    refuse = false
    await panel.click("Send")
    expect(sent.map(({ requestId }) => requestId)).toEqual(["r1", "r1"])
    expect(panel.find<HTMLTextAreaElement>("textarea")?.value).toBe("")
    await panel.unmount()
  })

  it("keeps the transcript answering across a tool boundary, ending only with the run", async () => {
    const { conversations, emit } = fakeConversations(() => Exit.void)
    const panel = await mount(conversations)
    await act(async () => {
      emit(live)
      emit({ _tag: "MessagePlaced", ...at, id: "1", requestId: "r1", text: "Status?" })
      emit({ _tag: "RunStarted", ...at, runIds: ["r1"] })
      emit({ _tag: "TextDelta", ...at, seq: 2, text: "Looking." })
      emit({ _tag: "ToolStarted", ...at, call: "t1", capability: "list_agents", summary: "Reading agents", input: {} })
    })
    // The reply row stopped streaming at the tool; the run did not, and the transcript still says so.
    expect(panel.text()).toContain("Relay is writing")
    expect(panel.text()).toContain("Relay is answering.")
    await act(async () => emit({ _tag: "RunFinished", ...at, runIds: ["r1"] }))
    expect(panel.text()).not.toContain("Relay is writing")
    expect(panel.text()).not.toContain("Relay is answering.")
    await panel.unmount()
  })

  it("keeps a refused draft sendable with its own id when no new id can be made, and blocks a new draft", async () => {
    let calls = 0
    const { conversations, emit, sent } = fakeConversations(
      () => Exit.fail(new RelayUnavailableError({ message: "locked", fix: "Stop the other hostd." })),
      {
        ids: () => {
          calls += 1
          return calls === 1 ? Exit.succeed("known-id") : Exit.fail(new SendIdUnavailable())
        }
      }
    )
    const panel = await mount(conversations)
    await act(async () => emit(live))
    await panel.type("What waits?")
    await panel.click("Send")
    // The server's own fix is said, and the message is kept.
    expect(panel.text()).toContain("locked Stop the other hostd.")
    expect(panel.find<HTMLTextAreaElement>("textarea")?.value).toBe("What waits?")
    await panel.click("Send")
    expect(sent.map(({ requestId }) => requestId)).toEqual(["known-id", "known-id"])
    // A changed draft is a new message: it needs a new id, which this browser can't make.
    await panel.type("Something else")
    expect(panel.text()).toContain("This browser can't make request ids")
    expect(sent).toHaveLength(2)
    await panel.unmount()
  })

  it("keeps the message when a send stops without an answer, and clears it only on success", async () => {
    let outcome: Exit.Exit<void, RelayUnavailableError> = Exit.die("page defect")
    const { conversations, emit, sent } = fakeConversations(() => outcome)
    const panel = await mount(conversations)
    await act(async () => emit(live))
    await panel.type("Is anything stuck?")
    await panel.click("Send")
    expect(panel.find<HTMLTextAreaElement>("textarea")?.value).toBe("Is anything stuck?")
    expect(panel.text()).toContain("The request stopped before Relay answered.")
    outcome = Exit.interrupt()
    await panel.click("Send")
    expect(panel.find<HTMLTextAreaElement>("textarea")?.value).toBe("Is anything stuck?")
    outcome = Exit.void
    await panel.click("Send")
    expect(panel.find<HTMLTextAreaElement>("textarea")?.value).toBe("")
    expect(new Set(sent.map(({ requestId }) => requestId)).size).toBe(1)
    await panel.unmount()
  })

  it("blocks Send for an edited draft even when its text returns to the refused one", async () => {
    let calls = 0
    const { conversations, emit, sent } = fakeConversations(
      () => Exit.fail(new RelayUnavailableError({ message: "locked", fix: "Stop the other hostd." })),
      {
        ids: () => {
          calls += 1
          return calls === 1 ? Exit.succeed("known-id") : Exit.fail(new SendIdUnavailable())
        }
      }
    )
    const panel = await mount(conversations)
    await act(async () => emit(live))
    await panel.type("What waits?")
    await panel.click("Send")
    // Edited and put back: useRelayDraft dropped the id with the edit, so this is a new message.
    await panel.type("What waits?!")
    await panel.type("What waits?")
    expect(panel.text()).toContain("This browser can't make request ids")
    expect(sent).toHaveLength(1)
    await panel.unmount()
  })

  it("doesn't make a draft retryable when it was edited while its send was in flight", async () => {
    let calls = 0
    let release: (exit: Exit.Exit<void, RelayUnavailableError>) => void = () => undefined
    const { conversations, emit, sent } = fakeConversations(() => Exit.void, {
      ids: () => {
        calls += 1
        return calls === 1 ? Exit.succeed("known-id") : Exit.fail(new SendIdUnavailable())
      }
    })
    const held: RelayConversations = {
      ...conversations,
      send: (ref, message) => {
        void conversations.send(ref, message)
        return new Promise((resolve) => (release = resolve))
      }
    }
    const panel = await mount(held)
    await act(async () => emit(live))
    await panel.type("What waits?")
    await panel.click("Send")
    // Edited while the send is in flight; then the refusal lands.
    await panel.type("What waits? And job 8?")
    await act(async () => release(Exit.fail(new RelayUnavailableError({ message: "locked", fix: "Stop it." }))))
    expect(panel.text()).toContain("This browser can't make request ids")
    expect(sent).toHaveLength(1)
    await panel.unmount()
  })

  it("says what the backend needs when it can't answer", async () => {
    const { conversations, emit } = fakeConversations(() => Exit.void)
    const panel = await mount(conversations)
    await act(async () => {
      emit(live)
      emit({
        _tag: "Backend",
        status: {
          _tag: "Unavailable",
          backend: "codex-cli",
          label: "Codex",
          cause: "SignedOut",
          fix: "Run codex login."
        }
      })
    })
    expect(panel.text()).toContain("Codex can't answer: Run codex login.")
    await panel.unmount()
  })

  it("lets a confirmation be answered again after its request failed, and shows the state a 409 found", async () => {
    let refuse: RelayRequestFailure | null = new RelayTransportFailed({ reason: "unreachable", status: 0 })
    let stop = false
    const { conversations, decisions, emit } = fakeConversations(() => Exit.void, {
      decide: () => (stop ? Exit.die("page defect") : refuse === null ? Exit.void : Exit.fail(refuse))
    })
    const panel = await mount(conversations)
    await act(async () => {
      emit(live)
      emit({
        _tag: "ConfirmationRequired",
        ...at,
        call: "c1",
        action: { verb: "prompt_agent", target: { product: "herdr", kind: "agent", id: "worker-1" }, args: {} },
        reversible: false
      })
    })
    await panel.press("Prompt agent")
    expect(panel.text()).toContain("The server didn't answer. Answer again.")
    // The card remounted under the pressed button: focus goes to its first action, not the page.
    const focused = document.activeElement
    expect(focused?.tagName).toBe("BUTTON")
    expect(focused?.isConnected).toBe(true)
    expect(focused?.closest('section[role="group"]')).not.toBeNull()
    await panel.click("Prompt agent")
    expect(decisions).toEqual([
      { allow: true, call: "c1" },
      { allow: true, call: "c1" }
    ])
    // A request that stops without an answer can be answered again too.
    refuse = null
    stop = true
    await panel.click("Prompt agent")
    expect(panel.text()).toContain("The request stopped before Relay answered. Answer again.")
    stop = false
    // Answered elsewhere already: the card shows what the server found, and nothing more is sent.
    refuse = new RelayConflictError({ state: { _tag: "Decided", allow: false } })
    await panel.click("Prompt agent")
    expect(decisions).toHaveLength(4)
    expect(panel.find("button")?.textContent).not.toBe("Prompt agent")
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Prompt agent")
    ).toBe(false)
    await panel.unmount()
  })

  it("says how to sign back in, with Retry, when the session no longer opens Relay", async () => {
    const { conversations, emit, retries } = fakeConversations(() => Exit.void)
    const panel = await mount(conversations)
    await act(async () => emit({ _tag: "Unauthorized" }))
    expect(panel.text()).toContain("Sign in again to use Relay")
    expect(panel.text()).toContain("Open the hub from your tailnet again.")
    expect(panel.find("textarea")).toBeNull()
    await panel.click("Retry")
    expect(retries).toEqual([fleet])
    await panel.unmount()
  })

  it("offers Retry when the stream stopped on a frame it couldn't read", async () => {
    const { conversations, emit, retries } = fakeConversations(() => Exit.void)
    const panel = await mount(conversations)
    await act(async () => emit({ _tag: "StreamFailed" }))
    expect(panel.text()).toContain("Relay stopped")
    await panel.click("Retry")
    expect(retries).toEqual([fleet])
    await panel.unmount()
  })
})
