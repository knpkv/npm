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
