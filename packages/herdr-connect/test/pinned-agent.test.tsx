import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Result, Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ConnectAgent } from "../src/model.js"
import { pin, type Pins } from "../src/pins.js"
import { PinnedAgents } from "../src/stage.js"
import { connectAgentKey } from "../src/view.js"

const agent = (name: string, state = "waiting") =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "nix",
    id: Schema.decodeUnknownSync(AgentStableId)(name),
    kind: "claude",
    lastActivityAt: 1_000,
    name,
    state,
    work: "npm"
  })

const pinned = (agents: ReadonlyArray<ReturnType<typeof agent>>): Pins =>
  agents.reduce<Pins>(
    (pins, each) =>
      Result.getOrThrow(
        pin(pins, { host: each.host, id: String(each.id), key: connectAgentKey(each), name: each.name }, 0)
      ),
    []
  )

const render = (
  pins: Pins,
  present: ReadonlyArray<ReturnType<typeof agent>>,
  placement: "bar" | "float",
  hiddenKey: string | null = null,
  room?: number
) => {
  const byKey = new Map(present.map((each) => [connectAgentKey(each), each]))
  return renderToStaticMarkup(
    <PinnedAgents
      agentFor={(key) => byKey.get(key)}
      hiddenKey={hiddenKey}
      now={0}
      onOpen={() => undefined}
      onUnpin={() => undefined}
      pins={pins}
      placement={placement}
      room={room}
      stale={false}
    />
  )
}

describe("PinnedAgents", () => {
  // Each chip is two sibling buttons: open names the agent and its state, unpin names the agent.
  it("names each pinned agent and its state, with its own unpin, never nested", () => {
    const reviewer = agent("agent-reviewer")
    const markup = render(pinned([reviewer]), [reviewer], "float")
    expect(markup).toContain('aria-label="Pinned: agent-reviewer, Waiting"')
    expect(markup).toContain('aria-label="Unpin agent-reviewer"')
    expect(markup).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/s)
    expect(markup.match(/class="connect-creature"/g)).toHaveLength(1)
  })

  // Pins show in pin order, as many as the placement has room for; the rest wait behind "+N".
  it("shows the first pins in pin order and counts the rest behind +N, fewer in the terminal's bar", () => {
    const fleet = ["a", "b", "c", "d", "e"].map((name) => agent(`agent-${name}`))
    const pins = pinned(fleet)
    const float = render(pins, fleet, "float")
    expect([...float.matchAll(/aria-label="Pinned: agent-(\w)/g)].map((match) => match[1])).toEqual(["a", "b", "c"])
    expect(float).toContain('aria-label="2 more pinned"')
    const bar = render(pins, fleet, "bar")
    expect([...bar.matchAll(/aria-label="Pinned: agent-(\w)/g)].map((match) => match[1])).toEqual(["a", "b"])
    expect(bar).toContain('aria-label="3 more pinned"')
    // One tab stop for the whole set.
    expect(float.match(/tabindex="0"/g)).toHaveLength(1)
  })

  // A pin whose agent this poll didn't list is never lost: it counts behind +N even when there is room.
  it("puts a pin whose agent is away behind +N, and repeats no pin for the agent that is open", () => {
    const here = agent("agent-here")
    const away = agent("agent-away")
    const markup = render(pinned([away, here]), [here], "float")
    expect(markup).toContain('aria-label="Pinned: agent-here, Waiting"')
    expect(markup).toContain('aria-label="1 more pinned"')
    expect(render(pinned([here]), [here], "float", connectAgentKey(here))).toBe("")
  })

  // A phone's terminal bar keeps every pin behind one button, so the bar never takes a line from the terminal.
  it("puts every pin behind one named button when there is no room for chips", () => {
    const fleet = ["a", "b"].map((name) => agent(`agent-${name}`))
    const markup = render(pinned(fleet), fleet, "bar", null, 0)
    expect(markup).not.toContain('aria-label="Pinned: ')
    expect(markup).toContain('aria-label="2 pinned"')
    expect(markup).toContain(">Pins 2</button>")
  })
})
