import { describe, expect, it } from "@effect/vitest"
import type { AttributionInputs, Tokens } from "../src/core/Model.js"
import { buildSessionsReport, MAX_SESSIONS } from "../src/core/Sessions.js"
import type { SessionGroup } from "../src/core/Store.js"

const tokens = (input: number): Tokens => ({
  input,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0
})

const onTicket: AttributionInputs = { cwd: "/work/rly", branch: "RLY-142-ledger", activeTicket: null }
const onRepo: AttributionInputs = { cwd: "/work/rly", branch: "main", activeTicket: null }
const projects = new Set(["RLY"])

const group = (overrides: Partial<SessionGroup>): SessionGroup => ({
  sessionId: "s-1",
  firstAt: 1_000,
  lastAt: 2_000,
  agent: "claude",
  model: "claude-opus-5",
  fast: false,
  longPrompt: false,
  attribution: onTicket,
  requests: 1,
  tokens: tokens(1_000_000),
  ...overrides
})

describe("buildSessionsReport", () => {
  it("keeps only the requested Booking's sessions, derived at read time from each group's attribution", () => {
    const report = buildSessionsReport(
      [group({ sessionId: "s-1" }), group({ sessionId: "s-2", attribution: onRepo })],
      projects,
      "ticket:RLY-142"
    )
    expect(report.booking).toBe("ticket:RLY-142")
    expect(report.sessions.map((session) => session.sessionId)).toEqual(["s-1"])
    expect(report.omitted).toBe(0)
  })

  it("merges a session's groups: span, requests, tokens, cost, models and branches", () => {
    const report = buildSessionsReport(
      [
        group({ firstAt: 5_000, lastAt: 6_000, requests: 2 }),
        group({ firstAt: 1_000, lastAt: 3_000, model: "claude-sonnet-5", requests: 3 }),
        group({ firstAt: 7_000, lastAt: 9_000, model: "mystery-model", requests: 1 })
      ],
      projects,
      "ticket:RLY-142"
    )
    const [session] = report.sessions
    expect(session).toMatchObject({
      agent: "claude",
      firstAt: 1_000,
      lastAt: 9_000,
      requests: 6,
      branches: ["RLY-142-ledger"],
      models: ["claude-opus-5", "claude-sonnet-5", "mystery-model"],
      unpricedModels: ["mystery-model"],
      unpricedTokens: 1_000_000
    })
    expect(session?.tokens.input).toBe(3_000_000)
    expect(session?.costUsd).toBeGreaterThan(0)
  })

  it("keeps the same session id from two agents apart", () => {
    const report = buildSessionsReport(
      [group({ agent: "claude" }), group({ agent: "codex", model: "gpt-5.5" })],
      projects,
      "ticket:RLY-142"
    )
    expect(report.sessions.map((session) => session.agent).sort()).toEqual(["claude", "codex"])
  })

  it("orders by cost, then most recent, and caps the list with a count of what it left out", () => {
    const many = Array.from(
      { length: MAX_SESSIONS + 3 },
      (_, index) => group({ sessionId: `s-${index}`, lastAt: index, tokens: tokens(1_000 * (index + 1)) })
    )
    const report = buildSessionsReport(many, projects, "ticket:RLY-142")
    expect(report.sessions).toHaveLength(MAX_SESSIONS)
    expect(report.omitted).toBe(3)
    expect(report.sessions[0]?.sessionId).toBe(`s-${MAX_SESSIONS + 2}`)
    const tied = buildSessionsReport(
      [group({ sessionId: "old", lastAt: 1 }), group({ sessionId: "new", lastAt: 2 })],
      projects,
      "ticket:RLY-142"
    )
    expect(tied.sessions.map((session) => session.sessionId)).toEqual(["new", "old"])
  })

  it("answers an unknown Booking with no sessions, not an error", () => {
    expect(buildSessionsReport([group({})], projects, "ticket:NOPE-1")).toEqual({
      booking: "ticket:NOPE-1",
      sessions: [],
      omitted: 0
    })
  })
})
