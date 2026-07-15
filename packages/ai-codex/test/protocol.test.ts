import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Predicate } from "effect"
import { CodexFailureCause } from "../src/internal/errors.js"
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

  it.effect("rejects an agent message without a successful terminal event", () =>
    Effect.gen(function*() {
      const exit = yield* decodeTranscript(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Partial" }
      })).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects events emitted after successful turn completion", () =>
    Effect.gen(function*() {
      const exit = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Final" }
        }),
        JSON.stringify({ type: "turn.completed" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Too late" }
        })
      ].join("\n")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("categorizes a duplicate terminal event as a typed protocol failure", () =>
    Effect.gen(function*() {
      const error = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Final" }
        }),
        JSON.stringify({ type: "turn.completed" }),
        JSON.stringify({ type: "turn.completed" })
      ].join("\n")).pipe(Effect.flip)

      expect(error.phase).toBe("protocol")
      expect(Predicate.isTagged(error.cause, "CodexFailureCause")).toBe(true)
      if (Predicate.isTagged(error.cause, "CodexFailureCause")) {
        expect(error.cause).toEqual(new CodexFailureCause({ reason: "event-after-turn-completed" }))
      }
    }))

  it.effect("rejects impossible output token partitions", () =>
    Effect.gen(function*() {
      const exit = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Ready" }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { output_tokens: 12, reasoning_output_tokens: 13 }
        })
      ].join("\n")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("rejects impossible cached input token partitions", () =>
    Effect.gen(function*() {
      const exit = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Ready" }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { cached_input_tokens: 8, input_tokens: 7 }
        })
      ].join("\n")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }))

  it.effect("accepts zero and fully reasoning token partitions", () =>
    Effect.gen(function*() {
      const turn = yield* decodeTranscript([
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Ready" }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            cached_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 7,
            reasoning_output_tokens: 7
          }
        })
      ].join("\n"))

      expect(turn.usage.inputTokens).toEqual({ cacheRead: 0, cacheWrite: undefined, total: 0, uncached: 0 })
      expect(turn.usage.outputTokens).toEqual({ reasoning: 7, text: 0, total: 7 })
    }))

  it.effect("rejects unsafe token count encodings through the protocol channel", () =>
    Effect.gen(function*() {
      const invalidCounts = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]
      for (const outputTokens of invalidCounts) {
        const error = yield* decodeTranscript([
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Ready" }
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { output_tokens: outputTokens }
          })
        ].join("\n")).pipe(Effect.flip)

        expect(error.phase).toBe("protocol")
      }
    }))

  it.effect("rejects usage subcounts without their totals", () =>
    Effect.gen(function*() {
      const fixtures = [
        {
          reason: "invalid-input-usage",
          usage: { cached_input_tokens: 1 }
        },
        {
          reason: "invalid-output-usage",
          usage: { reasoning_output_tokens: 1 }
        }
      ]

      for (const fixture of fixtures) {
        const error = yield* decodeTranscript([
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Ready" }
          }),
          JSON.stringify({ type: "turn.completed", usage: fixture.usage })
        ].join("\n")).pipe(Effect.flip)

        expect(error.phase).toBe("protocol")
        expect(Predicate.isTagged(error.cause, "CodexFailureCause")).toBe(true)
        if (Predicate.isTagged(error.cause, "CodexFailureCause")) {
          expect(error.cause).toEqual(new CodexFailureCause({ reason: fixture.reason }))
        }
      }
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
