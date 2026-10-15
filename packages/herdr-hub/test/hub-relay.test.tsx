// @vitest-environment happy-dom

import type { ObjectRef } from "@knpkv/relay/wire"
import { PortalProvider } from "@knpkv/rly/foundations"
import {
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConversationListener,
  type RelayConversations,
  type RelayConversationState
} from "@knpkv/relay-product/client"
import { Effect, Exit } from "effect"
import { makeUsageModuleViews } from "../src/usage-module-view.js"
import { limitsFixture, usageFixture } from "./superapp-browser/usage-fixture.js"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HubRelay, watchRelayPage } from "../src/hub-relay.js"
import { FleetShell, keyboardHeight } from "../src/shell-view.js"
import { connectModule } from "../src/modules.js"
import { SuperappShell } from "../src/superapp-view.js"
import { makeFleetModuleViews } from "../src/fleet-module-view.js"

const fleet: ObjectRef = { product: "herdr", kind: "fleet", id: "hub.tail" }

/** A conversation the test drives event by event; nothing reaches a server. */
const fakeConversations = (initial: RelayConversationState = initialRelayConversation) => {
  let state: RelayConversationState = initial
  const listeners = new Set<RelayConversationListener>()
  const calls: Array<string> = []
  const conversations: RelayConversations = {
    cancel: () => Promise.resolve(Exit.void),
    decide: () => Promise.resolve(Exit.void),
    dispose: () => void calls.push("dispose"),
    get: () => state,
    newRequestId: () => Promise.resolve(Exit.succeed("r1")),
    retry: (ref) => void calls.push(`retry ${ref.id}`),
    send: () => Promise.resolve(Exit.void),
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
  const publish = (next: RelayConversationState): void => {
    state = next
    for (const listener of listeners) listener(state, null)
  }
  return { calls, conversations, emit, publish }
}

/** A pagehide or pageshow, kept in the back/forward cache or not. */
const transition = (type: "pagehide" | "pageshow", persisted: boolean): Event => {
  const event = new Event(type)
  Object.defineProperty(event, "persisted", { value: persisted })
  return event
}

const working: RelayClientEvent = {
  _tag: "Snapshot",
  seq: 0,
  session: "s1",
  messages: [],
  runIds: ["r1"],
  queued: []
}

let root: Root | null = null
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
afterEach(async () => {
  const mounted = root
  root = null
  if (mounted !== null) await act(async () => mounted.unmount())
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const mount = async (conversations: RelayConversations) => {
  const host = document.createElement("div")
  document.body.append(host)
  const created = createRoot(host)
  root = created
  await act(async () =>
    created.render(
      <FleetShell
        approvals={<section>APPROVALS</section>}
        connect={<section>CONNECT</section>}
        hostCount={2}
        relay={{ conversation: fleet, conversations }}
        usage={<section>USAGE</section>}
        work={<section>WORK</section>}
      />
    )
  )
  const launcher = (): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>("[data-rly-relay-launcher]")
    if (button === null) throw new Error("no Relay launcher")
    return button
  }
  const panel = () => document.querySelector("[data-rly-relay-panel]")
  /** Ctrl+J, or ⌘J where the launcher says the platform uses it. */
  const shortcut = async () => {
    const apple = launcher().getAttribute("aria-keyshortcuts")?.includes("Meta") ?? false
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: !apple, key: "j", metaKey: apple }))
    })
  }
  const live = () => document.querySelector(".fleet-shell-relay-live")?.textContent ?? null
  return { launcher, live, panel, shortcut }
}

