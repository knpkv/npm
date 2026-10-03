import { describe, expect, it } from "@effect/vitest"
import { attribute } from "../src/core/Attribution.js"
import { initialCodexState, readCodex } from "../src/core/CodexReader.js"
import { codexMeta, codexTokenCount, codexTurn, codexUserItem, lines, withOrdinal } from "./fixtures.js"

const file = { fileKey: "2026/09/01/rollout-x.jsonl", machine: "ser8", sessionId: "sess" }

describe("readCodex", () => {
  it("books each token_count's last usage with the session's cwd, branch and model", () => {
    const source = lines(
      codexMeta("/home/dev/worktrees/npm/feat/RPS-9", "feat/RPS-9"),
      codexTurn("gpt-6-sol"),
      codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 40, 30, 10], total: 130 })
    )
    const result = readCodex(file, source, initialCodexState)
    expect(result.events).toEqual([{
      agent: "codex",
      dedupeKey: `sess@${source[2]?.offset}`,
      machine: "ser8",
      sessionId: "sess",
      occurredAt: Date.parse("2026-09-01T10:00:05.000Z"),
      model: "gpt-6-sol",
      fast: false,
      // input excludes the 40 cached; output excludes the 10 reasoning.
      tokens: { input: 60, output: 20, reasoning: 10, cacheRead: 40, cacheWrite5m: 0, cacheWrite1h: 0 },
      attribution: { cwd: "/home/dev/worktrees/npm/feat/RPS-9", branch: "feat/RPS-9", activeTicket: null }
    }])
  })

  it("does not book a repeated token_count whose running total did not move", () => {
    const result = readCodex(
      file,
      lines(
        codexTurn("gpt-6-sol"),
        codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 0, 30, 0], total: 130 }),
        codexTokenCount({ at: "2026-09-01T10:00:06.000Z", last: [100, 0, 30, 0], total: 130 })
      ),
      initialCodexState
    )
    expect(result.events).toHaveLength(1)
    expect(result.state.previousTotal?.total).toBe(130)
  })

  it("resumes from carried state, so a later chunk keeps the model and the running total", () => {
    const first = readCodex(
      file,
      lines(codexTurn("gpt-6-sol"), codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [1, 0, 1, 0], total: 2 })),
      initialCodexState
    )
    const second = readCodex(
      file,
      [{
        offset: 900,
        text: JSON.stringify(codexTokenCount({ at: "2026-09-01T10:00:09.000Z", last: [1, 0, 1, 0], total: 2 }))
      }],
      first.state
    )
    expect(second.events).toHaveLength(0)
  })

  it("takes Limit Snapshots and the credit balance only from the account-level codex limit", () => {
    const result = readCodex(
      file,
      lines(
        codexTokenCount({
          at: "2026-09-01T10:00:05.000Z",
          last: [1, 0, 1, 0],
          total: 2,
          primary: { used: 12.5, minutes: 300, resets: 1_790_000_000 },
          secondary: { used: 40, minutes: 10080, resets: 1_790_500_000 },
          credits: { has_credits: true, unlimited: false, balance: "5000.5" }
        }),
        codexTokenCount({
          at: "2026-09-01T10:00:06.000Z",
          last: [1, 0, 1, 0],
          total: 4,
          limitId: "gpt-6-astra",
          primary: { used: 99, minutes: 10080, resets: 1_790_500_000 }
        })
      ),
      initialCodexState
    )
    expect(result.snapshots).toEqual([
      {
        agent: "codex",
        machine: "ser8",
        source: "codex-rollout",
        label: "primary",
        windowMinutes: 300,
        observedAt: Date.parse("2026-09-01T10:00:05.000Z"),
        reading: { _tag: "Known", usedPercent: 12.5, resetsAt: 1_790_000_000_000 }
      },
      {
        agent: "codex",
        machine: "ser8",
        source: "codex-rollout",
        label: "secondary",
        windowMinutes: 10080,
        observedAt: Date.parse("2026-09-01T10:00:05.000Z"),
        reading: { _tag: "Known", usedPercent: 40, resetsAt: 1_790_500_000_000 }
      }
    ])
    expect(result.balances).toEqual([{
      kind: "codex-credits",
      machine: "ser8",
      observedAt: Date.parse("2026-09-01T10:00:05.000Z"),
      value: { _tag: "Known", balance: { _tag: "Credits", credits: 5000.5 } }
    }])
  })

  it("reads an account with no credits as NotSupported, not as an empty balance", () => {
    const result = readCodex(
      file,
      lines(codexTokenCount({
        at: "2026-09-01T10:00:05.000Z",
        last: [1, 0, 1, 0],
        total: 2,
        credits: { has_credits: false, unlimited: false, balance: "0" }
      })),
      initialCodexState
    )
    expect(result.balances[0]?.value).toEqual({ _tag: "Unknown", reason: "NotSupported" })
  })

  it("mines the Active Ticket from typed input, never from injected AGENTS.md or environment items", () => {
    const result = readCodex(
      file,
      lines(
        codexTurn("gpt-6-sol"),
        codexUserItem("# AGENTS.md instructions\n\n<INSTRUCTIONS>approved RPS-1234 and RPS-4242</INSTRUCTIONS>"),
        codexUserItem("<environment_context>\n  <cwd>/w/RPS-4243</cwd>\n</environment_context>"),
        codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [1, 0, 1, 0], total: 2 }),
        codexUserItem("work on RPS-7071"),
        codexTokenCount({ at: "2026-09-01T10:00:09.000Z", last: [1, 0, 1, 0], total: 4 })
      ),
      initialCodexState
    )
    expect(result.events.map((event) => event.attribution.activeTicket)).toEqual([null, "RPS-7071"])
  })

  it("keeps the Active Ticket when a reminder, not the human, mentions another key", () => {
    const result = readCodex(
      file,
      lines(
        codexUserItem("work on RPS-1"),
        codexUserItem("<system-reminder>docs mention RPS-2</system-reminder>"),
        codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [1, 0, 1, 0], total: 2 }),
        codexUserItem("now RPS-2 please"),
        codexTokenCount({ at: "2026-09-01T10:00:09.000Z", last: [1, 0, 1, 0], total: 4 })
      ),
      initialCodexState
    )
    expect(result.events.map((event) => event.attribution.activeTicket)).toEqual(["RPS-1", "RPS-2"])
  })

  it("records a request whose model was never announced under an unpriced placeholder model", () => {
    const result = readCodex(
      file,
      lines(codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [1, 0, 1, 0], total: 2 })),
      initialCodexState
    )
    expect(result.events[0]?.model).toBe("unknown")
  })

  it("recovers the tokens of a token_count that failed to decode by diffing running totals", () => {
    const first = codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 0, 30, 0], total: 130 })
    const third = codexTokenCount({ at: "2026-09-01T10:00:09.000Z", last: [10, 0, 5, 0], total: 300 })
    const result = readCodex(
      file,
      lines(
        codexTurn("gpt-6-sol"),
        first,
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"",
        third
      ),
      initialCodexState
    )
    const booked = result.events.reduce(
      (sum, event) => sum + event.tokens.input + event.tokens.output + event.tokens.reasoning + event.tokens.cacheRead,
      0
    )
    expect(booked).toBe(300)
    expect(result.skipped.unparseableLine).toBe(1)
  })

  it("books the same events read in two halves split after turn_context as in one pass", () => {
    const source = lines(
      codexMeta("/home/dev/code/svc", "feat/RPS-12"),
      codexTurn("gpt-6-sol"),
      codexUserItem("pick up RPS-7071"),
      codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 40, 30, 10], total: 130 }),
      codexTokenCount({ at: "2026-09-01T10:00:06.000Z", last: [100, 40, 30, 10], total: 130 }),
      codexTokenCount({ at: "2026-09-01T10:00:09.000Z", last: [50, 10, 20, 0], total: 200 })
    )
    const onePass = readCodex(file, source, initialCodexState)
    const firstHalf = readCodex(file, source.slice(0, 2), initialCodexState)
    const secondHalf = readCodex(file, source.slice(2), firstHalf.state)
    expect([...firstHalf.events, ...secondHalf.events]).toEqual(onePass.events)
    expect(secondHalf.state).toEqual(onePass.state)
  })

  it("books a fork's copied parent history once: only the fork's own requests count", () => {
    const parent = "parent-0000"
    const result = readCodex(
      { ...file, sessionId: "child-0000" },
      lines(
        codexMeta("/w/svc", "main", { id: "child-0000", historyStart: 4, ordinal: 0 }),
        codexMeta("/w/svc", "main", { id: parent, historyStart: 0, ordinal: 1 }),
        withOrdinal(2, codexTurn("gpt-6-sol")),
        withOrdinal(
          3,
          codexTokenCount({
            at: "2026-09-01T10:00:05.000Z",
            last: [100, 0, 20, 0],
            total: 120,
            primary: { used: 50, minutes: 300, resets: 1_790_000_000 }
          })
        ),
        withOrdinal(4, codexTokenCount({ at: "2026-09-01T10:05:00.000Z", last: [15, 0, 5, 0], total: 140 }))
      ),
      initialCodexState
    )
    expect(result.events.map((event) => event.tokens.input + event.tokens.output)).toEqual([20])
    expect(result.snapshots).toEqual([])
    expect(result.state.ownSession).toBe("child-0000")
  })

  it("finds the fork's own session_meta by the id in its file name, whichever line comes first", () => {
    const child = "019ef5b6-0000-7000-8000-000000000001"
    const result = readCodex(
      { ...file, sessionId: child },
      lines(
        codexMeta("/w/svc", "main", { id: "019eef9d-0000-7000-8000-000000000002", historyStart: 0, ordinal: 1 }),
        codexMeta("/w/svc", "main", { id: child, historyStart: 4, ordinal: 0 }),
        withOrdinal(2, codexTurn("gpt-6-sol")),
        withOrdinal(3, codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 0, 20, 0], total: 120 })),
        withOrdinal(4, codexTokenCount({ at: "2026-09-01T10:05:00.000Z", last: [15, 0, 5, 0], total: 140 }))
      ),
      initialCodexState
    )
    expect(result.state.ownSession).toBe(child)
    expect(result.events.map((event) => event.tokens.input + event.tokens.output)).toEqual([20])
  })

  it("still books a request with the same counts when it is not copied history", () => {
    const result = readCodex(
      file,
      lines(
        codexMeta("/w/svc", "main"),
        withOrdinal(3, codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [100, 0, 20, 0], total: 120 }))
      ),
      initialCodexState
    )
    expect(result.events).toHaveLength(1)
  })

  it("drops the old branch when a turn moves to another worktree, so the new path books the work", () => {
    const source = lines(
      codexMeta("/w/worktrees/repo-old/RPS-12", "feat/RPS-12"),
      codexTurn("gpt-6-sol", "/w/worktrees/repo-old/RPS-12"),
      codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [1, 0, 1, 0], total: 2 }),
      codexTurn("gpt-6-sol", "/w/worktrees/repo-new/RPS-82"),
      codexTokenCount({ at: "2026-09-01T10:00:09.000Z", last: [1, 0, 1, 0], total: 4 })
    )
    const onePass = readCodex(file, source, initialCodexState)
    expect(onePass.events.map((event) => attribute(event.attribution, new Set()).booking)).toEqual([
      { _tag: "Ticket", key: "RPS-12" },
      { _tag: "Ticket", key: "RPS-82" }
    ])
    const first = readCodex(file, source.slice(0, 3), initialCodexState)
    expect(readCodex(file, source.slice(3), first.state).events).toEqual(onePass.events.slice(1))
  })

  it("follows each turn's working directory, keeping the last one when a turn names none", () => {
    const source = lines(
      codexMeta("/w/repo-old", "main"),
      codexTurn("gpt-6-sol", "/w/worktrees/repo-new/RPS-82"),
      codexTokenCount({ at: "2026-09-01T10:00:05.000Z", last: [1, 0, 1, 0], total: 2 }),
      codexTurn("gpt-6-sol"),
      codexTokenCount({ at: "2026-09-01T10:00:09.000Z", last: [1, 0, 1, 0], total: 4 })
    )
    const onePass = readCodex(file, source, initialCodexState)
    expect(onePass.events.map((event) => event.attribution.cwd)).toEqual([
      "/w/worktrees/repo-new/RPS-82",
      "/w/worktrees/repo-new/RPS-82"
    ])
    const first = readCodex(file, source.slice(0, 3), initialCodexState)
    expect(readCodex(file, source.slice(3), first.state).events).toEqual(onePass.events.slice(1))
  })
})
