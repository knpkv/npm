import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { decodeClaudeOutput } from "../src/protocol.js"

describe("Claude output protocol", () => {
  it.effect("decodes a valid result", () =>
    Effect.gen(function*() {
      const result = yield* decodeClaudeOutput(
        "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"ok\"}",
        "test"
      )
      expect(result.result).toBe("ok")
    }))

  it.effect("rejects malformed output", () =>
    Effect.gen(function*() {
      const exit = yield* decodeClaudeOutput("not-json", "test").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})
