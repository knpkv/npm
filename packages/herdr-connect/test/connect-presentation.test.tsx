// @vitest-environment happy-dom

import { RegistryContext } from "@effect/atom-react"
import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Cause, Effect, Option, Schema } from "effect"
import * as Atom from "effect/reactivity/Atom"
import * as AtomRegistry from "effect/reactivity/AtomRegistry"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { act, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { ConnectSurface, makeConnectAtoms } from "../src/client.js"
import { ConnectAgent, type ConnectPeerFailure } from "../src/model.js"
import { connectAgentGroup } from "../src/agent-state-core.js"
import { matchesConnectAgent } from "../src/view.js"
import type { ConnectWorkspaceFocusFailureReason } from "../src/workspace-focus.js"

// SSR still initializes atom reads. Keep this fixture hermetic; no localhost listener is involved.
beforeAll(() => vi.stubGlobal("fetch", async () => new Response("", { status: 503 })))
afterAll(() => vi.unstubAllGlobals())

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "ALPHA",
  id: Schema.decodeUnknownSync(AgentStableId)("agent-reviewer"),
  kind: "codex",
  lastActivityAt: 0,
  name: "Review worker",
  state: "waiting",
  work: "Reviewing the release"
})

/** Render ids are allocation details; keep their reference graph, and normalize viewer-local time text. */
const normalizedMarkup = (markup: string): string => {
  const host = document.createElement("div")
  host.innerHTML = markup
  const ids = [...host.querySelectorAll("[id]")].map((element, index) => ({
    from: element.id,
    to: `INSTANCE${String(index)}`
  }))
  let normalized = host.innerHTML
  for (const { from, to } of ids.toSorted((left, right) => right.from.length - left.from.length)) {
    normalized = normalized.replaceAll(from, to)
  }
  return normalized
    .replace(/(<time[^>]*>)[^<]*(<\/time>)/gu, "$1TIME$2")
    .replace(/last active at [^,]+, open stage/gu, "last active at TIME, open stage")
}

const markupFor = (
  presentation?: ComponentProps<typeof ConnectSurface>["presentation"],
  agents: ReadonlyArray<ConnectAgent> = [agent],
  connection?: Atom.Type<ReturnType<typeof makeConnectAtoms>["connection"]>,
  failures: ReadonlyArray<ConnectPeerFailure> = [],
  reading?: Atom.Type<ReturnType<typeof makeConnectAtoms>["agents"]>
): string => {
  const atoms = makeConnectAtoms()
  const registry = AtomRegistry.make({
    initialValues: [
      [atoms.agents, reading ?? AsyncResult.success({ agents, failures }, { timestamp: 0 })],
      [atoms.limits, AsyncResult.initial()],
      [atoms.work, AsyncResult.initial()],
      ...(connection === undefined
        ? []
        : [[atoms.connection, connection] satisfies readonly [typeof atoms.connection, typeof connection]])
    ]
  })
  try {
    return normalizedMarkup(
      renderToStaticMarkup(
        <RegistryContext.Provider value={registry}>
          <ConnectSurface atoms={atoms} embedded {...(presentation === undefined ? {} : { presentation })} />
        </RegistryContext.Provider>
      )
    )
  } finally {
    registry.dispose()
  }
}

/** Pin the existing Fleet directory before introducing a host presentation. */
it("keeps the original Fleet surface markup", () => {
  expect(markupFor()).toMatchSnapshot()
  expect(markupFor({ _tag: "fleet" })).toBe(markupFor())
})

it("places the host summary before Home filters without the Fleet cast or limits surface", () => {
  const markup = markupFor({ _tag: "home", summary: <p data-home-summary="">Approvals waiting</p> })
  const host = document.createElement("div")
  host.innerHTML = markup
  expect(host.querySelector("h1")?.textContent).toBe("Connect")
  expect(host.textContent).toContain("Who’s working, who’s blocked, who needs you")
  expect(host.querySelector(".connect-home-summary [data-home-summary]")).not.toBeNull()
  expect(markup.indexOf("data-home-summary")).toBeLessThan(markup.indexOf("connect-home-directory"))
  expect(host.querySelector(".connect-cast")).toBeNull()
  expect(host.querySelector(".connect-directory-secondary")).toBeNull()
  expect(host.querySelector(".connect-agent")?.textContent).toContain("Review worker")
})

