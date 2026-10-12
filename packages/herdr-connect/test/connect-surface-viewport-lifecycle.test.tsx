// @vitest-environment happy-dom

import { RegistryProvider } from "@effect/atom-react"
import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Cause, Predicate, Schema } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConnectSurface, makeConnectAtoms } from "../src/client.js"
import { ConnectAgent } from "../src/model.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

window.IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<Root> = []
const originalFetch = window.fetch
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")
const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "SER8",
  id: Schema.decodeUnknownSync(AgentStableId)("agent-reviewer"),
  kind: "codex",
  lastActivityAt: 1_000,
  name: "Review worker",
  state: "working",
  work: "npm"
})
const agentPage = { agents: [agent], failures: [], nextCursor: null }
const emptyWindow = (window: "day" | "month" | "now" | "week") => ({
  asOf: 1_000,
  goals: [],
  observedAt: 1_000,
  window
})
const workSnapshots = {
  day: emptyWindow("day"),
  month: emptyWindow("month"),
  now: emptyWindow("now"),
  observedAt: 1_000,
  week: emptyWindow("week")
}

beforeEach(() => {
  document.documentElement.style.cssText = "color: red;"
  document.body.style.cssText = "overflow: visible; touch-action: pan-x;"
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 })
  window.fetch = async (input) => {
    const url = new URL(
      Predicate.isString(input) ? input : "href" in input ? input.href : input.url,
      "http://localhost"
    )
    const body = url.pathname === "/v1/connect/agents" ? agentPage : workSnapshots
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.classList.contains("connect-shell") ? 252 : 0, 393, 0)
  })
})

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  document.documentElement.style.cssText = ""
  document.body.style.cssText = ""
  vi.restoreAllMocks()
})

afterAll(() => {
  window.fetch = originalFetch
  if (originalInnerHeight === undefined) {
    Reflect.deleteProperty(window, "innerHeight")
  } else {
    Object.defineProperty(window, "innerHeight", originalInnerHeight)
  }
})

