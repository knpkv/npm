// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
import { makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { Predicate, Schema } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BlockedConnectSurface } from "../src/blocked-connect-surface.js"
import { StageHeartbeat } from "../src/blocked-push-model.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}
window.IS_REACT_ACT_ENVIRONMENT = true
const roots: Array<Root> = []
const originalFetch = window.fetch
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.localStorage.clear()
  window.fetch = originalFetch
  vi.restoreAllMocks()
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
    window.fetch = async (input, init) => {
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
    expect(document.querySelector("[aria-label='Agent notifications']")).toBeNull()
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
