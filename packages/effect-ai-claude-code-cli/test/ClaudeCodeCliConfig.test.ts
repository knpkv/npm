/**
 * Tests for ClaudeCodeCliConfig.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ClaudeCodeCliConfig } from "../src/ClaudeCodeCliConfig.js"

describe("ClaudeCodeCliConfig", () => {
  describe("default", () => {
    it.effect("should create default config with no overrides", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        expect(config).toBeDefined()
        expect(config.model).toBeUndefined()
        expect(config.allowedTools).toBeUndefined()
        expect(config.disallowedTools).toBeUndefined()
      }).pipe(Effect.provide(ClaudeCodeCliConfig.default)))

    it.effect("should create default config with empty object", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        // Default config should have all fields undefined
        expect(config.model).toBeUndefined()
        expect(config.allowedTools).toBeUndefined()
        expect(config.disallowedTools).toBeUndefined()
      }).pipe(Effect.provide(ClaudeCodeCliConfig.default)))
  })

  describe("custom config", () => {
    it.effect("should create config with model override", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        expect(config.model).toBe("claude-sonnet-4-5")
        expect(config.allowedTools).toBeUndefined()
        expect(config.disallowedTools).toBeUndefined()
      }).pipe(
        Effect.provide(
          Layer.succeed(ClaudeCodeCliConfig, ClaudeCodeCliConfig.of({ model: "claude-sonnet-4-5" }))
        )
      ))

    it.effect("should create config with allowedTools", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        expect(config.model).toBeUndefined()
        expect(config.allowedTools).toEqual(["Read", "Glob", "Bash"])
        expect(config.disallowedTools).toBeUndefined()
      }).pipe(
        Effect.provide(
          Layer.succeed(
            ClaudeCodeCliConfig,
            ClaudeCodeCliConfig.of({ allowedTools: ["Read", "Glob", "Bash"] })
          )
        )
      ))

    it.effect("should create config with disallowedTools", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        expect(config.model).toBeUndefined()
        expect(config.allowedTools).toBeUndefined()
        expect(config.disallowedTools).toEqual(["Write", "Edit"])
      }).pipe(
        Effect.provide(
          Layer.succeed(ClaudeCodeCliConfig, ClaudeCodeCliConfig.of({ disallowedTools: ["Write", "Edit"] }))
        )
      ))

    it.effect("should create config with all options", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        expect(config.model).toBe("claude-opus-4")
        expect(config.allowedTools).toEqual(["Read"])
        expect(config.disallowedTools).toEqual(["Write", "Edit", "Bash"])
      }).pipe(
        Effect.provide(
          Layer.succeed(
            ClaudeCodeCliConfig,
            ClaudeCodeCliConfig.of({
              model: "claude-opus-4",
              allowedTools: ["Read"],
              disallowedTools: ["Write", "Edit", "Bash"]
            })
          )
        )
      ))

    it.effect("should create config with empty tool arrays", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        expect(config.model).toBeUndefined()
        expect(config.allowedTools).toEqual([])
        expect(config.disallowedTools).toEqual([])
      }).pipe(
        Effect.provide(
          Layer.succeed(
            ClaudeCodeCliConfig,
            ClaudeCodeCliConfig.of({
              allowedTools: [],
              disallowedTools: []
            })
          )
        )
      ))
  })

  describe("service identity", () => {
    it.effect("should maintain service tag identity", () =>
      Effect.gen(function*() {
        const config1 = yield* ClaudeCodeCliConfig
        const config2 = yield* ClaudeCodeCliConfig

        // Should return the same instance within the same context
        expect(config1).toBe(config2)
      }).pipe(Effect.provide(ClaudeCodeCliConfig.default)))

    it.effect("should support different configs in different contexts", () =>
      Effect.gen(function*() {
        const defaultConfig = yield* Effect.gen(function*() {
          return yield* ClaudeCodeCliConfig
        }).pipe(Effect.provide(ClaudeCodeCliConfig.default))

        const customConfig = yield* Effect.gen(function*() {
          return yield* ClaudeCodeCliConfig
        }).pipe(
          Effect.provide(
            Layer.succeed(ClaudeCodeCliConfig, ClaudeCodeCliConfig.of({ model: "custom-model" }))
          )
        )

        // Configs should be different objects
        expect(defaultConfig).not.toBe(customConfig)
        expect(defaultConfig.model).toBeUndefined()
        expect(customConfig.model).toBe("custom-model")
      }))
  })

  describe("readonly properties", () => {
    it.effect("should have readonly tool arrays", () =>
      Effect.gen(function*() {
        const config = yield* ClaudeCodeCliConfig

        // TypeScript compile-time check ensures these are readonly
        // Runtime check that arrays are present
        expect(config.allowedTools).toBeDefined()
        expect(Array.isArray(config.allowedTools)).toBe(true)
      }).pipe(
        Effect.provide(
          Layer.succeed(ClaudeCodeCliConfig, ClaudeCodeCliConfig.of({ allowedTools: ["Read"] }))
        )
      ))
  })
})
