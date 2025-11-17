/**
 * Configuration service for Claude Code CLI client.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

/**
 * Configuration options for Claude Code CLI client.
 *
 * @example
 * ```typescript
 * import { ClaudeCodeCliConfig, ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
 * import { Effect, Layer } from "effect"
 *
 * const customConfig = Layer.succeed(
 *   ClaudeCodeCliConfig,
 *   ClaudeCodeCliConfig.of({
 *     model: "claude-sonnet-4-5",
 *     allowedTools: ["Bash", "Read"]
 *   })
 * )
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ClaudeCodeCliClient
 *   return yield* client.query("What is Effect?")
 * })
 *
 * Effect.runPromise(
 *   program.pipe(
 *     Effect.provide(ClaudeCodeCliClient.layer()),
 *     Effect.provide(customConfig)
 *   )
 * )
 * ```
 *
 * @category Configuration
 * @since 1.0.0
 */
export class ClaudeCodeCliConfig extends Context.Tag("@knpkv/effect-ai-claude-code-cli/ClaudeCodeCliConfig")<
  ClaudeCodeCliConfig,
  {
    /**
     * Optional model name override.
     * If not specified, uses CLI's default model.
     *
     * @since 1.0.0
     */
    readonly model?: string

    /**
     * Optional list of tools that can execute without prompting.
     * Maps to CLI's --allowedTools flag.
     *
     * @since 1.0.0
     */
    readonly allowedTools?: ReadonlyArray<string>

    /**
     * Optional list of tools that should be blocked.
     * Maps to CLI's --disallowedTools flag.
     *
     * @since 1.0.0
     */
    readonly disallowedTools?: ReadonlyArray<string>
  }
>() {
  /**
   * Default configuration with no overrides.
   *
   * @since 1.0.0
   */
  static readonly default: Layer.Layer<ClaudeCodeCliConfig> = Layer.succeed(
    ClaudeCodeCliConfig,
    ClaudeCodeCliConfig.of({})
  )
}