it("permits Home without a host summary", () => {
  const host = document.createElement("div")
  host.innerHTML = markupFor({ _tag: "home" })
  expect(host.querySelector(".connect-home-summary")).toBeNull()
  expect(host.querySelectorAll("h1")).toHaveLength(1)
})

/** An in-flight refresh retains its rows and names the age of the successful reading, not a failure. */
it("names Home's in-flight refresh before the retained reading", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(360_000)
  try {
    const host = document.createElement("div")
    host.innerHTML = markupFor(
      { _tag: "home", summary: <p>Approvals waiting</p> },
      [agent],
      undefined,
      [],
      AsyncResult.success({ agents: [agent], failures: [] }, { timestamp: 0, waiting: true })
    )
    const notice = host.querySelector(".connect-home-read-notice")
    expect(notice?.textContent).toContain("Refreshing")
    expect(notice?.textContent).toContain(
      "Updated 6 min ago. The last reading stays on screen until the refresh lands."
    )
    expect(notice?.compareDocumentPosition(host.querySelector(".connect-home-summary") ?? host) ?? 0).toBe(4)
    expect(host.querySelector(".connect-home-agent")?.textContent).toContain(agent.name)
    const fleet = document.createElement("div")
    fleet.innerHTML = markupFor(
      { _tag: "fleet" },
      [agent],
      undefined,
      [],
      AsyncResult.success({ agents: [agent], failures: [] }, { timestamp: 0, waiting: true })
    )
    expect(fleet.querySelector(".connect-home-read-notice")).toBeNull()
  } finally {
    now.mockRestore()
  }
})

/** Normal five-second polls must not insert status content or move the directory for fresh readings. */
it("keeps a routine Home refresh quiet while its retained reading is recent", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(5_200)
  try {
    const host = document.createElement("div")
    host.innerHTML = markupFor(
      { _tag: "home" },
      [agent],
      undefined,
      [],
      AsyncResult.success({ agents: [agent], failures: [] }, { timestamp: 0, waiting: true })
    )
    expect(host.querySelector(".connect-home-read-notice")).toBeNull()
    expect(host.querySelector(".connect-home-agent")?.textContent).toContain(agent.name)
  } finally {
    now.mockRestore()
  }
})

/** A failed retry never presents itself as an in-flight success or emits raw transport detail. */
it("keeps Home's failed refresh distinct from its in-flight notice", () => {
  const host = document.createElement("div")
  host.innerHTML = markupFor(
    { _tag: "home", summary: <p>Approvals waiting</p> },
    [agent],
    undefined,
    [],
    AsyncResult.failureWithPrevious(Cause.die("private_transport_detail"), {
      previous: Option.some(AsyncResult.success({ agents: [agent], failures: [] }, { timestamp: 0 }))
    })
  )
  const notice = host.querySelector(".connect-home-read-notice")
  expect(notice?.textContent).toContain("Couldn’t refresh")
  expect(notice?.textContent).toContain("Previous reading")
  expect(notice?.textContent).toContain(". Retrying every 5 seconds.")
  expect(notice?.textContent).not.toContain("Refreshing")
  expect(host.textContent).not.toContain("private_transport_detail")
  expect(host.querySelector(".connect-home-agent")?.textContent).toContain(agent.name)
  expect(host.querySelector(".connect-home-agent")?.textContent).not.toContain("Old reading")
  expect(notice?.querySelector("svg.lucide-clock")).not.toBeNull()
})

