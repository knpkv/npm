// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { Predicate, Schema } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import type { NotificationState } from "../src/approval-app-view.js"
import { BlockedConnectSurface } from "../src/blocked-connect-surface.js"
import type { BlockedPushSettings } from "../src/blocked-push-model.js"
import { applyBlockedPushMutation, BlockedPushMutation, StageHeartbeat } from "../src/blocked-push-model.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}
window.IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<Root> = []
const originalFetch = window.fetch
let fetchHandler: typeof window.fetch = originalFetch
window.fetch = (...args) => fetchHandler(...args)
afterAll(() => {
  window.fetch = originalFetch
})
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.localStorage.clear()
  fetchHandler = originalFetch
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 24; index += 1) await Promise.resolve()
  })
}

describe("canonical Connect stage notifications", () => {
  it("reports only a visible open stage and clears viewing when hidden or closed", async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    const heartbeats: Array<typeof StageHeartbeat.Type> = []
    fetchHandler = async (input, init) => {
      const url = Predicate.isString(input) ? input : "href" in input ? input.href : input.url
      const path = new URL(url, "http://localhost").pathname
      if (path === "/v1/push/stage-heartbeat") {
        const body = await new Response(init?.body).text()
        heartbeats.push(Schema.decodeUnknownSync(Schema.fromJsonString(StageHeartbeat))(body))
        return new Response(JSON.stringify({ accepted: true }))
      }
      if (path === "/v1/push/blocked-settings")
        return new Response(JSON.stringify({ mutedAgents: [], quietHours: null }))
      if (path === "/v1/connect/agents")
        return new Response(
          JSON.stringify({
            agents: [
              {
                host: "HOST-A",
                id: "agent-one",
                name: "worker",
                kind: "codex",
                state: "blocked",
                work: "project",
                lastActivityAt: 0
              }
            ],
            failures: [],
            nextCursor: null
          })
        )
      return new Response("{}", { status: 404 })
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <BlockedConnectSurface atoms={makeConnectAtoms()} />
        </RegistryProvider>
      )
    )
    await settle()
    expect(heartbeats).toEqual([])
    await act(async () => host.querySelector<HTMLButtonElement>(".connect-agent")?.click())
    await settle()
    expect(heartbeats.at(-1)?.target).toEqual({ host: "HOST-A", agentId: "agent-one" })
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("Mute this agent")
    expect(document.querySelector("[role='dialog']")?.textContent).not.toContain("Quiet hours")
    expect(document.querySelector("[aria-label='Agent notifications']")?.textContent).toContain("Notifications")
    visibility.mockReturnValue("hidden")
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await settle()
    expect(heartbeats.at(-1)?.target).toBeNull()
    const count = heartbeats.length
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(heartbeats).toHaveLength(count)
    visibility.mockReturnValue("visible")
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await settle()
    expect(heartbeats.at(-1)?.target).toEqual({ host: "HOST-A", agentId: "agent-one" })
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await settle()
    expect(heartbeats.at(-1)?.target).toBeNull()
  })
})

interface SettingsBackend {
  settings: BlockedPushSettings
}

