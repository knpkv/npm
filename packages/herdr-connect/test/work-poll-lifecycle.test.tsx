// @vitest-environment happy-dom

import { RegistryProvider, useAtomMount, useAtomValue } from "@effect/atom-react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { ConnectSurface, makeConnectAtoms } from "../src/client.js"
import { WorkPollMount } from "../src/work-poll.js"

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

  it("keeps one shared poll alive while the embedded owner changes", async () => {
    vi.useFakeTimers()
    const paths: Array<string> = []
    observedPaths = paths
    responseForPath = () => {
      return new Response(emptyWork, { headers: { "content-type": "application/json" } })
    }

    const OwnerPair = ({
      atom,
      connectVisible,
      work
    }: {
      readonly atom: ReturnType<typeof makeConnectAtoms>["workPoll"]
      readonly connectVisible: boolean
      readonly work: ReturnType<typeof makeConnectAtoms>["work"]
    }) => {
      useAtomValue(work)
      useAtomValue(atom)
      useAtomMount(atom)
      return <div data-owner>{connectVisible ? <WorkPollMount atom={atom} /> : null}</div>
    }

    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()

    await act(async () => {
      root.render(
        <RegistryProvider>
          <OwnerPair atom={atoms.workPoll} connectVisible work={atoms.work} />
        </RegistryProvider>
      )
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      await vi.runOnlyPendingTimersAsync()
    })
    expect(paths).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths).toHaveLength(3)

    await act(async () => {
      root.render(
        <RegistryProvider>
          <OwnerPair atom={atoms.workPoll} connectVisible={false} work={atoms.work} />
        </RegistryProvider>
      )
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths).toHaveLength(4)

    await act(async () => root.unmount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(paths).toHaveLength(4)
  })
})