it("groups Home states without counting Ready, Idle or unknown states as needing a person", () => {
  const agents = ["waiting", "blocked", "working", "ready", "idle", "done", "new-state"].map((state, index) =>
    Schema.decodeUnknownSync(ConnectAgent)({ ...agent, id: `agent-${String(index)}`, name: state, state })
  )
  const host = document.createElement("div")
  host.innerHTML = markupFor({ _tag: "home" }, agents)
  expect([...host.querySelectorAll(".connect-home-group h2")].map((heading) => heading.textContent)).toEqual([
    "Needs you 2",
    "Working 1",
    "Ready 2",
    "Recently done 1",
    "Unknown 1"
  ])
  const ready = host.querySelector('[data-home-group="ready"]')
  expect(ready?.textContent).toContain("Idle since")
  expect(ready?.querySelectorAll(".connect-agent-work")).toHaveLength(0)
  expect([...(ready?.querySelectorAll("[data-home-state]") ?? [])].map((row) => row.textContent)).toEqual([
    "Idle",
    "Ready"
  ])
  const done = host.querySelector('[data-home-group="finished"]')
  expect(done?.textContent).toContain("Last activity")
  expect(done?.querySelector(".connect-home-last-activity time")?.getAttribute("dateTime")).toBe(
    new Date(agent.lastActivityAt).toISOString()
  )
})

it("keeps Fleet's safety fallback and Home/push unknown policy explicit", () => {
  const unknown = { ...agent, state: "new-state" }
  expect(connectAgentGroup(unknown.state, { presentation: "fleet" })).toBe("needs-you")
  expect(connectAgentGroup(unknown.state, { presentation: "home" })).toBe("unknown")
  expect(connectAgentGroup(unknown.state, { presentation: "push" })).toBe("unknown")
  expect(connectAgentGroup("waiting", { presentation: "home", offline: true })).toBe("unknown")
  const filters = { activity: "needs-you", host: null, query: "" } satisfies Parameters<typeof matchesConnectAgent>[1]
  expect(matchesConnectAgent(unknown, filters, { presentation: "fleet" })).toBe(true)
  expect(matchesConnectAgent(unknown, filters, { presentation: "home" })).toBe(false)
  const fleet = document.createElement("div")
  fleet.innerHTML = markupFor({ _tag: "fleet" }, [unknown])
  expect(fleet.querySelector(".connect-attention-count")?.textContent).toContain("1 needs you")
  expect(fleet.querySelector(".connect-creature")?.getAttribute("data-bucket")).toBe("needs-you")
  const home = document.createElement("div")
  home.innerHTML = markupFor({ _tag: "home" }, [unknown])
  expect(home.querySelector('[data-home-group="unknown"]')?.textContent).toContain("Unknown 1")
  expect(home.querySelector(".connect-creature")?.getAttribute("data-bucket")).toBe("unknown")
  expect(home.querySelector('[data-home-group="needs-you"] h2')?.textContent).toBe("Needs you 0")
})

/** Only the presentation that displays limits may own its read loop. */
it.each(["home", "fleet"])(
  "mounts the limits read only where its %s presentation renders limits",
  async (presentation) => {
    const poll = vi.fn()
    const atoms = { ...makeConnectAtoms(), limitsPoll: Atom.make(Effect.sync(poll)) }
    const registry = AtomRegistry.make({
      initialValues: [
        [atoms.agents, AsyncResult.success({ agents: [agent], failures: [] }, { timestamp: 0 })],
        [atoms.limits, AsyncResult.initial()],
        [atoms.work, AsyncResult.initial()]
      ]
    })
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            <ConnectSurface
              atoms={atoms}
              embedded
              presentation={presentation === "home" ? { _tag: "home" } : { _tag: "fleet" }}
            />
          </RegistryContext.Provider>
        )
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
      })
      expect(poll).toHaveBeenCalledTimes(presentation === "home" ? 0 : 1)
    } finally {
      await act(async () => root.unmount())
      registry.dispose()
      host.remove()
    }
  }
)