const openStage = async (
  initialSettings: BlockedPushSettings = { mutedAgents: [], quietHours: null },
  state: NotificationState | null = "enabled",
  registered = true,
  options: { readonly agentId?: string; readonly backend?: SettingsBackend; readonly push?: boolean } = {}
) => {
  const writes: Array<BlockedPushSettings> = []
  const mutations: Array<BlockedPushMutation> = []
  const backend = options.backend ?? { settings: initialSettings }
  let rejectSave = false
  let rejectOnce = false
  let heldSave: Promise<void> | null = null
  fetchHandler = async (input, init) => {
    const url = Predicate.isString(input) ? input : "href" in input ? input.href : input.url
    const path = new URL(url, "http://localhost").pathname
    if (path === "/v1/push/blocked-settings") {
      if (
        (init?.method ?? (Predicate.isString(input) || "href" in input ? "GET" : input.method)).toUpperCase() ===
        "PATCH"
      ) {
        const mutation = Schema.decodeUnknownSync(Schema.fromJsonString(BlockedPushMutation))(
          await new Response(init?.body).text()
        )
        mutations.push(mutation)
        writes.push(applyBlockedPushMutation(backend.settings, mutation))
        const held = heldSave
        heldSave = null
        if (held !== null) await held
        if (rejectSave || rejectOnce) {
          rejectOnce = false
          return new Response("{}", { status: 503 })
        }
        backend.settings = applyBlockedPushMutation(backend.settings, mutation)
        return new Response(JSON.stringify(backend.settings))
      }
      return new Response(JSON.stringify(backend.settings))
    }
    if (path === "/v1/push/config")
      return new Response(JSON.stringify({ canonicalUrl: "http://localhost/", enabled: true, publicKey: "AQID" }))
    if (path === "/v1/push/subscriptions") return new Response(JSON.stringify({ subscribed: registered }))
    if (path === "/v1/push/stage-heartbeat") return new Response(JSON.stringify({ accepted: true }))
    if (path === "/v1/connect/agents")
      return new Response(
        JSON.stringify({
          agents: [
            {
              host: "HOST-A",
              id: options.agentId ?? "agent-one",
              name: "worker",
              kind: "codex",
              state: "blocked",
              work: "project",
              lastActivityAt: 0
            }
          ],
          failures: [],
          nextCursor: null
        })
      )
    return new Response("{}", { status: 404 })
  }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      <RegistryProvider>
        {state === null ? (
          <BlockedConnectSurface atoms={makeConnectAtoms()} />
        ) : (
          <BlockedConnectSurface atoms={makeConnectAtoms()} notificationState={state} push={options.push ?? true} />
        )}
      </RegistryProvider>
    )
  )
  await settle()
  await act(async () => host.querySelector<HTMLButtonElement>(".connect-agent")?.click())
  await settle()
  return {
    writes,
    mutations,
    holdNextSave: () => {
      const gate = Promise.withResolvers<void>()
      heldSave = gate.promise
      return gate.resolve
    },
    rejectSaves: () => {
      rejectSave = true
    },
    rejectNextSave: () => {
      rejectOnce = true
    }
  }
}

const muteButton = () =>
  document.querySelector<HTMLButtonElement>("[aria-label='Agent notifications'] button[aria-pressed]")

