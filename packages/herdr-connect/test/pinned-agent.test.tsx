import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ConnectAgent } from "../src/model.js"
import { PinnedAgent } from "../src/stage.js"

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "nix",
  id: Schema.decodeUnknownSync(AgentStableId)("agent-reviewer"),
  kind: "claude",
  lastActivityAt: 1_000,
  name: "agent-reviewer",
  state: "waiting",
  work: "npm"
})

describe("PinnedAgent", () => {
  // The pin is one named button whose name says the state, so it reads the same wherever it sits.
  it("names the pinned agent and its state, and says where it sits", () => {
    const placements: ReadonlyArray<"bar" | "float"> = ["bar", "float"]
    for (const placement of placements) {
      const markup = renderToStaticMarkup(
        <PinnedAgent agent={agent} onOpen={() => undefined} placement={placement} stale={false} />
      )
      expect(markup).toContain('aria-label="Pinned: agent-reviewer, Waiting"')
      expect(markup).toContain(`data-placement="${placement}"`)
      expect(markup.match(/class="connect-creature"/g)).toHaveLength(1)
    }
  })
})
