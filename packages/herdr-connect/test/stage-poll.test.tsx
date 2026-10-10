// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
import { Predicate } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { ConnectSurface, makeConnectAtoms } from "../src/client.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

window.IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<Root> = []
let agentsBody = ""
const originalFetch = window.fetch
const emptyWindow = (window: "day" | "month" | "now" | "week") => ({
  asOf: 1_000,
  goals: [],
  observedAt: 1_000,
  window
})
const emptyWork = JSON.stringify({
  day: emptyWindow("day"),
  month: emptyWindow("month"),
  now: emptyWindow("now"),
  observedAt: 1_000,
  week: emptyWindow("week")
})
const listed = (agents: ReadonlyArray<unknown>) => JSON.stringify({ agents, failures: [], nextCursor: null })
const reviewer = {
  host: "SER8",
  id: "agent-reviewer",
  kind: "codex",
  lastActivityAt: 1_000,
  name: "Review worker",
  state: "working",
  work: "npm"
}

window.fetch = async (input) => {
  const url = Predicate.isString(input) ? input : "href" in input ? input.href : input.url
  const path = new URL(url, "http://localhost").pathname
  if (path === "/v1/connect/agents")
    return new Response(agentsBody, { headers: { "content-type": "application/json" } })
  if (path.startsWith("/v1/work")) return new Response(emptyWork, { headers: { "content-type": "application/json" } })
  return new Response("{}", { status: 404 })
}

afterAll(() => {
  window.fetch = originalFetch
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  vi.useRealTimers()
})

const settle = async (milliseconds = 0): Promise<void> => {
  await act(async () => {
    if (milliseconds > 0) await vi.advanceTimersByTimeAsync(milliseconds)
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

const stageOpen = (): boolean => document.querySelector("[role='dialog']") !== null

describe("Connect stage across polls", () => {
  // A stage whose agent left the directory must stay closed when the agent comes back: it would otherwise
  // reopen uninvited and take focus from whatever the reader is doing.
  it("closes when its agent leaves the directory and stays closed when it returns", async () => {
    vi.useFakeTimers()
    agentsBody = listed([reviewer])
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => {
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={makeConnectAtoms()} />
        </RegistryProvider>
      )
    })
    await settle()
    const row = host.querySelector<HTMLButtonElement>('.connect-agent[data-agent-key="SER8:agent-reviewer"]')
    expect(row).not.toBeNull()
    await act(async () => row?.click())
    await settle()
    expect(stageOpen()).toBe(true)

    agentsBody = listed([])
    await settle(5_000)
    expect(host.querySelector(".connect-agent")).toBeNull()
    expect(stageOpen()).toBe(false)

    agentsBody = listed([reviewer])
    await settle(5_000)
    expect(host.querySelector('.connect-agent[data-agent-key="SER8:agent-reviewer"]')).not.toBeNull()
    expect(stageOpen()).toBe(false)
  })
})
