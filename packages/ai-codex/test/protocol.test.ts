import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { decodeTranscript } from "../src/internal/protocol.js"

describe("Codex JSONL protocol", () => {
  it.effect("returns only the final completed agent message", () =>
    Effect.gen(function*() {
      const turn = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "{\"status\":\"checking\"}" }
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "{\"status\":\"ready\"}" }
        }),
        JSON.stringify({ type: "turn.completed" })
      ].join("\n"))

      expect(turn.text).toBe("{\"status\":\"ready\"}")
    }))

  it.effect("separates reasoning tokens from visible output tokens", () =>
    Effect.gen(function*() {
      const turn = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Ready" }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { output_tokens: 12, reasoning_output_tokens: 5 }
        })
      ].join("\n"))

      expect(turn.usage.outputTokens).toEqual({ reasoning: 5, text: 7, total: 12 })
    }))

  it.effect("preserves usage behavior when reasoning tokens are absent", () =>
    Effect.gen(function*() {
      const turn = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Ready" }
        }),
        JSON.stringify({ type: "turn.completed", usage: { output_tokens: 12 } })
      ].join("\n"))

      expect(turn.usage.outputTokens).toEqual({ reasoning: undefined, text: 12, total: 12 })
    }))

  it.effect("rejects a failed turn even after an agent message", () =>
    Effect.gen(function*() {
      const exit = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Not a successful result" }
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "provider failed" } })
      ].join("\n")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects malformed events through the typed error channel", () =>
    Effect.gen(function*() {
      const exit = yield* decodeTranscript("not-json").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects successful turns without an agent message", () =>
    Effect.gen(function*() {
      const exit = yield* decodeTranscript("{\"type\":\"turn.completed\"}").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})
