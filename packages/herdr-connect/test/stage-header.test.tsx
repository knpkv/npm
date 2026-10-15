// @vitest-environment happy-dom

import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"

import { ConnectAgent } from "../src/model.js"
import { AgentStage } from "../src/stage.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "hub",
  id: Schema.decodeUnknownSync(AgentStableId)("agent-1"),
  kind: "codex",
  lastActivityAt: 0,
  name: "Agent",
  state: "waiting",
  work: "Reviewing the release"
})

/** Capture Fleet's shipped title/close region before adding the Home presentation. */
it("keeps the shipped Fleet stage header", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <AgentStage
          agent={agent}
          crew={[]}
          onClose={() => undefined}
          onOpen={() => undefined}
          onOpenTerminal={() => undefined}
          onPinChange={() => undefined}
          pinned={false}
          stale={false}
          workGoal={{ _tag: "missing" }}
        />
      )
    )
    const header = document.querySelector(".connect-stage-sheet > div:first-child")
    expect(header?.outerHTML.replace(/id="[^"]+"/gu, 'id="INSTANCE"')).toMatchSnapshot()
    expect(document.querySelector(".connect-home-stage-header")).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

/** The Home chrome closes through the same owner callback as the retained Fleet sheet. */
it("adds Home Back and Close without changing the agent's dialog name", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const closed = vi.fn()
  try {
    await act(async () =>
      root.render(
        <AgentStage
          agent={agent}
          crew={[]}
          onClose={closed}
          onOpen={() => undefined}
          onOpenTerminal={() => undefined}
          onPinChange={() => undefined}
          pinned={false}
          presentation="home"
          stale={false}
          workGoal={{ _tag: "missing" }}
        />
      )
    )
    const dialog = document.querySelector('[role="dialog"]')
    const label = dialog?.getAttribute("aria-labelledby")
    expect(label === null || label === undefined ? null : document.getElementById(label)?.textContent).toBe("Agent")
    const header = document.querySelector(".connect-home-stage-header")
    expect(header?.querySelector("h2")?.textContent).toBe("ConnectAgent")
    for (const name of ["Back to Connect", "Close"]) {
      const button = header?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)
      expect(button).not.toBeNull()
      await act(async () => button?.click())
    }
    expect(closed).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

/** Export 53 keeps terminal ownership failures in the selected agent's stage with an explicit action. */
it.each([
  {
    state: "controlled",
    heading: "Open on another device",
    body: "This terminal is in use on another device. Taking over disconnects it there.",
    action: "Take over"
  },
  {
    state: "taken-over",
    heading: "Taken over on another device",
    body: "This terminal is now open somewhere else.",
    action: "Reconnect"
  }
] satisfies ReadonlyArray<{ state: "controlled" | "taken-over"; heading: string; body: string; action: string }>)(
  "shows the ref's $state terminal panel and preserves its stage action",
  async ({ action, body, heading, state }) => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const actOnTerminal = vi.fn()
    try {
      await act(async () =>
        root.render(
          <AgentStage
            agent={agent}
            crew={[]}
            onClose={() => undefined}
            onOpen={() => undefined}
            onOpenTerminal={() => undefined}
            onPinChange={() => undefined}
            pinned={false}
            presentation="home"
            stale={false}
            workGoal={{ _tag: "missing" }}
            terminalControl={{ state, onAction: actOnTerminal }}
          />
        )
      )
      const panel = document.querySelector(".connect-terminal-control")
      expect(panel?.querySelector("h3")?.textContent).toBe(heading)
      expect(panel?.querySelector("p")?.textContent).toBe(body)
      const button = panel?.querySelector<HTMLButtonElement>("button")
      expect(button?.textContent).toBe(action)
      expect(document.activeElement).toBe(button)
      await act(async () => button?.click())
      expect(actOnTerminal).toHaveBeenCalledTimes(1)
      expect(document.querySelector(".connect-home-stage-header")).not.toBeNull()
      expect(panel?.querySelector("[role='alert']")).toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  }
)

/** Inventory refreshes replace records without changing the focused recovery dialog's identity. */
it("keeps Close focused through an inventory refresh and focuses a new recovery state", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const paint = async (record: ConnectAgent, state: "controlled" | "taken-over") =>
    act(async () =>
      root.render(
        <AgentStage
          agent={record}
          crew={[]}
          onClose={() => undefined}
          onOpen={() => undefined}
          onOpenTerminal={() => undefined}
          onPinChange={() => undefined}
          pinned={false}
          presentation="home"
          stale={false}
          workGoal={{ _tag: "missing" }}
          terminalControl={{ state, onAction: () => undefined }}
        />
      )
    )
  try {
    await paint(agent, "controlled")
    const action = document.querySelector<HTMLButtonElement>(".connect-terminal-control button")
    expect(action?.textContent).toBe("Take over")
    expect(document.activeElement).toBe(action)
    const close = document.querySelector<HTMLButtonElement>('.connect-home-stage-header button[aria-label="Close"]')
    expect(close).not.toBeNull()
    close?.focus()
    expect(document.activeElement).toBe(close)
    const refreshed = { ...agent, work: "Checking the next release", lastActivityAt: 5_000 }
    await paint(refreshed, "controlled")
    expect(document.activeElement).toBe(close)
    expect(document.querySelector(".connect-terminal-stage-identity")?.textContent).toContain(refreshed.work)
    await paint(refreshed, "taken-over")
    expect(action?.textContent).toBe("Reconnect")
    expect(document.activeElement).toBe(action)
    close?.focus()
    await paint({ ...refreshed, id: "agent-other" }, "taken-over")
    expect(document.activeElement).toBe(action)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it("keeps the existing connecting words while a takeover waits without another action", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <AgentStage
          agent={agent}
          crew={[]}
          onClose={() => undefined}
          onOpen={() => undefined}
          onOpenTerminal={() => undefined}
          onPinChange={() => undefined}
          pinned={false}
          presentation="home"
          stale={false}
          workGoal={{ _tag: "missing" }}
          terminalControl={{ state: "connecting", onAction: () => undefined }}
        />
      )
    )
    const panel = document.querySelector(".connect-terminal-control")
    expect(panel?.textContent).toBe("Connecting to Agent…")
    expect(panel?.querySelector("button")).toBeNull()
    expect(document.querySelector("[role='alert']")).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
