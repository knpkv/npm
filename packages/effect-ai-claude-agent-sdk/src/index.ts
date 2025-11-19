/** */

/**
 * Effect-TS wrapper for Anthropic Claude Agent SDK.
 *
 * This package provides a type-safe Effect integration for the Claude Agent SDK,
 * enabling seamless use of Claude's agent capabilities in Effect-based applications.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk"
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
 */
export * as ClaudeAgentClient from "./ClaudeAgentClient.js"

/** */
export * as ClaudeAgentConfig from "./ClaudeAgentConfig.js"

/** */
export * as ClaudeAgentTool from "./ClaudeAgentTool.js"

/** */
export * as ClaudeAgentHook from "./ClaudeAgentHook.js"

/** */
export * as ClaudeAgentError from "./ClaudeAgentError.js"

/** */
export * as MessageSchemas from "./MessageSchemas.js"

/** */
export * as Brand from "./Brand.js"

/** */
export * as ClaudeAgentLanguageModel from "./ClaudeAgentLanguageModel.js"

/**
 * Convenience type exports for advanced users.
 *
 * These types are re-exported from their respective modules for easier access.
 */
export type { ClaudeAgentClient as ClaudeAgentClientInterface, QueryOptions } from "./ClaudeAgentClient.js"

export type { ClaudeAgentConfig as ClaudeAgentConfigInterface, ClaudeAgentConfigOptions } from "./ClaudeAgentConfig.js"

export type { CanUseToolCallback, ToolName, ToolNameOrString } from "./ClaudeAgentTool.js"

export type { HookHandlers, HookName } from "./ClaudeAgentHook.js"

export type {
  AssistantMessage,
  MessageEvent,
  ResultMessage,
  SessionSummary,
  SystemMessage,
  TokenUsage,
  UserMessage
} from "./MessageSchemas.js"
