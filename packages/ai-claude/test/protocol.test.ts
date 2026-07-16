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

  it.effect("accepts only nonnegative safe-integer usage token counts", () =>
    Effect.gen(function*() {
      const valid = yield* decodeClaudeOutput(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          usage: {
            input_tokens: 0,
            output_tokens: 3,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 2
          }
        }),
        "test"
      )
      expect(valid.usage).toEqual({
        input_tokens: 0,
        output_tokens: 3,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 2
      })

      for (const invalidCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const exit = yield* decodeClaudeOutput(
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "ok",
            usage: { output_tokens: invalidCount }
          }),
          "test"
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }))
})