describe("Relay in the hub's masthead", () => {
  /** Empty-state header grouping must not restart the fleet conversation when the route changes. */
  it("retains the launcher and conversation across empty Limits and Tokens", async () => {
    const { conversations } = fakeConversations({ ...initialRelayConversation, connection: "live" })
    const subscribe = vi.spyOn(conversations, "subscribe")
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    window.history.replaceState(null, "", "/?range=7d&timeZone=UTC#usage/limits")
    const usage = makeUsageModuleViews({
      reads: {
        usage: () =>
          Effect.succeed({
            fleet: usageFixture({ range: "7d", timeZone: "UTC" }, 1_000, "empty-readings"),
            receivedAt: 1_000
          }),
        limits: Effect.succeed({ fleet: limitsFixture(1_000, "empty-readings"), receivedAt: 1_000 })
      },
      viewerTimeZone: "UTC",
      now: 1_000,
      onHubMachine: false
    })
    await act(async () =>
      root?.render(
        <SuperappShell
          session={{ access: "loopback", connection: "connected" }}
          modules={[usage]}
          landing={{ module: "usage", page: "limits" }}
          host="hub"
          hostCount={1}
          notifications={null}
          relay={{ conversation: fleet, conversations }}
        />
      )
    )
    expect(document.querySelector('.superapp-shell[data-usage-empty="true"]')).not.toBeNull()
    const launcher = document.querySelector("[data-rly-relay-launcher]")
    const subscriptions = subscribe.mock.calls.length
    const action = document.querySelector<HTMLAnchorElement>('[data-region="action"]')
    expect(action).not.toBeNull()
    await act(async () => action?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })))
    expect(document.querySelector("[data-rly-relay-launcher]")).toBe(launcher)
    expect(subscribe.mock.calls).toHaveLength(subscriptions)
    expect(document.querySelector(".usage-empty-header-region")).toBeNull()
  })
  /** Moving the announcement out of the visual mast preserves live updates and panel announcement ownership. */
  it("keeps status announcements in the supplied shell outlet", async () => {
    const { conversations, emit } = fakeConversations({ ...initialRelayConversation, connection: "live" })
    const host = document.createElement("div")
    const outlet = document.createElement("div")
    document.body.append(host, outlet)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <PortalProvider>
          <HubRelay
            announcementOutlet={outlet}
            relay={{ conversation: fleet, conversations }}
            terminalOwnsKeys={false}
          />
        </PortalProvider>
      )
    )
    expect(host.querySelector(".fleet-shell-relay-live")).toBeNull()
    expect(outlet.querySelector('[aria-live="polite"][role="status"]')).not.toBeNull()
    await act(async () => emit(working))
    expect(outlet.textContent).toContain("Working")
    await act(async () => host.querySelector<HTMLButtonElement>("[data-rly-relay-launcher]")?.click())
    expect(outlet.textContent).toBe("")
    expect(document.querySelector("[data-rly-relay-panel]")).not.toBeNull()
  })
  it.each([undefined, "creature", "chef"] satisfies ReadonlyArray<"creature" | "chef" | undefined>)(
    "selects the launcher mark explicitly, independently of its label: %s",
    async (launcherMark) => {
      const { conversations } = fakeConversations({ ...initialRelayConversation, connection: "live", runIds: ["r1"] })
      const host = document.createElement("div")
      document.body.append(host)
      const created = createRoot(host)
      root = created
      await act(async () =>
        created.render(
          <PortalProvider>
            <HubRelay
              {...(launcherMark === undefined ? {} : { launcherMark })}
              launcherLabels={{ desktop: "Ask Relay", phone: "Relay" }}
              relay={{ conversation: fleet, conversations }}
              terminalOwnsKeys={false}
            />
          </PortalProvider>
        )
      )
      const launcher = host.querySelector<HTMLButtonElement>("[data-rly-relay-launcher]")
      expect(launcher?.getAttribute("aria-label")).toBe("Ask Relay")
      expect(launcher?.querySelectorAll(".relay-chef-mark").length).toBe(launcherMark === "chef" ? 1 : 0)
      expect(launcher?.querySelectorAll("[data-relay-phase]").length).toBe(launcherMark === "chef" ? 0 : 1)
      await act(async () => launcher?.click())
      const panel = document.querySelector("[data-rly-relay-panel]")
      expect(panel?.querySelector(".relay-chef-mark")).toBeNull()
      expect(
        panel?.querySelector("[data-rly-relay-avatar=panel] [data-relay-phase]")?.getAttribute("data-relay-phase")
      ).toBe("thinking")
    }
  )
  it.each([
    { labels: undefined, title: "Relay" },
    { labels: { desktop: "Ask Ops", phone: "Ops" }, title: "Ask Ops" }
  ])("uses the launcher label as the panel title, or keeps the legacy title: $title", async ({ labels, title }) => {
    const { conversations } = fakeConversations({ ...initialRelayConversation, connection: "live" })
    const host = document.createElement("div")
    document.body.append(host)
    const created = createRoot(host)
    root = created
    await act(async () =>
      created.render(
        <PortalProvider>
          <HubRelay
            {...(labels === undefined ? {} : { launcherLabels: labels })}
            relay={{ conversation: fleet, conversations }}
            terminalOwnsKeys={false}
          />
        </PortalProvider>
      )
    )
    const launcher = document.querySelector<HTMLButtonElement>("[data-rly-relay-launcher]")
    expect(launcher).not.toBeNull()
    await act(async () => launcher?.click())
    const panel = document.querySelector("[data-rly-relay-panel]")
    expect(panel).not.toBeNull()
    const titleId = panel?.getAttribute("aria-labelledby")
    expect(titleId).toBeTruthy()
    expect(document.getElementById(titleId ?? "")?.textContent).toBe(title)
  })

  const liveState: RelayConversationState = { ...initialRelayConversation, connection: "live" }
  const activeState: RelayConversationState = { ...liveState, runIds: ["run-1"] }
  const streamingState: RelayConversationState = {
    ...activeState,
    messages: [{ id: "reply-1", role: "relay", text: "An answer", streaming: true }]
  }
  const toolState: RelayConversationState = {
    ...streamingState,
    tools: [
      { call: "call-1", capability: "read", summary: "Reading files", state: "running", receipt: null, after: null }
    ]
  }
  const confirmationState: RelayConversationState = {
    ...toolState,
    confirmations: [
      {
        call: "call-1",
        action: { verb: "prompt_agent", target: fleet, args: {} },
        reversible: false,
        decision: "pending"
      }
    ]
  }
  const failedState: RelayConversationState = { ...liveState, failure: { cause: "Failed", fix: "Retry" } }
  const phases: ReadonlyArray<{
    readonly label: string
    readonly state: RelayConversationState
    readonly phase: string
    readonly bucket: string
    readonly words: string | null
  }> = [
    { label: "connecting", state: initialRelayConversation, phase: "idle", bucket: "ready", words: null },
    { label: "quiet live", state: liveState, phase: "idle", bucket: "ready", words: null },
    {
      label: "disconnected overrides confirmation",
      state: { ...confirmationState, connection: "disconnected" },
      phase: "idle",
      bucket: "ready",
      words: "Relay status unknown"
    },
    {
      label: "failed stream",
      state: { ...confirmationState, connection: "failed" },
      phase: "idle",
      bucket: "ready",
      words: "Relay status unknown"
    },
    {
      label: "unauthorized",
      state: { ...confirmationState, connection: "unauthorized" },
      phase: "idle",
      bucket: "ready",
      words: "Sign in to use Relay"
    },
    {
      label: "confirmation overrides tool",
      state: confirmationState,
      phase: "needs-you",
      bucket: "needs-you",
      words: "Relay needs you"
    },
    { label: "tool overrides streaming", state: toolState, phase: "thinking", bucket: "working", words: "Reading…" },
    { label: "streaming run", state: streamingState, phase: "answering", bucket: "working", words: "Answering…" },
    { label: "run with no text", state: activeState, phase: "thinking", bucket: "working", words: "Working…" },
    {
      label: "queued overrides failure",
      state: { ...failedState, queued: [{ requestId: "queued-1", text: "Question" }] },
      phase: "thinking",
      bucket: "working",
      words: "Sending…"
    },
    { label: "failure", state: failedState, phase: "idle", bucket: "ready", words: "Relay hit an error" },
    {
      label: "backend signed out",
      state: {
        ...failedState,
        backend: { _tag: "Unavailable", backend: "codex-cli", label: "Backend", cause: "SignedOut", fix: "Sign in" }
      },
      phase: "idle",
      bucket: "ready",
      words: "Sign in to Backend"
    },
    {
      label: "unread reply",
      state: { ...liveState, messages: [{ id: "reply-1", role: "relay", text: "Finished", streaming: false }] },
      phase: "idle",
      bucket: "ready",
      words: "Relay replied"
    }
  ]
  it.each(phases)(
    "renders the intended character for $label without changing status words",
    async ({ bucket, phase, state, words }) => {
      const { conversations, publish } = fakeConversations(liveState)
      const page = await mount(conversations)
      await act(async () => publish(state))
      const avatar = page.launcher().querySelector("[data-relay-phase]")
      expect(avatar?.getAttribute("data-relay-phase")).toBe(phase)
      expect(avatar?.querySelector("svg")?.getAttribute("data-bucket")).toBe(bucket)
      expect(page.live()).toBe(words ?? "")
    }
  )

  it.each(phases)("keeps the shell Chef static and the status authoritative for $label", async ({ state, words }) => {
    const { conversations, publish } = fakeConversations(liveState)
    const host = document.createElement("div")
    document.body.append(host)
    const created = createRoot(host)
    root = created
    await act(async () =>
      created.render(
        <PortalProvider>
          <HubRelay launcherMark="chef" relay={{ conversation: fleet, conversations }} terminalOwnsKeys={false} />
        </PortalProvider>
      )
    )
    await act(async () => publish(state))
    const launcher = host.querySelector("[data-rly-relay-launcher]")
    expect(launcher?.querySelectorAll(".relay-chef-mark")).toHaveLength(1)
    expect(launcher?.querySelector("[data-relay-phase]")).toBeNull()
    expect(host.querySelector(".fleet-shell-relay-live")?.textContent).toBe(words ?? "")
  })

  it("uses the listening pose only while the composer is focused and clears it on close", async () => {
    const { conversations } = fakeConversations({ ...initialRelayConversation, connection: "live" })
    const page = await mount(conversations)
    const pose = () => page.launcher().querySelector("[data-relay-phase]")?.getAttribute("data-relay-phase")
    expect(pose()).toBe("idle")
    await page.shortcut()
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
    expect(pose()).toBe("listening")
    expect(page.launcher().querySelector("svg")?.getAttribute("data-bucket")).toBe("ready")
    expect(page.panel()?.textContent).toContain("Listening")
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
    })
    expect(page.panel()).toBeNull()
    expect(pose()).toBe("idle")
  })

  it("keeps one launcher and the open conversation across every Fleet route", async () => {
    const { conversations } = fakeConversations()
    const views = makeFleetModuleViews({
      approvals: <p>Approvals</p>,
      connect: <p>Connect</p>,
      work: <p>Work</p>,
      usage: <p>Usage</p>,
      hostCount: 1,
      notice: null,
      gesture: {
        onTouchStart: () => undefined,
        onTouchMove: () => undefined,
        onTouchEnd: () => undefined,
        onTouchCancel: () => undefined
      }
    })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const created = root
    await act(async () =>
      created.render(
        <SuperappShell
          session={{ access: "tailscale", connection: "connected" }}
          modules={[views]}
          landing={{ module: "fleet", page: "approvals" }}
          host="hub"
          hostCount={1}
          notifications={null}
          relay={{ conversation: fleet, conversations }}
        />
      )
    )
    const launcher = document.querySelector<HTMLButtonElement>("[data-rly-relay-launcher]")
    await act(async () => launcher?.click())
    const conversation = document.querySelector("[data-rly-relay-panel]")
    expect(conversation).not.toBeNull()
    for (const page of ["connect", "work", "usage", "approvals"]) {
      await act(async () => {
        window.location.hash = `#fleet/${page}`
        window.dispatchEvent(new HashChangeEvent("hashchange"))
      })
      expect(document.querySelectorAll("[data-rly-relay-launcher]")).toHaveLength(1)
      expect(document.querySelector("[data-rly-relay-launcher]")).toBe(launcher)
      expect(document.querySelectorAll("[data-rly-relay-panel]")).toHaveLength(1)
      expect(document.querySelector("[data-rly-relay-panel]")).toBe(conversation)
    }
  })

  it("starts the overlay below the masthead's visible bottom", async () => {
    const rect = (bottom: number) => DOMRect.fromRect({ height: bottom, width: 1280, x: 0, y: 0 })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return rect(this.classList.contains("fleet-shell-masthead") ? 65 : 0)
    })
    const { conversations } = fakeConversations()
    await mount(conversations)
    const shell = document.querySelector<HTMLElement>(".fleet-shell")
    expect(shell?.style.getPropertyValue("--rly-relay-panel-offset")).toBe("65px")
  })

  it("moves the overlay with the masthead when only the masthead resizes, and to the top once it scrolls away", async () => {
    let bottom = 65
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return DOMRect.fromRect({
        height: 0,
        width: 1280,
        x: 0,
        y: this.classList.contains("fleet-shell-masthead") ? bottom : 0
      })
    })
    // A ResizeObserver the test drives, so a resize reaches only the boxes it names.
    const observers: Array<ControlledResizeObserver> = []
    class ControlledResizeObserver implements ResizeObserver {
      readonly targets = new Set<Element>()
      readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        observers.push(this)
      }
      observe(target: Element) {
        this.targets.add(target)
      }
      unobserve(target: Element) {
        this.targets.delete(target)
      }
      disconnect() {
        this.targets.clear()
      }
    }
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver)
    const { conversations } = fakeConversations()
    await mount(conversations)
    const shell = document.querySelector<HTMLElement>(".fleet-shell")
    const masthead = document.querySelector(".fleet-shell-masthead")
    expect(shell?.style.getPropertyValue("--rly-relay-panel-offset")).toBe("65px")
    const resize = async (target: Element) => {
      await act(async () => {
        for (const observer of observers) {
          if (observer.targets.has(target)) observer.callback([], observer)
        }
        await new Promise((resolve) => window.requestAnimationFrame(resolve))
      })
    }
    if (masthead === null) throw new Error("no masthead")
    bottom = 90
    await resize(masthead)
    expect(shell?.style.getPropertyValue("--rly-relay-panel-offset")).toBe("90px")
    bottom = -40
    await resize(masthead)
    expect(shell?.style.getPropertyValue("--rly-relay-panel-offset")).toBe("0px")
  })

  it("keeps the streams of a page the browser caches, and reopens them when it comes back", () => {
    const { calls, conversations } = fakeConversations()
    const stop = watchRelayPage(window, { conversation: fleet, conversations })
    window.dispatchEvent(transition("pagehide", true))
    expect(calls).toEqual([])
    window.dispatchEvent(transition("pageshow", true))
    expect(calls).toEqual(["retry hub.tail"])
    // The first load's pageshow isn't a return from the cache.
    window.dispatchEvent(transition("pageshow", false))
    window.dispatchEvent(transition("pagehide", false))
    expect(calls).toEqual(["retry hub.tail", "dispose"])
    stop()
  })

  it("measures the keyboard as the layout viewport below the visual one, and not while zoomed", () => {
    const view = (height: number, offsetTop: number, scale: number) => ({
      innerHeight: 800,
      visualViewport: { height, offsetTop, scale }
    })
    expect(keyboardHeight(view(800, 0, 1))).toBe(0)
    expect(keyboardHeight(view(470, 0, 1))).toBe(330)
    // Scrolled while the keyboard shows: what lies below the visual viewport.
    expect(keyboardHeight(view(470, 120, 1))).toBe(210)
    expect(keyboardHeight(view(400, 0, 2))).toBe(0)
    expect(keyboardHeight({ innerHeight: 800, visualViewport: null })).toBe(0)
  })

  it("makes the brand Relay's launcher, opened by a click or the shortcut and closed with Escape", async () => {
    const { conversations } = fakeConversations()
    const page = await mount(conversations)
    expect(page.launcher().textContent).toContain("Relay")
    expect(page.launcher().getAttribute("aria-expanded")).toBe("false")
    expect(page.launcher().getAttribute("aria-keyshortcuts")).toMatch(/^(Control|Meta)\+J$/)
    expect(page.panel()).toBeNull()

    // The shortcut opens Relay with focus in its composer, so Escape there closes it.
    await page.shortcut()
    expect(page.launcher().getAttribute("aria-expanded")).toBe("true")
    expect(page.panel()?.contains(document.activeElement)).toBe(true)
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
    })
    expect(page.panel()).toBeNull()

    await act(async () => page.launcher().click())
    expect(page.panel()).not.toBeNull()
  })

  it("leaves Ctrl/⌘+J to the terminal while Connect shows, and says no shortcut there", async () => {
    const { conversations } = fakeConversations()
    // Opened on Connect, the way its ?tab= link opens it.
    window.history.replaceState(null, "", "/?tab=connect")
    const page = await mount(conversations)
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Connect")
    expect(page.launcher().hasAttribute("aria-keyshortcuts")).toBe(false)
    expect(page.launcher().querySelector("kbd")).toBeNull()
    await page.shortcut()
    expect(page.panel()).toBeNull()
    // The launcher itself still opens Relay there.
    await act(async () => page.launcher().click())
    expect(page.panel()).not.toBeNull()
  })

  it("announces a run once when it starts working, not at every tool boundary, and again when it needs you", async () => {
    const { conversations, emit } = fakeConversations()
    const page = await mount(conversations)
    const at = { seq: 0, session: "s1" }
    const visible = () => document.querySelector(".fleet-shell-relay-status")?.textContent ?? ""
    await act(async () => emit(working))
    expect(page.live()).toBe("Working…")
    await act(async () =>
      emit({ _tag: "ToolStarted", ...at, call: "t1", capability: "list_agents", summary: "Reading agents", input: {} })
    )
    // The words beside the mark follow the run; the live region doesn't repeat them.
    expect(visible()).toContain("Reading…")
    expect(page.live()).toBe("Working…")
    await act(async () =>
      emit({ _tag: "ToolFinished", ...at, call: "t1", ok: true, summary: "Read agents", cites: [] })
    )
    await act(async () =>
      emit({ _tag: "ToolStarted", ...at, call: "t2", capability: "get_job", summary: "Reading job 7", input: {} })
    )
    expect(page.live()).toBe("Working…")
    await act(async () =>
      emit({
        _tag: "ConfirmationRequired",
        ...at,
        call: "c1",
        action: { verb: "prompt_agent", target: fleet, args: {} },
        reversible: false
      })
    )
    expect(page.live()).toBe("Relay needs you")
  })

  it("announces the run a queued message starts, and each new run", async () => {
    const { conversations, emit } = fakeConversations()
    const page = await mount(conversations)
    const at = { seq: 0, session: "s1" }
    await act(async () => emit({ _tag: "Snapshot", ...at, messages: [], runIds: [], queued: [] }))
    await act(async () => emit({ _tag: "MessageQueued", ...at, requestId: "q1" }))
    expect(page.live()).toBe("Sending…")
    await act(async () => {
      emit({ _tag: "MessagePlaced", ...at, id: "m1", requestId: "q1", text: "Status?" })
      emit({ _tag: "RunStarted", ...at, runIds: ["q1"] })
    })
    expect(page.live()).toBe("Working…")
    await act(async () => {
      emit({ _tag: "RunFinished", ...at, runIds: ["q1"] })
      emit({ _tag: "MessagePlaced", ...at, id: "m2", requestId: "q2", text: "And now?" })
      emit({ _tag: "RunStarted", ...at, runIds: ["q2"] })
      emit({ _tag: "ToolStarted", ...at, call: "t1", capability: "list_agents", summary: "Reading agents", input: {} })
    })
    // A new run, already reading when it is first seen: announced in its own words.
    expect(page.live()).toBe("Reading…")
  })

  it("says a second run again even when its words are the same, and stays silent between its tools", async () => {
    const { conversations, emit } = fakeConversations()
    const page = await mount(conversations)
    const at = { seq: 0, session: "s1" }
    await act(async () => emit(working))
    const region = document.querySelector(".fleet-shell-relay-live")
    if (region === null) throw new Error("no live region")
    let changes = 0
    const observer = new MutationObserver((records) => {
      changes += records.length
    })
    observer.observe(region, { characterData: true, childList: true, subtree: true })
    // Tools within the run: the words beside the mark change, the region doesn't.
    await act(async () =>
      emit({ _tag: "ToolStarted", ...at, call: "t1", capability: "list_agents", summary: "Reading agents", input: {} })
    )
    await act(async () =>
      emit({ _tag: "ToolFinished", ...at, call: "t1", ok: true, summary: "Read agents", cites: [] })
    )
    await Promise.resolve()
    expect(changes).toBe(0)
    await act(async () => {
      emit({ _tag: "RunFinished", ...at, runIds: ["r1"] })
      emit({ _tag: "RunStarted", ...at, runIds: ["r2"] })
    })
    await Promise.resolve()
    expect(page.live()).toBe("Working…")
    expect(changes).toBeGreaterThan(0)
    observer.disconnect()
  })

  it("announces Relay's status only while the panel is closed; the transcript speaks once it is open", async () => {
    const { conversations, emit } = fakeConversations()
    const page = await mount(conversations)
    await act(async () => emit(working))
    expect(page.live()).toBe("Working…")
    await act(async () => page.launcher().click())
    expect(page.live()).toBe("")
  })
})

