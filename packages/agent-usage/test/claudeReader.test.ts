import { describe, expect, it } from "@effect/vitest"
import { readClaude } from "../src/core/ClaudeReader.js"
import { claudeAssistant, claudeUser, lines } from "./fixtures.js"

const read = (source: ReturnType<typeof lines>, activeTicket: string | null = null) =>
  readClaude({ fileKey: "proj/s.jsonl", machine: "ser8", sessionId: "s-1" }, source, { activeTicket })

describe("readClaude", () => {
  it("records one Usage Event per message, deduped on message id + request id", () => {
    const message = claudeAssistant({ id: "msg_1", at: "2026-09-01T10:00:00.000Z", input: 5, output: 7 })
    const result = read(lines(message, message))
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      agent: "claude",
      dedupeKey: "msg_1 req_msg_1",
      machine: "ser8",
      sessionId: "s-1",
      occurredAt: Date.parse("2026-09-01T10:00:00.000Z"),
      model: "claude-opus-5",
      fast: false,
      tokens: { input: 5, output: 7, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      attribution: { cwd: "/home/dev/code/app", branch: "main", activeTicket: null }
    })
  })

  it("keeps a streamed request's final, larger usage", () => {
    const partial = claudeAssistant({ id: "m", at: "2026-09-01T10:00:00.000Z", output: 2 })
    const final = claudeAssistant({ id: "m", at: "2026-09-01T10:00:03.000Z", output: 1_093 })
    const result = read(lines(partial, final))
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.tokens.output).toBe(1_093)
    expect(result.events[0]?.occurredAt).toBe(Date.parse("2026-09-01T10:00:00.000Z"))
  })

  it("keeps the 5m/1h cache-write split and the fast flag pricing needs", () => {
    const result = read(lines(claudeAssistant({
      id: "m",
      at: "2026-09-01T10:00:00.000Z",
      write5m: 3,
      write1h: 4,
      cacheRead: 9,
      speed: "fast"
    })))
    expect(result.events[0]?.tokens).toMatchObject({ cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 9 })
    expect(result.events[0]?.fast).toBe(true)
  })

  it("reads a message whose speed is null as standard speed", () => {
    const result = read(lines(claudeAssistant({ id: "m", at: "2026-09-01T10:00:00.000Z", speed: null })))
    expect(result.events[0]?.fast).toBe(false)
    expect(result.skipped.unparseableLine).toBe(0)
  })

  it("skips zero-token placeholder messages without counting them as problems", () => {
    const result = read(lines(claudeAssistant({ id: "m", at: "2026-09-01T10:00:00.000Z", input: 0, output: 0 })))
    expect(result.events).toHaveLength(0)
    expect(result.skipped).toEqual({ unparseableLine: 0, missingTimestamp: 0, oversizedLine: 0 })
  })

  it("counts a relevant line that does not decode instead of dropping it silently", () => {
    const result = read(lines("{\"type\":\"assistant\",\"message\":{\"usage\":", "not json at all"))
    expect(result.skipped).toEqual({ unparseableLine: 1, missingTimestamp: 0, oversizedLine: 0 })
  })

  it("sets the Active Ticket from what the human typed and carries it to later requests", () => {
    const result = read(lines(
      claudeUser("please fix RPS-7071"),
      claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" }),
      claudeUser([{ type: "tool_result", content: "mentions RPS-5000" }]),
      claudeAssistant({ id: "b", at: "2026-09-01T10:01:00.000Z" })
    ))
    expect(result.events.map((event) => event.attribution.activeTicket)).toEqual(["RPS-7071", "RPS-7071"])
    expect(result.state).toEqual({ activeTicket: "RPS-7071" })
  })

  it("clears the Active Ticket when the human types a turn that names none or several", () => {
    const result = read(
      lines(
        claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" }),
        claudeUser("now something else"),
        claudeAssistant({ id: "b", at: "2026-09-01T10:01:00.000Z" })
      ),
      "RPS-1"
    )
    expect(result.events.map((event) => event.attribution.activeTicket)).toEqual(["RPS-1", null])
  })

  it("reads the ticket typed after a slash command, but not one inside a reminder", () => {
    const result = read(lines(
      claudeUser(
        "<command-name>/pr-review</command-name><command-message>pr-review</command-message>" +
          "<command-args>RPS-7071</command-args><system-reminder>AGENTS.md: RPS-4242</system-reminder>"
      ),
      claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" })
    ))
    expect(result.events[0]?.attribution.activeTicket).toBe("RPS-7071")
  })

  it("takes the Active Ticket from Claude Code's record of the last typed prompt", () => {
    const result = read(lines(
      { type: "last-prompt", lastPrompt: "continue RPS-7071", leafUuid: "x", sessionId: "s-1" },
      claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" })
    ))
    expect(result.events[0]?.attribution.activeTicket).toBe("RPS-7071")
  })

  it("ignores the task a parent agent hands a subagent", () => {
    const result = read(
      lines(
        claudeUser("investigate RPS-2 for me", false, true),
        claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" })
      ),
      "RPS-1"
    )
    expect(result.events[0]?.attribution.activeTicket).toBe("RPS-1")
  })

  it("never mines keys from injected context: reminders quoting AGENTS.md or meta turns", () => {
    const result = read(lines(
      claudeUser("<system-reminder>AGENTS.md: approved RPS-4242 ✅</system-reminder>"),
      claudeUser("Caveat: RPS-4243", true),
      claudeAssistant({ id: "a", at: "2026-09-01T10:00:00.000Z" })
    ))
    expect(result.events[0]?.attribution.activeTicket).toBeNull()
  })
})
