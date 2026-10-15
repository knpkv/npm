// @vitest-environment happy-dom

import { RegistryContext, RegistryProvider } from "@effect/atom-react"
import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Cause, Predicate, Schema } from "effect"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
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
// Fetch's Context reference captures one function; dispatch each request to this test's responder.
let respond = originalFetch
window.fetch = (input, init) => respond(input, init)
class TimeoutFixture extends Schema.TaggedError<TimeoutFixture>()("ConnectTimeoutError", {}) {}
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
  respond = async (input) => {
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
  it.each([401, 403, 500, 502])(
    "classifies a first-load HTTP %s response without claiming a timeout",
    async (status) => {
      respond = async () => new Response("timeout", { status })
      const host = document.createElement("div")
      document.body.append(host)
      const root = createRoot(host)
      roots.push(root)
      await act(async () => {
        root.render(
          <RegistryProvider>
            <ConnectSurface atoms={makeConnectAtoms()} embedded />
          </RegistryProvider>
        )
        for (let index = 0; index < 40; index += 1) await Promise.resolve()
      })
      expect(host.querySelector(".connect-directory-error h2")?.textContent).toBe("Couldn't load the fleet directory")
      expect(host.querySelector(".connect-directory-error p")?.textContent).toBe(
        `The hub answered HTTP ${String(status)}.`
      )
      expect(host.textContent).not.toContain("timed out")
    }
  )

  it.each(["network", "protocol"])(
    "keeps a first-load %s failure free of a timeout claim and raw diagnostics",
    async (kind) => {
      respond = async () => {
        if (kind === "network") throw new TypeError("sensitive diagnostic")
        return new Response(JSON.stringify({ agents: "sensitive diagnostic" }), {
          headers: { "content-type": "application/json" }
        })
      }
      const host = document.createElement("div")
      document.body.append(host)
      const root = createRoot(host)
      roots.push(root)
      await act(async () => {
        root.render(
          <RegistryProvider>
            <ConnectSurface atoms={makeConnectAtoms()} embedded />
          </RegistryProvider>
        )
        for (let index = 0; index < 40; index += 1) await Promise.resolve()
      })
      expect(host.querySelector(".connect-directory-error")).not.toBeNull()
      if (kind === "network") {
        expect(host.querySelector(".connect-directory-error h2")?.textContent).toBe("Couldn’t load the fleet directory")
        expect(host.querySelector(".connect-directory-error p")?.textContent).toBe(
          "Relay couldn’t reach the hub. It tries again every 5 seconds."
        )
      } else expect(host.textContent).not.toContain("couldn’t reach the hub")
      expect(host.textContent).not.toContain("timed out")
      expect(host.textContent).not.toContain("sensitive diagnostic")
    }
  )

  it.each([".connect-empty button", ".connect-scope-clear"])(
    "returns focus to search after clearing filters through %s",
    async (selector) => {
      respond = () => new Promise<Response>(() => {})
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

  it.each(["hidden", "inert", "aria-hidden"])(
    "clears filters without focusing a search under %s",
    async (attribute) => {
      respond = () => new Promise<Response>(() => {})
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
      const clear = host.querySelector<HTMLButtonElement>(".connect-scope-clear")
      if (search === null || clear === null) return expect.unreachable()
      const focus = vi.spyOn(search, "focus")
      host.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "")
      // An owner callback may finish after its module becomes inactive. It must not steal focus.
      await act(async () => clear.click())
      expect(search.value).toBe("")
      expect(focus).not.toHaveBeenCalled()
    }
  )

  it("shows classified timeout recovery copy, a Retry button and Not updated yet", async () => {
    respond = () => new Promise<Response>(() => {})
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const atoms = makeConnectAtoms()
    await act(async () => {
      root.render(
        <RegistryProvider initialValues={[[atoms.agents, AsyncResult.failure(Cause.fail(new TimeoutFixture()))]]}>
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
    respond = () => new Promise<Response>(() => {})
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
    respond = () => new Promise<Response>(() => {})
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
    respond = () => new Promise<Response>(() => {})
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
    respond = () => new Promise<Response>(() => {})
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

/** Active changes presentation only, keeping the terminal subtree and its atom/session identity. */
it("keeps the same connected terminal owner while its embedded module is inactive", async () => {
  const matchMedia = window.matchMedia.bind(window)
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query)
    if (query === "(pointer: fine)") Object.defineProperty(media, "matches", { value: false })
    return media
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const atoms = makeConnectAtoms()
  const paint = async (active: boolean) =>
    act(async () => {
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
          <ConnectSurface atoms={atoms} embedded active={active} />
        </RegistryProvider>
      )
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    })
  await paint(true)
  const terminal = host.querySelector(".connect-terminal-screen")
  expect(terminal).not.toBeNull()
  expect(host.querySelector(".connect-workspace")?.getAttribute("data-mode")).toBe("terminal")
  expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(true)
  const outside = document.createElement("button")
  document.body.append(outside)
  outside.focus()
  await paint(false)
  expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(false)
  expect(document.body.classList.contains("connect-terminal-document-lock")).toBe(false)
  expect(document.documentElement.style.cssText).toBe("color: red;")
  expect(document.body.style.cssText).toBe("overflow: visible; touch-action: pan-x;")
  expect(document.activeElement).toBe(outside)
  expect(host.querySelector(".connect-terminal-screen")).toBe(terminal)
  expect(host.querySelector(".connect-workspace")?.getAttribute("data-mode")).toBe("terminal")
  await paint(true)
  expect(document.documentElement.classList.contains("connect-terminal-document-lock")).toBe(true)
  expect(terminal?.contains(document.activeElement)).toBe(true)
  expect(host.querySelector(".connect-terminal-screen")).toBe(terminal)
  expect(host.querySelector(".connect-workspace")?.getAttribute("data-mode")).toBe("terminal")
  outside.focus()
  await paint(true)
  expect(document.activeElement).toBe(outside)
  await paint(false)
  const input = document.createElement("input")
  document.body.append(input)
  input.focus()
  await paint(true)
  expect(document.activeElement).toBe(input)
  await paint(false)
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  const close = document.createElement("button")
  dialog.append(close)
  document.body.append(dialog)
  close.focus()
  await paint(true)
  expect(document.activeElement).toBe(close)
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

/** Archived replaces the active owner; its closed worker cannot leave a connected atom in the shell. */
it("clears terminal ownership on Active unmount while keeping the selected agent", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const atoms = makeConnectAtoms()
  const registry = AtomRegistry.make({
    initialValues: [
      [atoms.agents, AsyncResult.success(agentPage)],
      [atoms.connection, { _tag: "connected", agent }],
      [atoms.selectedKey, "SER8:agent-reviewer"],
      [atoms.preference, AsyncResult.success("SER8:agent-reviewer")],
      [atoms.work, AsyncResult.success(workSnapshots)]
    ]
  })
  const releases = [
    registry.mount(atoms.connection),
    registry.mount(atoms.connectionRequest),
    registry.mount(atoms.selectedKey)
  ]
  try {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ConnectSurface
            atoms={atoms}
            embedded
            directoryLocation={{
              url: new URL("http://localhost/?view=active#connect/overview"),
              navigate: () => {},
              closeSelection: () => {}
            }}
          />
        </RegistryContext.Provider>
      )
    )
    expect(registry.get(atoms.connection)._tag).toBe("connected")
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <ConnectSurface
            atoms={atoms}
            embedded
            directoryLocation={{
              url: new URL("http://localhost/?view=archived#connect/overview"),
              navigate: () => {},
              closeSelection: () => {}
            }}
          />
        </RegistryContext.Provider>
      )
    )
    expect(registry.get(atoms.connection)._tag).toBe("idle")
    expect(registry.get(atoms.connectionRequest)).toBeNull()
    expect(registry.get(atoms.selectedKey)).toBe("SER8:agent-reviewer")
  } finally {
    await act(async () => root.unmount())
    roots.splice(roots.indexOf(root), 1)
    for (const release of releases) release()
    registry.dispose()
  }
})
