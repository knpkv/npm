/**
 * @since 1.0.0
 */

/**
 * Effect-TS wrapper for Anthropic Claude Agent SDK.
 *
 * This package provides a type-safe Effect integration for the Claude Agent SDK,
 * enabling seamless use of Claude's agent capabilities in Effect-based applications.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentClient from "@knpkv/effect-ai-claude-code-sdk"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   const result = yield* client.queryText({
 *     prompt: "What is Effect?"
 *   })
 *
 *   console.log(result)
 * })
 *
 * Effect.runPromise(
 *   program.pipe(Effect.provide(AgentClient.layer()))
 * )
 * ```
 *
 * @since 1.0.0
 */
export * as ClaudeAgentClient from "./ClaudeAgentClient.js"

/**
 * @since 1.0.0
 */
export * as ClaudeAgentConfig from "./ClaudeAgentConfig.js"

/**
 * @since 1.0.0
 */
export * as ClaudeAgentTool from "./ClaudeAgentTool.js"

/**
 * @since 1.0.0
 */
export * as ClaudeAgentHook from "./ClaudeAgentHook.js"

/**
 * @since 1.0.0
 */
export * as ClaudeAgentError from "./ClaudeAgentError.js"

/**
 * @since 1.0.0
 */
export * as MessageSchemas from "./MessageSchemas.js"

/**
 * @since 1.0.0
 */
export * as Brand from "./Brand.js"

/**
 * @since 1.0.0
 */
export * as ClaudeAgentLanguageModel from "./ClaudeAgentLanguageModel.js"
