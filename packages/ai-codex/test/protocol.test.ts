import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { decodeTranscript } from "../src/internal/protocol.js"

describe("Codex JSONL protocol", () => {
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