/** The Fleet footer has no limits consumer until the first directory reading arrives. */
it("starts Fleet limits only after the directory loads and its footer is shown", async () => {
  const poll = vi.fn()
  const original = makeConnectAtoms()
  const agents = Atom.make<Atom.Type<typeof original.agents>>(AsyncResult.initial())
  const atoms = { ...original, agents, limitsPoll: Atom.make(Effect.sync(poll)) }
  const registry = AtomRegistry.make({
    initialValues: [
      [atoms.agents, AsyncResult.initial()],
      [atoms.limits, AsyncResult.initial()],
      [atoms.work, AsyncResult.initial()]
    ]
  })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <ConnectSurface atoms={atoms} embedded />
        </RegistryContext.Provider>
      )
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(poll).not.toHaveBeenCalled()
    expect(host.querySelector(".connect-directory-secondary")).toBeNull()
    await act(async () => {
      registry.set(atoms.agents, AsyncResult.success({ agents: [agent], failures: [] }, { timestamp: 0 }))
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    expect(host.querySelector(".connect-directory-secondary")).not.toBeNull()
    expect(poll).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    registry.dispose()
    host.remove()
  }
})

/** Hidden module sections do not hide portal dialogs; their owner and selection must survive. */
it("releases an inactive Home stage's modal and observer without discarding its saved selection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const atoms = makeConnectAtoms()
  const registry = AtomRegistry.make({
    initialValues: [
      [atoms.agents, AsyncResult.success({ agents: [agent], failures: [] }, { timestamp: 0 })],
      [atoms.limits, AsyncResult.initial()],
      [atoms.work, AsyncResult.initial()]
    ]
  })
  const host = document.createElement("div")
  document.body.append(host)
  const sibling = document.createElement("button")
  sibling.textContent = "Other module"
  document.body.append(sibling)
  const initialOverflow = document.documentElement.style.overflow
  const initialOverscroll = document.documentElement.style.overscrollBehavior
  const root = createRoot(host)
  const onStageChange = vi.fn()
  const paint = async (active: boolean) =>
    act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <ConnectSurface
            atoms={atoms}
            embedded
            presentation={{ _tag: "home" }}
            active={active}
            onStageChange={onStageChange}
          />
        </RegistryContext.Provider>
      )
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
  try {
    await paint(true)
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".connect-agent")?.click()
    })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(onStageChange).toHaveBeenLastCalledWith({ host: agent.host, id: agent.id })
    await paint(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(host.closest('[inert], [aria-hidden="true"]')).toBeNull()
    expect(sibling.hasAttribute("inert")).toBe(false)
    expect(sibling.hasAttribute("aria-hidden")).toBe(false)
    expect(document.documentElement.style.overflow).toBe(initialOverflow)
    expect(document.documentElement.style.overscrollBehavior).toBe(initialOverscroll)
    expect(onStageChange).toHaveBeenLastCalledWith(null)
    await paint(true)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(agent.name)
    expect(onStageChange).toHaveBeenLastCalledWith({ host: agent.host, id: agent.id })
  } finally {
    await act(async () => root.unmount())
    registry.dispose()
    host.remove()
    sibling.remove()
    vi.unstubAllGlobals()
  }
})

/** Entry focus failures own the designed notice; other failures retain the shipped alert. */
it.each<ConnectWorkspaceFocusFailureReason>(["detached_element", "focus_rejected"])(
  "announces only the Home entry notice for %s",
  (entryFocusFailure) => {
    const connection = {
      _tag: "failed",
      agent,
      detail: "private_transport_detail",
      entryFocusFailure
    } satisfies Atom.Type<ReturnType<typeof makeConnectAtoms>["connection"]>
    const host = document.createElement("div")
    host.innerHTML = markupFor({ _tag: "home" }, [agent], connection)
    const notice = host.querySelector(".connect-home-failure")
    expect(notice?.getAttribute("role")).toBe("alert")
    expect(notice?.textContent).toContain("Couldn’t open Review worker’s terminal")
    expect(notice?.textContent).toContain(
      entryFocusFailure === "detached_element"
        ? "The terminal view changed before focus could move. Try again."
        : "Couldn’t switch views while another panel has focus. Close it and try again."
    )
    expect(notice?.textContent).not.toContain("private_transport_detail")
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(host.querySelector('.connect-status-message[role="alert"]')).toBeNull()
  }
)

