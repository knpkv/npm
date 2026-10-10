// @vitest-environment happy-dom

import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"

import { ConnectAgent } from "../src/model.js"
import { AgentCast } from "../src/stage.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const agent = (id: string, state: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "nix",
    id: Schema.decodeUnknownSync(AgentStableId)(id),
    kind: "claude",
    lastActivityAt: 1_000,
    name: id,
    state,
    work: "npm"
  })

describe("AgentCast keyboard stop", () => {
  // The stop follows the agent, not its place: a poll that re-sorts the cast must leave exactly one.
  it("keeps exactly one tab stop on the same agent when a poll re-sorts the cast", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const render = (agents: ReadonlyArray<ReturnType<typeof agent>>) =>
      act(async () => root.render(<AgentCast agents={agents} onOpen={() => undefined} stale={false} />))
    const stops = () => [...host.querySelectorAll('[tabindex="0"]')].map((node) => node.getAttribute("data-agent-key"))
    try {
      const three = (third: string) => [
        agent("agent-one", "working"),
        agent("agent-two", "working"),
        agent("agent-three", third)
      ]
      await render(three("working"))
      const first = host.querySelector<HTMLButtonElement>('[data-agent-key="nix:agent-one"]')
      first?.focus()
      await act(async () => {
        first?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
      })
      expect(stops()).toEqual(["nix:agent-two"])
      // agent-three now needs you and sorts first; agent-two keeps the stop and nothing else gains one.
      await render(three("blocked"))
      expect(stops()).toEqual(["nix:agent-two"])
      // When the agent holding the stop leaves, the stop goes back to the first member.
      await render([agent("agent-one", "working"), agent("agent-three", "blocked")])
      expect(stops()).toEqual(["nix:agent-three"])
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
