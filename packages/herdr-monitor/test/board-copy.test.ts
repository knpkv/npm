import { describe, expect, it } from "@effect/vitest"
import { cardFacts, connectionLine, duration, headline, totals } from "../src/client/board-copy.js"
import type { AgentStatus } from "../src/model.js"

const agent = (overrides: Partial<AgentStatus>): AgentStatus => ({
  id: "a",
  name: "qa-audit",
  task: null,
  state: "idle",
  status: "Waiting",
  blocker: null,
  jiraKey: null,
  branch: null,
  pullRequest: null,
  clockify: null,
  elapsedSeconds: null,
  ...overrides
})

describe("board copy", () => {
  // The one fact names the blocked agent and why, before anything else.
  it("leads with the first blocked agent and its blocker", () => {
    expect(
      headline([
        agent({ id: "a", state: "working" }),
        agent({ id: "b", name: "qa-fix", state: "blocked", blocker: "heavy gate held 60 min" }),
        agent({ id: "c", name: "ui-a", state: "blocked" })
      ])
    ).toBe("qa-fix is blocked: heavy gate held 60 min, and 1 more")
    expect(headline([agent({ state: "working" }), agent({ id: "b" })])).toBe("1 of 2 agents working, none blocked")
    expect(headline([agent({})])).toBe("Nothing running; 1 agent is idle or done")
    expect(headline([])).toBe("No agents published")
  })

  it("counts with commas, not middots", () => {
    expect(totals([agent({ state: "working" }), agent({ id: "b", state: "blocked" })])).toBe(
      "2 agents, 1 working, 1 blocked"
    )
  })

  // QA-104: "0h 10m" read as a typo; hours appear once an hour has passed.
  it("formats durations without a zero hour", () => {
    expect(duration(600)).toBe("10m")
    expect(duration(5400)).toBe("1h 30m")
  })

  // QA-100: unknown fields are named once instead of five "Unavailable" rows.
  it("lists only published facts and names the rest once", () => {
    const facts = cardFacts(agent({ branch: "qa/visual-fixes", elapsedSeconds: 600 }))
    expect(facts.known).toEqual([["Branch", "qa/visual-fixes"], ["Agent elapsed", "10m"]])
    expect(facts.unpublished).toEqual(["Jira", "PR", "Clockify recorded"])
  })

  // QA-97: an outage keeps the last snapshot and says how old it is.
  it("says what an outage shows", () => {
    expect(connectionLine({ _tag: "Offline", shownFrom: null }).rest).toBe(
      "the monitor cannot be reached; retrying every 10 seconds"
    )
    expect(connectionLine({ _tag: "Offline", shownFrom: 0 }).rest).toMatch(/^showing the snapshot from /u)
    expect(connectionLine({ _tag: "Offline", shownFrom: 0 }).word).toBe("Offline")
  })
})
