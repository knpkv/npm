// @vitest-environment happy-dom

import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"

import { ConnectAgent } from "../src/model.js"
import { AgentDirectory } from "../src/view.js"

Object.defineProperty(window, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })

const agent = (id: string, lastActivityAt: number) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "nix",
    id: Schema.decodeUnknownSync(AgentStableId)(id),
    kind: "claude",
    lastActivityAt,
    name: id,
    state: "working",
    work: "npm"
  })

describe("AgentDirectory rows across polls", () => {
  // A row keyed by its place remounts when a poll re-sorts the list, restarting its creature's breath and
  // blink; keyed by its agent it stays the same element.
  it("keeps each agent's row and creature when an agent joins ahead of it", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const render = (agents: ReadonlyArray<ReturnType<typeof agent>>) =>
      act(async () =>
        root.render(
          <AgentDirectory
            activityFilter="all"
            agents={agents}
            hostFilter={null}
            onActivityFilter={() => undefined}
            onHostFilter={() => undefined}
            onSelect={() => undefined}
            query=""
            selectedKey={null}
            timeZone="UTC"
          />
        )
      )
    const creatureOf = (id: string) => host.querySelector(`.connect-agent[data-agent-key="nix:${id}"] svg`)
    try {
      await render([agent("agent-two", 1_000)])
      const before = creatureOf("agent-two")
      expect(before).not.toBeNull()
      // A new agent that sorts first joins on the next poll, moving agent-two down a place.
      await render([agent("agent-one", 2_000), agent("agent-two", 1_000)])
      expect(host.querySelector(".connect-agent")?.getAttribute("data-agent-key")).toBe("nix:agent-one")
      expect(creatureOf("agent-two")).toBe(before)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
})
