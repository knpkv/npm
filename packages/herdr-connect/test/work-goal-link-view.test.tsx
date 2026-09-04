import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { AgentStableId } from "@knpkv/herdr-fleet/model"
import { renderToStaticMarkup } from "react-dom/server"
import { ConnectAgent } from "../src/model.js"
import { ConnectAgentIdentity } from "../src/work-goal-link-view.js"

const agent = Schema.decodeUnknownSync(ConnectAgent)({
  host: "SER8",
  id: Schema.decodeUnknownSync(AgentStableId)("agent-reviewer"),
  kind: "codex",
  lastActivityAt: 1_000,
  name: "Review worker",
  state: "connected",
  work: "npm"
})

describe("ConnectAgentIdentity", () => {
  it("renders the connected title as the exact Work goal link", () => {
    const markup = renderToStaticMarkup(
      <ConnectAgentIdentity
        agent={agent}
        resolution={{
          _tag: "available",
          goalId: "goal-review",
          href: "/?tab=work&window=now&goal=goal-review",
          title: "Review browser pairing"
        }}
      />
    )
    expect(markup).toContain('href="/?tab=work&amp;window=now&amp;goal=goal-review"')
    expect(markup).toContain("Review worker")
    expect(markup).toContain("Review browser pairing")
    expect(markup).toContain('data-work-goal-state="available"')
  })

  it("renders missing and ambiguous associations as explicit unavailable states", () => {
    const missing = renderToStaticMarkup(<ConnectAgentIdentity agent={agent} resolution={{ _tag: "missing" }} />)
    const ambiguous = renderToStaticMarkup(
      <ConnectAgentIdentity agent={agent} resolution={{ _tag: "ambiguous", goalIds: ["goal-review", "goal-second"] }} />
    )
    expect(missing).not.toContain("href=")
    expect(missing).toContain('data-work-goal-state="missing"')
    expect(missing).toContain("Work goal unavailable")
    expect(ambiguous).not.toContain("href=")
    expect(ambiguous).toContain('data-work-goal-state="ambiguous"')
    expect(ambiguous).toContain("multiple Work goals")
  })
})