describe("ConnectSurface directory loading", () => {
  it.each([".connect-empty button", ".connect-scope-clear"])(
    "returns focus to search after clearing filters through %s",
    async (selector) => {
      window.fetch = () => new Promise<Response>(() => {})
      const host = document.createElement("div")
      document.body.append(host)
      const root = createRoot(host)
      roots.push(root)
      const atoms = makeConnectAtoms()
      await act(async () => {
        root.render(
          <RegistryProvider
            initialValues={[
              [atoms.agents, AsyncResult.success(agentPage)],
              [atoms.query, "zzz"],
              [atoms.hostFilter, agent.host],
              [atoms.activityFilter, "needs-you"]
            ]}
          >
            <ConnectSurface atoms={atoms} embedded />
          </RegistryProvider>
        )
        for (let index = 0; index < 12; index += 1) await Promise.resolve()
      })
      const search = host.querySelector<HTMLInputElement>("input[type='search']")
      const clear = host.querySelector<HTMLButtonElement>(selector)
      expect(search).not.toBeNull()
      expect(clear).not.toBeNull()
      clear?.focus()
      expect(document.activeElement).toBe(clear)
      await act(async () => clear?.click())
      expect(search?.value).toBe("")
      expect(host.querySelector(".connect-scope-clear")).toBeNull()
      expect(host.querySelectorAll(".connect-agent")).toHaveLength(1)
      expect(document.activeElement).toBe(search)
    }
  )

  it("shows the directory recovery copy, a Retry button and Not updated yet without a raw status", async () => {
    window.fetch = () => new Promise<Response>(() => {})
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()
    await act(async () => {
      root.render(
        <RegistryProvider initialValues={[[atoms.agents, AsyncResult.failure(Cause.fail("HTTP 503"))]]}>
          <ConnectSurface atoms={atoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(host.querySelector(".connect-directory-error h2")?.textContent).toBe("The fleet directory didn't answer")
    expect(host.querySelector(".connect-directory-error p")?.textContent).toBe(
      "The request timed out, so no agents are listed. Retry, or wait: Relay tries again every 5 seconds."
    )
    expect(host.querySelector(".connect-directory-error")?.textContent).not.toContain("HTTP 503")
    expect(host.querySelector(".connect-directory-error button")?.textContent).toBe("Retry")
    expect(host.querySelector(".connect-directory-error svg")).not.toBeNull()
    expect(host.textContent).toContain("Not updated yet")
    expect(host.querySelector(".connect-directory-secondary")).toBeNull()
  })

  it("keeps search and filters on an empty fleet and names configured hosts", async () => {
    window.fetch = () => new Promise<Response>(() => {})
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()
    const page = { agents: [], failures: [], hosts: ["ALPHA", "BETA"] }
    await act(async () => {
      root.render(
        <RegistryProvider initialValues={[[atoms.agents, AsyncResult.success(page)]]}>
          <ConnectSurface atoms={atoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(host.textContent).toContain("No agents running on any host.")
    expect(host.querySelector("input[type='search']")).not.toBeNull()
    expect(host.querySelector(".connect-filters-toggle")?.textContent).toBe("Filters")
    expect(host.textContent).toContain("Start an agent on ALPHA or BETA and it appears here.")
  })

  it("omits the host hint on an empty fleet from an older hub", async () => {
    window.fetch = () => new Promise<Response>(() => {})
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()
    await act(async () => {
      root.render(
        <RegistryProvider initialValues={[[atoms.agents, AsyncResult.success({ agents: [], failures: [] })]]}>
          <ConnectSurface atoms={atoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(host.querySelector("input[type='search']")).not.toBeNull()
    expect(host.textContent).not.toContain("Start an agent on")
  })

  it("marks the directory as loading until the first list arrives, so the hub can hold its space", async () => {
    // The directory request hangs: the first list has not arrived yet.
    window.fetch = () => new Promise<Response>(() => {})
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()
    await act(async () => {
      root.render(
        <RegistryProvider>
          <ConnectSurface atoms={atoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(host.querySelector(".connect-agents")?.getAttribute("data-loading")).toBe("true")
    expect(host.querySelector(".connect-directory-secondary")).toBeNull()

    const loadedHost = document.createElement("div")
    document.body.append(loadedHost)
    const loadedRoot = createRoot(loadedHost)
    roots.push(loadedRoot)
    const loadedAtoms = makeConnectAtoms()
    await act(async () => {
      loadedRoot.render(
        <RegistryProvider initialValues={[[loadedAtoms.agents, AsyncResult.success(agentPage)]]}>
          <ConnectSurface atoms={loadedAtoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(loadedHost.querySelector(".connect-agents")?.hasAttribute("data-loading")).toBe(false)
    expect(loadedHost.querySelector(".connect-directory-secondary")).not.toBeNull()
  })

  it("keeps the directory marked as loading when the first request fails, so its retry does not shift the chat", async () => {
    window.fetch = () => new Promise<Response>(() => {})
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()
    await act(async () => {
      root.render(
        <RegistryProvider initialValues={[[atoms.agents, AsyncResult.failure(Cause.fail("directory unavailable"))]]}>
          <ConnectSurface atoms={atoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })
    expect(host.querySelector(".connect-agents")?.getAttribute("data-loading")).toBe("true")
  })
})

describe("ConnectSurface terminal viewport lifecycle", () => {
  it("retains geometry after rejected directory focus and removes it after a successful return", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()

    await act(async () => {
      root.render(
        <RegistryProvider
          initialValues={[
            [atoms.agents, AsyncResult.success(agentPage)],
            [atoms.connection, { _tag: "connected", agent }],
            [atoms.preference, AsyncResult.success(null)],
            [atoms.selectedKey, "SER8:agent-reviewer"],
            [atoms.work, AsyncResult.success(workSnapshots)]
          ]}
        >
          <ConnectSurface atoms={atoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    const shell = host.querySelector<HTMLElement>(".connect-shell")
    const workspace = host.querySelector<HTMLElement>(".connect-workspace")
    const directory = host.querySelector<HTMLElement>(".connect-directory-screen")
    const terminal = host.querySelector<HTMLElement>(".connect-terminal-screen")
    const agentButton = host.querySelector<HTMLButtonElement>('.connect-agent[data-agent-key="SER8:agent-reviewer"]')
    const back = host.querySelector<HTMLButtonElement>(".terminal-back")
    expect(shell).not.toBeNull()
    expect(workspace).not.toBeNull()
    expect(directory).not.toBeNull()
    expect(terminal).not.toBeNull()
    expect(agentButton).not.toBeNull()
    expect(back).not.toBeNull()
    if (
      shell === null ||
      workspace === null ||
      directory === null ||
      terminal === null ||
      agentButton === null ||
      back === null
    ) {
      return
    }

    expect(terminal.style.getPropertyValue("--connect-visual-viewport-height")).toBe("248px")
    expect(terminal.style.getPropertyValue("--connect-visual-viewport-offset")).toBe("252px")
    expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(true)
    expect(document.body.classList.contains("connect-terminal-document-lock")).toBe(true)

    agentButton.focus = () => undefined
    directory.focus = () => undefined
    workspace.focus = () => undefined
    shell.focus = () => undefined
    back.focus()
    await act(async () => back.click())

    expect(workspace.dataset.mode).toBe("terminal")
    expect(terminal.style.getPropertyValue("--connect-visual-viewport-height")).toBe("248px")
    expect(terminal.style.getPropertyValue("--connect-visual-viewport-offset")).toBe("252px")
    expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(true)
    expect(document.body.classList.contains("connect-terminal-document-lock")).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("focus_rejected")

    agentButton.focus = HTMLElement.prototype.focus
    await act(async () => back.click())

    expect(workspace.dataset.mode).toBe("directory")
    expect(terminal.getAttribute("aria-hidden")).toBe("true")
    expect(terminal.style.getPropertyValue("--connect-visual-viewport-height")).toBe("")
    expect(terminal.style.getPropertyValue("--connect-visual-viewport-offset")).toBe("")
    expect(document.activeElement).toBe(agentButton)
    expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(false)
    expect(document.body.classList.contains("connect-terminal-document-lock")).toBe(false)
    expect(document.documentElement.style.cssText).toBe("color: red;")
    expect(document.body.style.cssText).toBe("overflow: visible; touch-action: pan-x;")
  })

  it("restores the exact document styles when a connected terminal unmounts", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()

    await act(async () => {
      root.render(
        <RegistryProvider
          initialValues={[
            [atoms.agents, AsyncResult.success(agentPage)],
            [atoms.connection, { _tag: "connected", agent }],
            [atoms.preference, AsyncResult.success(null)],
            [atoms.selectedKey, "SER8:agent-reviewer"],
            [atoms.work, AsyncResult.success(workSnapshots)]
          ]}
        >
          <ConnectSurface atoms={atoms} embedded />
        </RegistryProvider>
      )
      for (let index = 0; index < 12; index += 1) await Promise.resolve()
    })

    expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(true)
    expect(document.body.classList.contains("connect-terminal-document-lock")).toBe(true)

    await act(async () => root.unmount())
    roots.splice(roots.indexOf(root), 1)

    expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(false)
    expect(document.body.classList.contains("connect-terminal-document-lock")).toBe(false)
    expect(document.documentElement.style.cssText).toBe("color: red;")
    expect(document.body.style.cssText).toBe("overflow: visible; touch-action: pan-x;")
  })
})