it.each(["terminal input could not be sent", "session_transport_detail"])(
  "retains the shipped Home alert for %s without an entry notice",
  (detail) => {
    const host = document.createElement("div")
    host.innerHTML = markupFor({ _tag: "home" }, [agent], { _tag: "failed", agent, detail })
    expect(host.querySelector(".connect-home-failure")).toBeNull()
    expect(host.querySelector('.connect-status-message[role="alert"]')?.textContent).toBe(`Review worker: ${detail}`)
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1)
  }
)

/** A silent host supplies last-known work, not proof of its current activity. Fleet stays unchanged. */
it("labels a silent-host row Unknown only in Home and retains its cached work and last activity", () => {
  const cachedAgent = { ...agent, state: "working" }
  const failures: ReadonlyArray<ConnectPeerFailure> = [{ host: "ALPHA", reason: "offline" }]
  const home = document.createElement("div")
  home.innerHTML = markupFor({ _tag: "home" }, [cachedAgent], undefined, failures)
  const card = home.querySelector('[data-home-group="unknown"] .connect-home-agent')
  expect(card?.querySelector("[data-home-state]")?.textContent).toBe("Unknown")
  expect(card?.textContent).toContain("Last activity")
  expect(card?.textContent).not.toContain("Last seen")
  expect(card?.textContent).toContain(cachedAgent.work)
  expect(home.querySelector('[data-home-group="unknown"] h2')?.textContent).toBe("Unknown, ALPHA not answering 1")
  const lastActivity = card?.querySelector(".connect-home-last-activity")
  expect(lastActivity).not.toBeNull()
  expect(lastActivity?.nextElementSibling?.classList.contains("connect-agent-work")).toBe(true)
  expect(home.querySelector(".connect-home-read-notice")?.textContent).toContain("ALPHA didn’t answer")
  expect(home.querySelector(".connect-home-read-notice button")?.textContent).toBe("Retry")
  expect(home.querySelector(".connect-failures")).toBeNull()
  const fleet = document.createElement("div")
  fleet.innerHTML = markupFor({ _tag: "fleet" }, [cachedAgent], undefined, failures)
  expect(fleet.querySelector(".connect-agent")?.textContent).toContain("Working")
  expect(fleet.querySelector(".connect-agent")?.textContent).toContain("Old reading")
})

/** The partial notice names exactly the hosts that supplied this reading. */
it("uses singular words for one answering host in a partial reading", () => {
  const failures: ReadonlyArray<ConnectPeerFailure> = [{ host: "cedar", reason: "offline" }]
  const reading = AsyncResult.success({ agents: [agent], failures, hosts: ["ALPHA", "cedar"] }, { timestamp: 0 })
  const host = document.createElement("div")
  host.innerHTML = markupFor({ _tag: "home" }, [agent], undefined, failures, reading)
  expect(host.querySelector(".connect-home-read-notice")?.textContent).toContain("ALPHA is live.")
})

/** Complete-empty Home accepts the host's existing navigation actions without inventing Fleet controls. */
it("renders the Home empty slot instead of empty activity groups", () => {
  const presentation = {
    _tag: "home",
    empty: <p data-home-empty="">No agents on any host yet</p>
  } satisfies ComponentProps<typeof ConnectSurface>["presentation"]
  const host = document.createElement("div")
  host.innerHTML = markupFor(presentation, [])
  expect(host.querySelector("[data-home-empty]")?.textContent).toBe("No agents on any host yet")
  expect(host.querySelector(".connect-home-group")).toBeNull()
})
