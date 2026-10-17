// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { Effect, Predicate, Schema } from "effect"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import type { NotificationState } from "../src/approval-app-view.js"
import { makeConnectModuleViews } from "../src/connect-module-view.js"

const directory = Schema.decodeUnknownSync(FleetConnectAgentPage)({
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

beforeAll(() => {
  window.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(
      Predicate.isString(input) ? input : "href" in input ? input.href : input.url,
      "http://localhost"
    ).pathname
    if (path === "/v1/connect/agents") return Response.json(directory)
    if (path === "/v1/push/blocked-settings") return Response.json({ mutedAgents: [], quietHours: null })
    if (path === "/v1/push/stage-heartbeat") return Response.json({ accepted: true })
    return new Response("", { status: 503 })
  })
})
afterAll(() => vi.unstubAllGlobals())

const notificationStates = [
  "loading",
  "unsupported",
  "disabled",
  "denied",
  "enabled",
  "error"
] satisfies ReadonlyArray<NotificationState>
const notificationCopy = {
  loading: "Checking notifications…",
  unsupported: "Notifications are off on this device",
  disabled: "Notifications are off on this device",
  denied: "Notifications are off on this device",
  enabled: "Pushes on, no quiet hours",
  error: "Couldn't check notifications on this device."
} satisfies Record<NotificationState, string>

/** The real module stage reflects its page owner's state instead of the device fallback. */
it.each(notificationStates)("forwards page-owned notification state %s", async (notificationState) => {
  const atoms = makeConnectAtoms()
  const registry = AtomRegistry.make({ initialValues: [[atoms.agents, AsyncResult.success(directory)]] })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    const views = makeConnectModuleViews({
      atoms,
      now: 2_000,
      notificationState,
      readApprovals: Effect.succeed({ _tag: "Complete", items: [], contributions: [] })
    })
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          {views.pages.overview(new URLSearchParams(), { active: true, navigate: () => {}, closeSelection: () => {} })}
        </RegistryContext.Provider>
      )
    )
    const agent = host.querySelector<HTMLButtonElement>(".connect-home-agent")
    expect(agent).not.toBeNull()
    await act(async () => agent?.click())
    await vi.waitFor(() =>
      expect(document.querySelector("[aria-label='Agent notifications']")?.textContent).toContain(
        notificationCopy[notificationState]
      )
    )
  } finally {
    await act(async () => root.unmount())
    registry.dispose()
    host.remove()
  }
})
