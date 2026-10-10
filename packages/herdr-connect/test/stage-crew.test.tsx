// @vitest-environment happy-dom

import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"

import { ConnectAgent } from "../src/model.js"
import { AgentStage } from "../src/stage.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const fields = (id: string, state: string) => ({
  host: "nix",
  id: Schema.decodeUnknownSync(AgentStableId)(id),
  kind: "claude",
  lastActivityAt: 1_000,
  name: id,
  state,
  work: "npm"
})
const agent = (id: string, state: string) => Schema.decodeUnknownSync(ConnectAgent)(fields(id, state))
const delegated = (id: string, state: string, parent: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    ...fields(id, state),
    relationship: { parentAgentId: parent, relation: "delegated" }
  })

describe("AgentStage crew", () => {
  // The agents it started are named, each with its state, and open their own stage.
  it("lists the agents it started as named buttons that open their stage", async () => {
    const parent = agent("agent-coordinator", "running")
    const child = delegated("agent-reviewer", "waiting", "agent-coordinator")
    const opened = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <AgentStage
            agent={parent}
            crew={[child]}
            onClose={() => undefined}
            onOpen={opened}
            onOpenTerminal={() => undefined}
            onPinChange={() => undefined}
            pinned={false}
            stale={false}
            workGoal={{ _tag: "missing" }}
          />
        )
      )
      const crew = document.querySelector("nav[aria-label='Workers and reviewers']")
      expect(crew).not.toBeNull()
      const member = crew?.querySelector("button")
      expect(member?.textContent).toContain("agent-reviewer")
      expect(member?.textContent).toContain("Waiting")
      await act(async () => member?.click())
      expect(opened).toHaveBeenCalledWith(child)
      // The pin's label says the action, without also being a pressed toggle.
      const pin = [...document.querySelectorAll("button")].find((button) => button.textContent === "Pin")
      expect(pin).toBeDefined()
      expect(pin?.hasAttribute("aria-pressed")).toBe(false)
      // No goal on the board, no link to one.
      expect(document.querySelector(".connect-stage-goal")).toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })

  // From an agent's stage, its goal on the Work board is one tap away, as the board links back to the stage.
  it("links to the agent's Work goal when the board has exactly one", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <AgentStage
            agent={agent("agent-coordinator", "running")}
            crew={[]}
            onClose={() => undefined}
            onOpen={() => undefined}
            onOpenTerminal={() => undefined}
            onPinChange={() => undefined}
            pinned={false}
            stale={false}
            workGoal={{
              _tag: "available",
              goalId: "pr-knpkv_npm-752",
              href: "/work/?goal=pr-knpkv_npm-752",
              title: "Pin more than one agent"
            }}
          />
        )
      )
      const link = document.querySelector<HTMLAnchorElement>("a.connect-stage-goal")
      expect(link?.textContent).toBe("Work goal: Pin more than one agent")
      expect(link?.getAttribute("href")).toBe("/work/?goal=pr-knpkv_npm-752")
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
