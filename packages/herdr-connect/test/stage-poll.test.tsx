// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
import { Predicate, Schema } from "effect"
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { ConnectSurface, makeConnectAtoms } from "../src/client.js"
import { StoredPins } from "../src/pins.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

window.IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<Root> = []
let agentsBody = ""
const inventoryReads: Array<string> = []
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
  if (path === "/v1/connect/agents") {
    inventoryReads.push(agentsBody)
    return new Response(agentsBody, { headers: { "content-type": "application/json" } })
  }
  if (path === "/v1/connect/archive")
    return Response.json({
      agents: [
        { ...reviewer, agentId: reviewer.id, firstSeenAt: 1, closedAt: 2 },
        {
          ...reviewer,
          agentId: "agent-child-review",
          name: "Child review",
          firstSeenAt: 1,
          closedAt: 2,
          relationship: { parentAgentId: reviewer.id, relation: "review" }
        }
      ],
      nextCursor: null
    })
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
  inventoryReads.length = 0
  document.body.replaceChildren()
  window.localStorage.clear()
  window.history.replaceState(null, "", "/")
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
  it("keeps inventory reads running through closure confirmation while Archived is shown", async () => {
    vi.useFakeTimers()
    agentsBody = listed([reviewer])
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={makeConnectAtoms()} />
        </RegistryProvider>
      )
    )
    await settle()
    expect(host.querySelector(".connect-agent")).not.toBeNull()
    await act(async () =>
      host.querySelector<HTMLAnchorElement>(".connect-directory-switch a[href*='view=archived']")?.click()
    )
    await settle()
    expect(host.querySelector(".connect-archive-directory")).not.toBeNull()
    agentsBody = listed([])
    const initialReads = inventoryReads.length
    await settle(5_000)
    expect(inventoryReads.length).toBeGreaterThan(initialReads)
    expect(inventoryReads.at(-1)).toBe(listed([]))
    const missingReads = inventoryReads.length
    await settle(300_000)
    expect(inventoryReads.length).toBeGreaterThan(missingReads)
    expect(inventoryReads.at(-1)).toBe(listed([]))
    agentsBody = listed([reviewer])
    const returningReads = inventoryReads.length
    await settle(5_000)
    expect(inventoryReads.length).toBeGreaterThan(returningReads)
    expect(inventoryReads.at(-1)).toBe(listed([reviewer]))
    await act(async () =>
      host.querySelector<HTMLAnchorElement>(".connect-directory-switch a:not([aria-current])")?.click()
    )
    await settle()
    expect(host.querySelector(".connect-agent")?.textContent).toContain("Review worker")
  })

  it("clears the URL selection and notifies its history owner when a linked archived stage closes", async () => {
    agentsBody = listed([])
    window.history.replaceState(null, "", "/?module=connect&embedded&view=archived#details")
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={makeConnectAtoms()} />
        </RegistryProvider>
      )
    )
    await settle()
    const child = [...host.querySelectorAll<HTMLButtonElement>(".connect-archive-agent")].find(
      (row) => row.querySelector("strong")?.textContent === "Child review"
    )
    expect(child).toBeDefined()
    await act(async () => child?.click())
    await settle()
    const parent = document.querySelector<HTMLAnchorElement>(".connect-archive-stage a")
    expect(parent).not.toBeNull()
    await act(async () => parent?.click())
    await settle()
    expect(new URL(window.location.href).searchParams.get("closed")).toBe('["SER8","agent-reviewer",2]')
    const changed = vi.fn()
    window.addEventListener("popstate", changed)
    try {
      const close = document.querySelector<HTMLButtonElement>(".connect-archive-stage button[aria-label='Close']")
      expect(close).not.toBeNull()
      await act(async () => close?.click())
      await settle()
      expect(stageOpen()).toBe(false)
      const target = new URL(window.location.href)
      expect(target.searchParams.has("closed")).toBe(false)
      expect(target.searchParams.get("view")).toBe("archived")
      expect(target.searchParams.get("module")).toBe("connect")
      expect(target.searchParams.has("embedded")).toBe(true)
      expect(target.hash).toBe("#details")
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener("popstate", changed)
    }
  })
  it("keeps archived closures out of the application's live-stage heartbeat observer", async () => {
    agentsBody = listed([reviewer])
    window.history.replaceState(null, "", "/?view=archived")
    const targets: Array<{ readonly host: string; readonly id: string } | null> = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={makeConnectAtoms()} onStageChange={(target) => targets.push(target)} />
        </RegistryProvider>
      )
    )
    await settle()
    const archivedRow = host.querySelector<HTMLButtonElement>(".connect-archive-agent")
    expect(archivedRow).not.toBeNull()
    await act(async () => archivedRow?.click())
    await settle()
    expect(stageOpen()).toBe(true)
    expect(document.querySelector(".connect-archive-stage")).not.toBeNull()
    expect(targets.filter((target) => target !== null)).toEqual([])
  })
  it("settles when an inline stage handler stores the target in parent state", async () => {
    agentsBody = listed([reviewer])
    const targets: Array<{ readonly host: string; readonly id: string } | null> = []
    const handlers: Array<string> = []
    const atoms = makeConnectAtoms()
    const Parent = ({ label }: { readonly label: string }) => {
      const [target, setTarget] = useState<{ readonly host: string; readonly id: string } | null>(null)
      return (
        <>
          <output>{target?.id ?? "closed"}</output>
          <ConnectSurface
            atoms={atoms}
            onStageChange={(next) => {
              targets.push(next)
              handlers.push(label)
              // Bound a broken effect loop so the regression fails without hanging the test runner.
              if (targets.length < 12) setTarget(next)
            }}
          />
        </>
      )
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <Parent label="first" />
        </RegistryProvider>
      )
    )
    await settle()
    await act(async () => host.querySelector<HTMLButtonElement>(".connect-agent")?.click())
    await settle()
    expect(host.querySelector("output")?.textContent).toBe("agent-reviewer")
    expect(targets.length).toBeLessThan(6)
    const reports = targets.length
    await act(async () =>
      root.render(
        <RegistryProvider>
          <Parent label="latest" />
        </RegistryProvider>
      )
    )
    await settle()
    expect(targets).toHaveLength(reports)
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await settle()
    expect(host.querySelector("output")?.textContent).toBe("closed")
    expect(targets.at(-1)).toBeNull()
    expect(handlers.at(-1)).toBe("latest")
  })

  it("reports the open stage identity to its host and clears it on close", async () => {
    agentsBody = listed([reviewer])
    const targets: Array<{ readonly host: string; readonly id: string } | null> = []
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <ConnectSurface
            atoms={makeConnectAtoms()}
            onStageChange={(target) => targets.push(target)}
            stageFooter={<p>Agent notification settings</p>}
          />
        </RegistryProvider>
      )
    )
    await settle()
    await act(async () => host.querySelector<HTMLButtonElement>(".connect-agent")?.click())
    await settle()
    expect(targets.at(-1)).toEqual({ host: "SER8", id: "agent-reviewer" })
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("Agent notification settings")
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })))
    await settle()
    expect(targets.at(-1)).toBeNull()
  })
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

  it("retains agents only while their host misses a poll, labels old readings, then removes genuinely closed agents", async () => {
    vi.useFakeTimers()
    agentsBody = listed([reviewer])
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={makeConnectAtoms()} />
        </RegistryProvider>
      )
    )
    await settle()
    expect(host.querySelector(".connect-agent")).not.toBeNull()
    agentsBody = JSON.stringify({ agents: [], failures: [{ host: "SER8", reason: "timeout" }], nextCursor: null })
    await settle(5_000)
    const retained = host.querySelector(".connect-agent")
    expect(retained?.textContent).toContain("Old reading")
    expect(retained?.querySelector(".connect-creature")?.hasAttribute("data-stale")).toBe(true)
    expect(host.querySelector(".connect-failures")?.textContent).toContain("its readings are old")
    agentsBody = listed([])
    await settle(5_000)
    expect(host.querySelector(".connect-agent")).toBeNull()
  })

  // Old directory rows are context, not a new sighting: pins keep their last-seen minute and wait in overflow.
  it("does not record a retained silent-host agent as a freshly observed pin", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(120_000)
    window.localStorage.setItem(
      "fleet-connect-pins",
      JSON.stringify({
        pins: [
          {
            host: reviewer.host,
            id: reviewer.id,
            key: `${reviewer.host}:${reviewer.id}`,
            name: reviewer.name,
            seenAt: 0
          }
        ],
        v: 1
      })
    )
    agentsBody = listed([{ ...reviewer, hue: "sky" }])
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={makeConnectAtoms()} />
        </RegistryProvider>
      )
    )
    await settle()
    const stored = () =>
      Schema.decodeUnknownSync(Schema.fromJsonString(StoredPins))(window.localStorage.getItem("fleet-connect-pins"))
    expect(stored().pins[0]).toMatchObject({ seenAt: 120_000, hue: "sky" })
    agentsBody = JSON.stringify({
      agents: [],
      failures: [{ host: reviewer.host, reason: "timeout" }],
      nextCursor: null
    })
    await settle(65_000)
    expect(host.querySelector(".connect-agent")?.textContent).toContain("Old reading")
    expect(stored().pins[0]?.seenAt).toBe(120_000)
    expect(host.querySelector(".connect-pins .connect-pin")).toBeNull()
    const more = host.querySelector<HTMLButtonElement>(".connect-pins-more")
    expect(more?.textContent).toBe("Pins 1")
    await act(async () => more?.click())
    await settle()
    expect(host.querySelector(".connect-pins-entry[data-away]")?.textContent).toContain("not seen since")
    expect(
      host
        .querySelector<SVGElement>(".connect-pins-entry[data-away] .connect-creature")
        ?.style.getPropertyValue("--connect-creature-ink")
    ).toBe("#022538")
  })
})