describe("stage notification controls", () => {
  it("saves the selected agent mute and renders its saved state without affecting other agents", async () => {
    const fixture = await openStage({ mutedAgents: [{ host: "HOST-B", agentId: "agent-other" }], quietHours: null })
    expect(muteButton()?.textContent).toBe("Mute this agent")
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("false")
    await act(async () => muteButton()?.click())
    await settle()
    expect(fixture.writes).toEqual([
      {
        mutedAgents: [
          { host: "HOST-B", agentId: "agent-other" },
          { host: "HOST-A", agentId: "agent-one" }
        ],
        quietHours: null
      }
    ])
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("true")
    const summary = document.querySelector(".connect-stage-notification-summary")
    expect(summary?.textContent).toBe("Muted, you won’t get pushes from worker")
    await act(async () => muteButton()?.click())
    await settle()
    expect(fixture.writes.at(-1)?.mutedAgents).toEqual([{ host: "HOST-B", agentId: "agent-other" }])
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("false")
  })
  it.each([1, 2])("applies %i rapid mute toggles against the latest queued desired state", async (clicks) => {
    const fixture = await openStage()
    const release = fixture.holdNextSave()
    try {
      await act(async () => muteButton()?.click())
      await settle()
      expect(fixture.mutations).toEqual([
        {
          _tag: "SetAgentMute",
          agent: { host: "HOST-A", agentId: "agent-one" },
          muted: true
        }
      ])
      if (clicks === 2) {
        await act(async () => muteButton()?.click())
        await settle()
      }
      expect(fixture.mutations).toHaveLength(1)
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(fixture.mutations).toEqual(
      clicks === 1
        ? [
            {
              _tag: "SetAgentMute",
              agent: { host: "HOST-A", agentId: "agent-one" },
              muted: true
            }
          ]
        : [
            { _tag: "SetAgentMute", agent: { host: "HOST-A", agentId: "agent-one" }, muted: true },
            { _tag: "SetAgentMute", agent: { host: "HOST-A", agentId: "agent-one" }, muted: false }
          ]
    )
    expect(muteButton()?.getAttribute("aria-pressed")).toBe(clicks === 1 ? "true" : "false")
  })

  it("preserves independent devices' agent mutes and quiet hours when their snapshots are stale", async () => {
    const backend: SettingsBackend = { settings: { mutedAgents: [], quietHours: null } }
    await openStage(undefined, "enabled", true, { backend, agentId: "agent-one" })
    await openStage(undefined, "enabled", true, { backend, agentId: "agent-two" })
    const panels = document.querySelectorAll("[aria-label='Agent notifications']")
    expect(panels).toHaveLength(2)
    const first = panels[0]
    const second = panels[1]
    await act(async () => first?.querySelector<HTMLButtonElement>("button[aria-pressed]")?.click())
    await settle()
    await act(async () => {
      const from = first?.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
      const until = first?.querySelector<HTMLInputElement>("input[aria-label='Quiet hours until']")
      if (from !== null && from !== undefined && until !== null && until !== undefined) {
        from.value = "22:00"
        until.value = "07:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
        until.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    await act(async () => first?.querySelector("input")?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    await settle()
    const quietHours = backend.settings.quietHours
    expect(quietHours).not.toBeNull()
    await act(async () => second?.querySelector<HTMLButtonElement>("button[aria-pressed]")?.click())
    await settle()
    expect(backend.settings).toEqual({
      mutedAgents: [
        { host: "HOST-A", agentId: "agent-one" },
        { host: "HOST-A", agentId: "agent-two" }
      ],
      quietHours
    })
    await act(async () => second?.querySelector<HTMLButtonElement>("button[aria-pressed]")?.click())
    await settle()
    expect(backend.settings).toEqual({ mutedAgents: [{ host: "HOST-A", agentId: "agent-one" }], quietHours })
  })
  it("saves quiet hours in the user's zone only after both times are valid, then clears them", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      locale: "en",
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "Europe/Berlin",
      year: "numeric"
    })
    const fixture = await openStage()
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    const until = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours until']")
    expect(from?.value).toBe("")
    expect(until?.value).toBe("")
    await act(async () => {
      if (from !== null) {
        from.value = "22:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    await act(async () => from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    await settle()
    expect(fixture.writes).toEqual([])
    await act(async () => {
      if (until !== null) {
        until.value = "07:00"
        until.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    await act(async () => until?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    await settle()
    expect(fixture.writes.at(-1)).toEqual({
      mutedAgents: [],
      quietHours: { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
    })
    expect(document.querySelector("[aria-label='Agent notifications']")?.textContent).toContain(
      "Quiet 22:00–07:00 Europe/Berlin"
    )
    await act(async () => document.querySelector<HTMLButtonElement>(".connect-stage-notification-clear")?.click())
    await settle()
    expect(fixture.writes.at(-1)?.quietHours).toBeNull()
    expect(document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")?.value).toBe("")
    expect(document.querySelector("[aria-label='Agent notifications']")?.textContent).toContain(
      "Pushes on, no quiet hours"
    )
  })
  it.each([
    { dismissal: "backdrop", end: "07:00", saves: 1 },
    { dismissal: "blur then backdrop", end: "07:00", saves: 1 },
    { dismissal: "Close", end: "07:00", saves: 1 },
    { dismissal: "blur then Close", end: "07:00", saves: 1 },
    { dismissal: "Close", end: "", saves: 0 },
    { dismissal: "Escape", end: "07:00", saves: 0 },
    { dismissal: "backdrop", end: "", saves: 0 }
  ])("dismisses via $dismissal with Until=$end and saves $saves complete drafts", async ({ dismissal, end, saves }) => {
    const fixture = await openStage()
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    const until = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours until']")
    expect(from).not.toBeNull()
    expect(until).not.toBeNull()
    await act(async () => {
      if (from !== null) {
        from.focus()
        from.value = "22:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
      }
      if (until !== null) {
        until.focus()
        until.value = end
        until.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    expect(document.activeElement).toBe(until)
    expect(fixture.mutations).toHaveLength(0)
    const release = fixture.holdNextSave()
    try {
      if (dismissal === "blur then backdrop" || dismissal === "blur then Close") {
        await act(async () => until?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
        await settle()
        expect(fixture.mutations).toHaveLength(1)
      }
      await act(async () => {
        if (dismissal === "Escape") {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        } else if (dismissal === "Close" || dismissal === "blur then Close") {
          document.querySelector<HTMLButtonElement>("[role='dialog'] button[aria-label='Close']")?.click()
        } else {
          document
            .querySelector("[data-rly-sheet-overlay]")
            ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }))
        }
      })
      await settle()
      expect(document.querySelector("[role='dialog']")).toBeNull()
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(fixture.mutations).toEqual(
      saves === 0
        ? []
        : [
            {
              _tag: "SetQuietHours",
              quietHours: {
                startMinute: 1320,
                endMinute: 420,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
              }
            }
          ]
    )
  })

  it.each(["backdrop", "Close"])(
    "does not restore saved time fields when dismissing via %s during a pending Clear",
    async (dismissal) => {
      const fixture = await openStage({
        mutedAgents: [],
        quietHours: {
          startMinute: 1320,
          endMinute: 420,
          timeZone: "Europe/Berlin"
        }
      })
      const release = fixture.holdNextSave()
      try {
        await act(async () => document.querySelector<HTMLButtonElement>(".connect-stage-notification-clear")?.click())
        await settle()
        expect(fixture.mutations).toEqual([{ _tag: "SetQuietHours", quietHours: null }])
        await act(async () => {
          if (dismissal === "Close") {
            document.querySelector<HTMLButtonElement>("[role='dialog'] button[aria-label='Close']")?.click()
          } else {
            document
              .querySelector("[data-rly-sheet-overlay]")
              ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }))
          }
        })
        await settle()
      } finally {
        await act(async () => release())
        await settle()
      }
      expect(fixture.mutations).toEqual([{ _tag: "SetQuietHours", quietHours: null }])
      expect(fixture.writes.at(-1)?.quietHours).toBeNull()
    }
  )

  it("omits controls when push is off and links to Approvals", async () => {
    await openStage(undefined, "disabled")
    const panel = document.querySelector("[aria-label='Agent notifications']")
    expect(panel?.textContent).toContain("Notifications are off on this device")
    expect(panel?.querySelector("button")).toBeNull()
    expect(panel?.querySelector("input")).toBeNull()
    const link = panel?.querySelector<HTMLAnchorElement>("a")
    expect(link?.textContent).toContain("Turn on notifications in Approvals")
    expect(link?.getAttribute("href")).toBe("/?#fleet/approvals")
  })
  /** Off the notification hub there is nothing to turn on here, and a standalone computer has no Approvals. */
  it("shows no notifications panel in the stage off the notification hub", async () => {
    await openStage(undefined, "disabled", true, { push: false })
    expect(document.querySelector(".connect-agent-stage, [role='dialog']")).not.toBeNull()
    expect(document.querySelector("[aria-label='Agent notifications']")).toBeNull()
    expect(document.querySelector("a[href*='fleet/approvals']")).toBeNull()
  })
  it("keeps the off-device link arrow decorative and separate from its text", async () => {
    await openStage(undefined, "disabled")
    const link = document.querySelector<HTMLAnchorElement>(".connect-stage-notification-off a")
    expect(link?.textContent).toBe("Turn on notifications in Approvals")
    expect(link?.querySelector(":scope > span")?.textContent).toBe("Turn on notifications in Approvals")
    expect(link?.querySelector(":scope > svg")?.getAttribute("aria-hidden")).toBe("true")
  })
  it("uses the plain decorative dash for an off-device state", async () => {
    await openStage(undefined, "disabled")
    const mark = document.querySelector(".connect-stage-notification-off-mark")
    expect(mark?.tagName.toLowerCase()).toBe("svg")
    expect(mark?.getAttribute("aria-hidden")).toBe("true")
    expect(mark?.querySelector("circle")).toBeNull()
    expect(mark?.textContent).toBe("")
  })
  it("checks the standalone device subscription before showing push controls", async () => {
    vi.stubGlobal("isSecureContext", true)
    vi.stubGlobal("Notification", { permission: "granted" })
    vi.stubGlobal("PushManager", function PushManager() {})
    vi.stubGlobal("navigator", {
      language: "en",
      userAgent: "browser",
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({
              endpoint: "https://push.example/subscription",
              options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }
            })
          }
        })
      }
    })
    await openStage(undefined, null)
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("false")
  })
  it("keeps the last saved mute and quiet hours after rejected changes and shows the error", async () => {
    const fixture = await openStage({
      mutedAgents: [],
      quietHours: { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
    })
    await act(async () => muteButton()?.click())
    await settle()
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("true")
    fixture.rejectSaves()
    await act(async () => muteButton()?.click())
    await settle()
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("true")
    expect(document.querySelector("[aria-label='Agent notifications']")?.textContent).toContain(
      "Couldn't save notification settings."
    )
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    expect(from?.value).toBe("22:00")
    await act(async () => {
      if (from !== null) {
        from.value = "23:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    await act(async () => from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    await settle()
    expect(fixture.writes.at(-1)?.quietHours?.startMinute).toBe(1380)
    expect(document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")?.value).toBe("22:00")
    await act(async () => document.querySelector<HTMLButtonElement>(".connect-stage-notification-clear")?.click())
    await settle()
    expect(document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")?.value).toBe("22:00")
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("true")
  })
  it.each([null, new Uint8Array([3, 2, 1]).buffer])(
    "treats a registered device with an older or missing push key as off",
    async (applicationServerKey) => {
      vi.stubGlobal("isSecureContext", true)
      vi.stubGlobal("Notification", { permission: "granted" })
      vi.stubGlobal("PushManager", function PushManager() {})
      const unsubscribe = vi.fn(async () => true)
      const subscribe = vi.fn()
      vi.stubGlobal("navigator", {
        language: "en",
        userAgent: "browser",
        serviceWorker: {
          getRegistration: async () => ({
            pushManager: {
              subscribe,
              getSubscription: async () => ({
                endpoint: "https://push.example/subscription",
                options: { applicationServerKey },
                unsubscribe
              })
            }
          })
        }
      })
      const fixture = await openStage(undefined, null, true)
      const panel = document.querySelector("[aria-label='Agent notifications']")
      expect(muteButton()).toBeNull()
      expect(panel?.textContent).toContain("Notifications are off on this device")
      expect(panel?.querySelector("a")?.getAttribute("href")).toBe("/?#fleet/approvals")
      expect(fixture.writes).toEqual([])
      expect(unsubscribe).not.toHaveBeenCalled()
      expect(subscribe).not.toHaveBeenCalled()
    }
  )
  it("omits controls for a standalone device whose subscription is not registered", async () => {
    vi.stubGlobal("isSecureContext", true)
    vi.stubGlobal("Notification", { permission: "granted" })
    vi.stubGlobal("PushManager", function PushManager() {})
    vi.stubGlobal("navigator", {
      language: "en",
      userAgent: "browser",
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: {
            getSubscription: async () => ({
              endpoint: "https://push.example/subscription",
              options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }
            })
          }
        })
      }
    })
    await openStage(undefined, null, false)
    expect(muteButton()).toBeNull()
    expect(document.querySelector("[aria-label='Agent notifications']")?.textContent).toContain(
      "Notifications are off on this device"
    )
  })
  it("shows a failed device check without pretending push is enabled or off", async () => {
    await openStage(undefined, "error")
    const panel = document.querySelector("[aria-label='Agent notifications']")
    expect(panel?.textContent).toContain("Couldn't check notifications on this device.")
    expect(panel?.textContent).not.toContain("Notifications are off on this device")
    expect(muteButton()).toBeNull()
  })

  it("applies a queued mute after a rejected blur without changing saved quiet hours", async () => {
    const quietHours = { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
    const fixture = await openStage({ mutedAgents: [], quietHours })
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    await act(async () => {
      if (from !== null) {
        from.value = "23:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    fixture.rejectNextSave()
    const release = fixture.holdNextSave()
    try {
      await act(async () => from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
      await settle()
      await act(async () => muteButton()?.click())
      await settle()
      expect(fixture.writes).toHaveLength(1)
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(fixture.writes).toHaveLength(2)
    expect(fixture.writes.at(-1)).toEqual({
      mutedAgents: [{ host: "HOST-A", agentId: "agent-one" }],
      quietHours
    })
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("true")
    expect(from?.value).toBe("22:00")
  })

  it("keeps editor focus between times and across an Enter save without replacing inputs", async () => {
    const fixture = await openStage({
      mutedAgents: [],
      quietHours: {
        startMinute: 1320,
        endMinute: 420,
        timeZone: "Europe/Berlin"
      }
    })
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    const until = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours until']")
    await act(async () => {
      from?.focus()
      if (from !== null) {
        from.value = "23:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    await act(async () => until?.focus())
    await settle()
    expect(fixture.writes).toHaveLength(0)
    expect(document.activeElement).toBe(until)
    const release = fixture.holdNextSave()
    try {
      await act(async () => until?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
      await settle()
      expect(fixture.writes).toHaveLength(1)
      expect(document.activeElement).toBe(until)
      expect(until?.disabled).toBe(false)
      await act(async () => until?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
      await settle()
      expect(fixture.writes).toHaveLength(1)
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(document.querySelector("input[aria-label='Quiet hours from']")).toBe(from)
    expect(document.querySelector("input[aria-label='Quiet hours until']")).toBe(until)
    expect(document.activeElement).toBe(until)
    expect(from?.value).toBe("23:00")
  })

  it("preserves a newer draft when an earlier save completes", async () => {
    const fixture = await openStage({
      mutedAgents: [],
      quietHours: {
        startMinute: 1320,
        endMinute: 420,
        timeZone: "Europe/Berlin"
      }
    })
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    const change = async (value: string) => {
      await act(async () => {
        if (from !== null) {
          from.value = value
          from.dispatchEvent(new Event("input", { bubbles: true }))
        }
      })
      await settle()
    }
    await change("23:00")
    const release = fixture.holdNextSave()
    try {
      await act(async () => from?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
      await settle()
      expect(fixture.writes).toHaveLength(1)
      await change("22:00")
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(from?.value).toBe("22:00")
    expect(document.querySelector(".connect-stage-notification-summary")?.textContent).toBe(
      "Quiet 23:00–07:00 Europe/Berlin"
    )
    await act(async () => from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    await settle()
    expect(fixture.writes).toHaveLength(2)
    expect(fixture.writes.at(-1)?.quietHours?.startMinute).toBe(1320)
  })

  it("queues a reversion blurred before an earlier quiet-hours save completes", async () => {
    const fixture = await openStage({
      mutedAgents: [],
      quietHours: {
        startMinute: 1320,
        endMinute: 420,
        timeZone: "Europe/Berlin"
      }
    })
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    const change = async (value: string) => {
      await act(async () => {
        if (from !== null) {
          from.value = value
          from.dispatchEvent(new Event("input", { bubbles: true }))
        }
      })
      await settle()
    }
    await change("23:00")
    const release = fixture.holdNextSave()
    try {
      await act(async () => from?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
      await settle()
      expect(fixture.writes).toHaveLength(1)
      await change("22:00")
      await act(async () => from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
      await settle()
      expect(fixture.writes).toHaveLength(1)
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(from?.value).toBe("22:00")
    expect(document.querySelector(".connect-stage-notification-summary")?.textContent).toBe(
      "Quiet 22:00–07:00 Europe/Berlin"
    )
    expect(fixture.writes).toHaveLength(2)
    expect(fixture.writes.at(-1)?.quietHours?.startMinute).toBe(1320)
  })

  it("Enter after a queued Clear preserves the visible pair as the final quiet-hours intent", async () => {
    const quietHours = { startMinute: 1380, endMinute: 420, timeZone: "Europe/Berlin" }
    const fixture = await openStage({
      mutedAgents: [],
      quietHours: { ...quietHours, startMinute: 1320 }
    })
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    const until = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours until']")
    await act(async () => {
      if (from !== null) {
        from.value = "23:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    const release = fixture.holdNextSave()
    try {
      await act(async () => from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
      await settle()
      await act(async () => document.querySelector<HTMLButtonElement>(".connect-stage-notification-clear")?.click())
      await settle()
      expect(from?.value).toBe("23:00")
      expect(until?.value).toBe("07:00")
      for (let press = 0; press < 2; press += 1) {
        await act(async () => from?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
        await settle()
      }
      expect(fixture.mutations).toEqual([{ _tag: "SetQuietHours", quietHours }])
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(fixture.mutations).toEqual([
      { _tag: "SetQuietHours", quietHours },
      { _tag: "SetQuietHours", quietHours: null },
      { _tag: "SetQuietHours", quietHours }
    ])
    expect(fixture.writes.at(-1)?.quietHours).toEqual(quietHours)
    expect(from?.value).toBe("23:00")
    expect(until?.value).toBe("07:00")
    await act(async () => from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })))
    await settle()
    expect(fixture.mutations).toHaveLength(3)
  })

  it("keeps the saved display and marks it busy while controls accept further intents", async () => {
    const fixture = await openStage()
    const release = fixture.holdNextSave()
    try {
      await act(async () => muteButton()?.click())
      await settle()
      expect(fixture.writes).toHaveLength(1)
      expect(muteButton()?.getAttribute("aria-pressed")).toBe("false")
      expect(muteButton()?.disabled).toBe(false)
      expect(document.querySelector("[aria-label='Agent notifications']")?.getAttribute("aria-busy")).toBe("true")
      expect(document.querySelector("[aria-label='Agent notifications']")?.textContent).toContain(
        "Pushes on, no quiet hours"
      )
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(muteButton()?.getAttribute("aria-pressed")).toBe("true")
  })

  it.each(["Mute", "Clear"])("queues %s clicked during a blur save and preserves both intents", async (action) => {
    const fixture = await openStage({
      mutedAgents: [],
      quietHours: { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
    })
    const from = document.querySelector<HTMLInputElement>("input[aria-label='Quiet hours from']")
    await act(async () => {
      if (from !== null) {
        from.value = "23:00"
        from.dispatchEvent(new Event("input", { bubbles: true }))
      }
    })
    await settle()
    const release = fixture.holdNextSave()
    try {
      await act(async () => {
        from?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
        if (action === "Mute") muteButton()?.click()
        else document.querySelector<HTMLButtonElement>(".connect-stage-notification-clear")?.click()
      })
      await settle()
      expect(fixture.writes).toEqual([
        {
          mutedAgents: [],
          quietHours: { startMinute: 1380, endMinute: 420, timeZone: "Europe/Berlin" }
        }
      ])
    } finally {
      await act(async () => release())
      await settle()
    }
    expect(fixture.writes).toHaveLength(2)
    expect(fixture.writes.at(-1)).toEqual({
      mutedAgents: action === "Mute" ? [{ host: "HOST-A", agentId: "agent-one" }] : [],
      quietHours: action === "Mute" ? { startMinute: 1380, endMinute: 420, timeZone: "Europe/Berlin" } : null
    })
    expect(muteButton()?.getAttribute("aria-pressed")).toBe(action === "Mute" ? "true" : "false")
  })
})
