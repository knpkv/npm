import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ConnectAgent } from "../src/model.js"
import { agentStageLead } from "../src/agent-state.js"
import { AgentCast } from "../src/stage.js"

const agent = (id: string, state: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "nix",
    id: Schema.decodeUnknownSync(AgentStableId)(id),
    kind: "claude",
    lastActivityAt: 1_000,
    name: id,
    state,
    work: "Review #721"
  })

describe("agentStageLead", () => {
  // The stage leads with what the state means for the reader, then shows the work in the agent's own words.
  it("names what the agent is doing in fixed words", () => {
    expect(agentStageLead("working", false)).toBe("Working on")
    expect(agentStageLead("waiting", false)).toBe("Waiting for you")
    expect(agentStageLead("blocked", false)).toBe("Blocked")
    expect(agentStageLead("ready", false)).toBe("Ready")
    expect(agentStageLead("done", false)).toBe("Done")
    expect(agentStageLead("working", true)).toBe("Last seen working")
  })
})

describe("AgentCast", () => {
  it("puts the agents that need you first, each as its own named button with a character", () => {
    const markup = renderToStaticMarkup(
      <AgentCast
        agents={[agent("agent-one", "working"), agent("agent-two", "blocked"), agent("agent-three", "done")]}
        onOpen={() => undefined}
        stale={false}
      />
    )
    const order = [...markup.matchAll(/data-agent-key="nix:([^"]+)"/g)].map((match) => match[1])
    expect(order).toEqual(["agent-two", "agent-one", "agent-three"])
    expect(markup.match(/<button/g)).toHaveLength(3)
    expect(markup.match(/class="connect-creature"/g)).toHaveLength(3)
  })
})
