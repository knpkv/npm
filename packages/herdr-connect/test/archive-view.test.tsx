// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
import { Predicate, Schema } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConnectSurface, makeConnectAtoms } from "../src/client.js"
import { ConnectArchiveCursor } from "../src/model.js"

window.IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<Root> = []
const originalFetch = window.fetch
const closure = {
  host: "fixture-host",
  agentId: "agent-parent",
  name: "Closed parent",
  kind: "worker",
  work: "package-work",
  state: "done",
  firstSeenAt: 1,
  closedAt: 20
}
const selectedKey = JSON.stringify([closure.host, closure.agentId, closure.closedAt])
const newer = { ...closure, agentId: "agent-newer", name: "Newer closure", closedAt: 30 }
const cursor = { host: newer.host, agentId: newer.agentId, closedAt: newer.closedAt }
const requests: Array<string | null> = []
let directoryRequests = 0
let archive: (cursor: string | null) => Promise<Response>

beforeEach(() => {
  requests.length = 0
  directoryRequests = 0
  archive = async () => Response.json({ agents: [closure], nextCursor: null })
  window.fetch = async (input) => {
    const url = new URL(
      Predicate.isString(input) ? input : "href" in input ? input.href : input.url,
      "http://localhost"
    )
    if (url.pathname === "/v1/connect/archive") {
      requests.push(url.searchParams.get("cursor"))
      return archive(url.searchParams.get("cursor"))
    }
    if (url.pathname === "/v1/connect/agents") {
      directoryRequests += 1
      return Response.json({ agents: [], failures: [], nextCursor: null })
    }
    return Response.json({ hosts: [], failures: [], peersListed: true })
  }
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.fetch = originalFetch
  window.history.replaceState(null, "", "/")
  vi.restoreAllMocks()
})

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

/** Mount the directory through its real archive atom and HTTP decoder. */
const mount = async (embedded = false, key: string | null = null) => {
  const url = new URL("http://localhost/?module=connect&view=archived#details")
  if (key !== null) url.searchParams.set("closed", key)
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      <RegistryProvider>
        <ConnectSurface atoms={makeConnectAtoms()} embedded={embedded} />
      </RegistryProvider>
    )
  )
  await settle()
  return host
}

