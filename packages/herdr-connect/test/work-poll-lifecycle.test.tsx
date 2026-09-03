// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
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
let observedPaths: Array<string> | null = null
let responseForPath: ((path: string) => Response) | null = null
const originalFetch = window.fetch
window.fetch = async (input) => {
  const path = requestPath(input)
  observedPaths?.push(path)
  return responseForPath === null ? originalFetch(input) : responseForPath(path)
}

afterAll(() => {
  window.fetch = originalFetch
})

const emptyAgents = JSON.stringify({ agents: [], failures: [], nextCursor: null })
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
const linkedAgents = JSON.stringify({
  agents: [
    {
      host: "SER8",
      id: "agent-reviewer",
      kind: "codex",
      lastActivityAt: 1_000,
      name: "Review worker",
      state: "working",
      work: "npm"
    }
  ],
  failures: [],
  nextCursor: null
})
const linkedGoal = {
  agentHierarchy: {
    agent: {
      agentId: "agent-reviewer",
      host: "SER8",
      name: "Review worker",
      paneId: "wE:p3"
    }
  },
  blocker: null,
  connectTarget: {
    agentId: "agent-reviewer",
    host: "SER8",
    url: "/connect/?agent=agent-reviewer&host=SER8"
  },
  createdAt: 1_000,
  delivery: "review",
  detail: "Review the current change",
  id: "goal-review",
  owner: { id: "owner-reviewer", name: "Reviewer" },
  repository: { branch: "feat/review", repository: "npm" },
  spend: null,
  state: "review",
  summary: "Review work",
  title: "Review browser pairing",
  updatedAt: 1_000
}
const linkedWork = JSON.stringify({
  day: emptyWindow("day"),
  month: emptyWindow("month"),
  now: { ...emptyWindow("now"), goals: [linkedGoal] },
  observedAt: 1_000,
  week: emptyWindow("week")
})

const requestPath = (input: RequestInfo | URL): string => {
  const url = "href" in input ? input.href : "url" in input ? input.url : input
  return new URL(url, "http://localhost").pathname
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  vi.useRealTimers()
  observedPaths = null
  responseForPath = null
})

describe("Connect Work polling ownership", () => {
  it("refreshes standalone Connect and stops after unmount without duplicate requests", async () => {
    vi.useFakeTimers()
    const paths: Array<string> = []
    observedPaths = paths
    responseForPath = (path) => {
      const body = path === "/v1/connect/agents" ? emptyAgents : emptyWork
      return new Response(body, { headers: { "content-type": "application/json" } })
    }

    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()

    await act(async () => {
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={atoms} />
        </RegistryProvider>
      )
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      await vi.runOnlyPendingTimersAsync()
    })
    expect(paths.filter((path) => path === "/v1/work")).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths.filter((path) => path === "/v1/work")).toHaveLength(3)

    await act(async () => root.unmount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths.filter((path) => path === "/v1/work")).toHaveLength(3)
  })

  it("keeps the rendered Work goal link after a transient refresh failure", async () => {
    vi.useFakeTimers()
    const paths: Array<string> = []
    let workRequests = 0
    observedPaths = paths
    responseForPath = (path) => {
      if (path === "/v1/connect/agents") {
        return new Response(linkedAgents, { headers: { "content-type": "application/json" } })
      }
      workRequests += 1
      if (workRequests === 3) return new Response(null, { status: 503 })
      return new Response(linkedWork, { headers: { "content-type": "application/json" } })
    }

    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()

    await act(async () => {
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={atoms} />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
      await vi.runOnlyPendingTimersAsync()
    })
    expect(workRequests).toBe(2)

    const agentButton = host.querySelector('[data-agent-key="SER8:agent-reviewer"]')
    expect(agentButton).not.toBeNull()
    agentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await act(async () => {
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(host.querySelector('[data-work-goal-state="available"]')).not.toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(workRequests).toBe(3)
    expect(host.querySelector('[data-work-goal-state="available"]')).not.toBeNull()
  })
})
