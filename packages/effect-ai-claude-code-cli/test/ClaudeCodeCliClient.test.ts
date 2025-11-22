/**
 * Tests for ClaudeCodeCliClient.
 *
 * Note: These tests require Claude Code CLI to be installed.
 * In CI environments without CLI, they verify graceful error handling.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ClaudeCodeCliClient, layer, layerConfig } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"
import { CliNotFoundError } from "../src/ClaudeCodeCliError.js"

describe("ClaudeCodeCliClient", () => {
  it.effect("should create client with layer", () =>
    Effect.gen(function*() {
      const client = yield* ClaudeCodeCliClient
      expect(client).toBeDefined()
      expect(client.query).toBeDefined()
      expect(client.queryStream).toBeDefined()
    }).pipe(
      Effect.provide(layer()),
      Effect.provide(ClaudeCodeCliConfig.default),
      Effect.catchTag("CliNotFoundError", () =>
        Effect.sync(() => {
          // In CI without CLI, just verify error is properly typed
          expect(true).toBe(true)
        }))
    ))

  it.effect("should create client with layerConfig", () =>
    Effect.gen(function*() {
      const client = yield* ClaudeCodeCliClient
      expect(client).toBeDefined()
    }).pipe(
      Effect.provide(layerConfig),
      Effect.provide(ClaudeCodeCliConfig.default),
      Effect.catchTag("CliNotFoundError", () =>
        Effect.sync(() => {
          // In CI without CLI, just verify error is properly typed
          expect(true).toBe(true)
        }))
    ))

  it.effect("should handle CLI availability check", () =>
    Effect.gen(function*() {
      // This test verifies error handling when CLI is unavailable
      const result = yield* Effect.gen(function*() {
        const client = yield* ClaudeCodeCliClient
        return client
      }).pipe(
        Effect.provide(layer()),
        Effect.provide(ClaudeCodeCliConfig.default),
        Effect.either
      )

      // Either succeeds (CLI installed) or fails with CliNotFoundError
      if (result._tag === "Left") {
        // In CI - CLI not available
        expect(result.left).toBeInstanceOf(CliNotFoundError)
      } else {
        // Locally - CLI is available
        expect(result.right.query).toBeDefined()
        expect(result.right.queryStream).toBeDefined()
      }
    }))
})
