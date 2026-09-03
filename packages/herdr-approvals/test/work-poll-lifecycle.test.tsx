// @vitest-environment happy-dom

import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { ConnectSurface, makeConnectAtoms } from "@knpkv/herdr-connect/surface"
import { DashboardWorkPollOwner } from "../src/work-poll-owner.js"
import { FleetShell } from "../src/shell-view.js"

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
const emptyWorkWindow = (window: "day" | "month" | "now" | "week") => ({
  asOf: 1_000,
  goals: [],
  observedAt: 1_000,
  window
})
const emptyWork = JSON.stringify({
  day: emptyWorkWindow("day"),
  month: emptyWorkWindow("month"),
  now: emptyWorkWindow("now"),
  observedAt: 1_000,
  week: emptyWorkWindow("week")
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
  window.history.replaceState(null, "", "/")
  vi.useRealTimers()
  observedPaths = null
  responseForPath = null
})

const WorkSnapshotObserver = ({ atom }: { readonly atom: ReturnType<typeof makeConnectAtoms>["work"] }) => {
  useAtomValue(atom)
  return null
}

describe("dashboard Work polling ownership", () => {
  it("keeps the production owner polling while Connect unmounts on tab change", async () => {
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
          <DashboardWorkPollOwner atom={atoms.workPoll} />
          <WorkSnapshotObserver atom={atoms.work} />
          <FleetShell
            approvals={<div data-testid="approvals" />}
            connect={<ConnectSurface atoms={atoms} embedded />}
            hostCount={1}
            work={<div data-testid="work" />}
          />
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

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "2" }))
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths.filter((path) => path === "/v1/work")).toHaveLength(4)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "3" }))
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths.filter((path) => path === "/v1/work")).toHaveLength(5)

    await act(async () => root.unmount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths.filter((path) => path === "/v1/work")).toHaveLength(5)
  })
})
