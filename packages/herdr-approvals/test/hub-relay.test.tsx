// @vitest-environment happy-dom

import type { ObjectRef } from "@knpkv/relay/wire"
import {
  foldRelayConversation,
  initialRelayConversation,
  type RelayClientEvent,
  type RelayConversationListener,
  type RelayConversations,
  type RelayConversationState
} from "@knpkv/relay-product/client"
import { Exit } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { watchRelayPage } from "../src/hub-relay.js"
import { FleetShell, keyboardHeight } from "../src/shell-view.js"

const fleet: ObjectRef = { product: "herdr", kind: "fleet", id: "hub.tail" }

/** A conversation the test drives event by event; nothing reaches a server. */
const fakeConversations = () => {
  let state: RelayConversationState = initialRelayConversation
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
  return { calls, conversations, emit }
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

  it("announces Relay's status only while the panel is closed; the transcript speaks once it is open", async () => {
    const { conversations, emit } = fakeConversations()
    const page = await mount(conversations)
    await act(async () => emit(working))
    expect(page.live()).toBe("Working…")
    await act(async () => page.launcher().click())
    expect(page.live()).toBe("")
  })
})