describe("archived directory selection", () => {
  it.each([
    { hue: undefined, ink: "#3a1500", label: "hash without served hue" },
    { hue: "sky", ink: "#022538", label: "served snapshot hue" }
  ])("keeps $label in both archived rows and the read-only stage", async ({ hue, ink }) => {
    archive = async () =>
      Response.json({
        agents: [hue === undefined ? closure : { ...closure, hue }],
        nextCursor: null
      })
    await mount(true, selectedKey)
    await vi.waitFor(async () => {
      await settle()
      expect(document.querySelector(".connect-archive-stage .connect-creature")).not.toBeNull()
    })
    const creatures = document.querySelectorAll<SVGElement>(
      ".connect-archive-agent .connect-creature, .connect-archive-stage .connect-creature"
    )
    expect(creatures).toHaveLength(2)
    for (const creature of creatures) {
      expect(creature.style.getPropertyValue("--connect-creature-ink")).toBe(`oklch(from ${ink} l calc(c * 0.1) h)`)
    }
  })

  it("a held archive reaches the failed state at ten seconds despite directory polls, and Retry recovers", async () => {
    vi.useFakeTimers()
    try {
      archive = () => new Promise<Response>(() => {})
      const host = await mount()
      expect(requests).toEqual([null])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(directoryRequests).toBeGreaterThan(1)
      expect(host.textContent).toContain("Loading archived agents")
      expect(requests).toEqual([null])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4999)
      })
      expect(host.querySelector("[role='alert']")).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      const alert = host.querySelector("[role='alert']")
      expect(alert?.textContent).toContain("Couldn't load archived agents")
      expect(alert?.textContent).toContain("The hub didn't return the archive. Active agents aren't affected.")
      expect(requests).toEqual([null])
      archive = async () => Response.json({ agents: [closure], nextCursor: null })
      const retry = alert?.querySelector<HTMLButtonElement>("button")
      expect(retry?.textContent).toBe("Retry")
      await act(async () => {
        retry?.click()
      })
      await settle()
      expect(host.querySelector("[role='alert']")).toBeNull()
      expect(host.querySelector(".connect-archive-agent strong")?.textContent).toBe("Closed parent")
      expect(requests).toEqual([null, null])
    } finally {
      vi.useRealTimers()
    }
  })
  it("reopens a first-page closure without reading any older page", async () => {
    archive = async () => Response.json({ agents: [closure], nextCursor: { ...cursor, closedAt: closure.closedAt } })
    await mount(false, selectedKey)
    await vi.waitFor(async () => {
      await settle()
      expect(document.querySelector("[role='dialog']")?.textContent).toContain("Closed parent")
    })
    expect(requests).toEqual([null])
  })

  it("leaves Show older explicit when the URL selects no closure", async () => {
    archive = async () => Response.json({ agents: [newer], nextCursor: cursor })
    const host = await mount()
    await vi.waitFor(async () => {
      await settle()
      expect(host.querySelector(".connect-archive-agent strong")?.textContent).toBe("Newer closure")
    })
    expect(requests).toEqual([null])
    expect(document.querySelector("[role='dialog']")).toBeNull()
    expect(host.textContent).toContain("Show older")
  })

  it("follows bounded pages on refresh until the selected closure is found", async () => {
    archive = async (value) =>
      Response.json(value === null ? { agents: [newer], nextCursor: cursor } : { agents: [closure], nextCursor: null })
    await mount(false, selectedKey)
    await vi.waitFor(async () => {
      await settle()
      expect(document.querySelector("[role='dialog']")?.textContent).toContain("Closed parent")
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBeNull()
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(ConnectArchiveCursor))(requests[1])).toEqual(cursor)
    expect(new URL(window.location.href).searchParams.get("closed")).toBe(selectedKey)
  })

  it("clears a missing or expired selection by replace, retaining the owning URL and fragment", async () => {
    archive = async () => Response.json({ agents: [newer], nextCursor: null })
    const replace = vi.spyOn(window.history, "replaceState")
    const push = vi.spyOn(window.history, "pushState")
    const changed = vi.fn()
    window.addEventListener("popstate", changed)
    try {
      await mount(false, selectedKey)
      await vi.waitFor(async () => {
        await settle()
        expect(new URL(window.location.href).searchParams.has("closed")).toBe(false)
      })
      expect(document.querySelector("[role='dialog']")).toBeNull()
      expect(new URL(window.location.href).searchParams.get("view")).toBe("archived")
      expect(new URL(window.location.href).searchParams.get("module")).toBe("connect")
      expect(new URL(window.location.href).hash).toBe("#details")
      expect(replace).toHaveBeenCalledTimes(2)
      expect(push).not.toHaveBeenCalled()
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener("popstate", changed)
    }
    expect(requests).toEqual([null])
  })
})

describe("archived application navigation", () => {
  for (const state of ["loading", "failure", "ready"]) {
    for (const embedded of [false, true]) {
      it(`${state} keeps standalone navigation and omits it when embedded=${String(embedded)}`, async () => {
        archive =
          state === "loading"
            ? () => new Promise<Response>(() => {})
            : state === "failure"
              ? async () => new Response(null, { status: 503 })
              : async () => Response.json({ agents: [], nextCursor: null })
        const host = await mount(embedded)
        await vi.waitFor(async () => {
          await settle()
          expect(host.textContent).toContain(
            state === "loading"
              ? "Loading archived agents"
              : state === "failure"
                ? "Couldn't load archived agents"
                : "No closed agents"
          )
        })
        const nav = host.querySelector(".fleet-app-nav")
        if (embedded) {
          expect(nav).toBeNull()
        } else {
          expect(nav?.querySelector("a[href='/']")?.textContent).toBe("Approvals")
          expect(nav?.querySelector("a[href='/connect/']")?.getAttribute("aria-current")).toBe("page")
        }
      })
    }
  }
})

describe("archive shortcuts for embedders retaining hidden mounts", () => {
  for (const attribute of ["hidden", "inert", "aria-hidden"]) {
    for (const modifier of ["control", "meta"]) {
      it(`leaves ${modifier}+K uncancelled behind ${attribute}, while the visible archive owns its shortcut`, async () => {
        const host = await mount(true)
        const search = host.querySelector<HTMLInputElement>("#connect-agent-search")
        expect(search).not.toBeNull()
        const outside = document.createElement("button")
        outside.textContent = "Other module"
        document.body.append(outside)
        const press = () => {
          const event = new KeyboardEvent("keydown", {
            key: "k",
            ctrlKey: modifier === "control",
            metaKey: modifier === "meta",
            bubbles: true,
            cancelable: true
          })
          outside.dispatchEvent(event)
          return event
        }
        outside.focus()
        expect(press().defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(search)
        outside.focus()
        host.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "")
        expect(press().defaultPrevented).toBe(false)
        expect(document.activeElement).toBe(outside)
        host.removeAttribute(attribute)
        expect(press().defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(search)
      })
    }
  }
})
