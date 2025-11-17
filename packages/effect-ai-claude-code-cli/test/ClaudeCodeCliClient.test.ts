/**
 * Tests for ClaudeCodeCliClient.
 *
 * @since 1.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { ClaudeCodeCliClient, layer, layerConfig } from "../src/ClaudeCodeCliClient.js"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"

describe("ClaudeCodeCliClient", () => {
  it.effect("should create client with layer", () =>
    Effect.gen(function*() {
      const client = yield* ClaudeCodeCliClient
      expect(client).toBeDefined()
      expect(client.query).toBeDefined()
      expect(client.queryStream).toBeDefined()
    }).pipe(
      Effect.provide(layer()),
      Effect.provide(ClaudeCodeCliConfig.default)
    ))

  it.effect("should create client with layerConfig", () =>
    Effect.gen(function*() {
      const client = yield* ClaudeCodeCliClient
      expect(client).toBeDefined()
    }).pipe(
      Effect.provide(layerConfig),
      Effect.provide(ClaudeCodeCliConfig.default)
    ))
})