/** Home offers summon keys; only its actual connected terminal reserves them. */
it.each([false, true])(
  "Connect Home reserves Relay summon keys only when terminalOwnsKeys=%s",
  async (terminalOwnsKeys) => {
    const { conversations } = fakeConversations()
    window.history.replaceState(null, "", "/#connect/overview")
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const created = root
    await act(async () =>
      created.render(
        <SuperappShell
          modules={[{ descriptor: connectModule, pages: { overview: () => <h1>Connect</h1> } }]}
          landing={{ module: "connect", page: "overview" }}
          host="hub"
          hostCount={1}
          session={{ access: "tailscale", connection: "connected" }}
          notifications={null}
          terminalOwnsKeys={terminalOwnsKeys}
          relay={{ conversation: fleet, conversations }}
        />
      )
    )
    const launcher = document.querySelector<HTMLButtonElement>("[data-rly-relay-launcher]")
    expect(launcher?.hasAttribute("aria-keyshortcuts")).toBe(!terminalOwnsKeys)
    const key = launcher?.getAttribute("aria-keyshortcuts")?.includes("Meta") === true ? "Meta" : "Control"
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: key === "Control", metaKey: key === "Meta", bubbles: true })
      )
    )
    expect(document.querySelector("[data-rly-relay-panel]") !== null).toBe(!terminalOwnsKeys)
  }
)
