/**
 * Configuration service for Claude Agent SDK.
 *
 * @since 1.0.0
 * @category Config
 */

import { Context, Layer } from "effect"
import type * as Brand from "./Brand.js"
import type * as Hook from "./ClaudeAgentHook.js"
import type * as Tool from "./ClaudeAgentTool.js"

/**
 * Configuration options for Claude Agent Client.
 *
 * @example
 * ```typescript
 * import * as AgentConfig from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentConfig"
 * import * as Tool from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentTool"
 * import { Effect } from "effect"
 *
 * const config: AgentConfig.ClaudeAgentConfigOptions = {
 *   apiKeySource: "project",
 *   workingDirectory: "/home/user/project",
 *   allowedTools: ["Read", "Write", "Edit"],
 *   canUseTool: Tool.allowList(["Read", "Write"]),
 *   hooks: {
 *     onSessionStart: (ctx) =>
 *       Effect.sync(() => console.log("Session started"))
 *   }
 * }
 * ```
 *
 * @since 1.0.0
 * @category Config
 */
export interface ClaudeAgentConfigOptions {
  /**
   * API key source for authentication.
   *
   * - `"user"`: User-level API key
   * - `"project"`: Project-level API key (recommended)
   * - `"org"`: Organization-level API key
   * - `"temporary"`: Temporary API key
   */
  readonly apiKeySource?: Brand.ApiKeySource

  /**
   * Working directory for SDK execution context.
   *
   * Defaults to process.cwd() if not specified.
   */
  readonly workingDirectory?: string

  /**
   * List of tool names that are allowed to execute.
   *
   * If specified, only these tools will be available. Cannot be used with disallowedTools.
   */
  readonly allowedTools?: ReadonlyArray<Tool.ToolNameOrString>

  /**
   * List of tool names that are not allowed to execute.
   *
   * If specified, all tools except these will be available. Cannot be used with allowedTools.
   */
  readonly disallowedTools?: ReadonlyArray<Tool.ToolNameOrString>

  /**
   * Custom permission callback for fine-grained tool control.
   *
   * This callback is invoked for each tool execution and should return an Effect
   * that resolves to true (allow) or false (deny).
   */
  readonly canUseTool?: Tool.CanUseToolCallback

  /**
   * Dangerously skip all permission checks.
   * WARNING: Only use for trusted, non-interactive automation.
   * Default: false (permissions required)
   */
  readonly dangerouslySkipPermissions?: boolean

  /**
   * Lifecycle hook handlers.
   *
   * Hooks allow you to inject custom logic at various points in the SDK execution lifecycle.
   */
  readonly hooks?: Hook.HookHandlers
}

/**
 * Configuration service interface.
 *
 * @since 1.0.0
 * @category Config
 */
export interface ClaudeAgentConfig extends ClaudeAgentConfigOptions {
  readonly _tag: "ClaudeAgentConfig"
}

/**
 * Configuration service tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentConfig from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentConfig"
 *
 * const program = Effect.gen(function* () {
 *   const config = yield* AgentConfig.ClaudeAgentConfig
 *
 *   console.log("Working directory:", config.workingDirectory)
 *   console.log("API key source:", config.apiKeySource)
 * })
 * ```
 *
 * @since 1.0.0
 * @category Config
 */
export const ClaudeAgentConfig = Context.GenericTag<ClaudeAgentConfig>(
  "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentConfig"
)

/**
 * Create a configuration service from options.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentConfig from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentConfig"
 * import * as Tool from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentTool"
 *
 * const config = AgentConfig.make({
 *   apiKeySource: "project",
 *   workingDirectory: "/my/project",
 *   canUseTool: Tool.allowList(["Read", "Grep"])
 * })
 *
 * const program = Effect.gen(function* () {
 *   // Config is now available
 *   const cfg = yield* AgentConfig.ClaudeAgentConfig
 *   return cfg
 * }).pipe(Effect.provideService(AgentConfig.ClaudeAgentConfig, config))
 * ```
 *
 * @since 1.0.0
 * @category Config
 */
export const make = (options: ClaudeAgentConfigOptions = {}): ClaudeAgentConfig => ({
  _tag: "ClaudeAgentConfig",
  ...options
})

/**
 * Create a Layer that provides the configuration service.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentConfig from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentConfig"
 * import * as Tool from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentTool"
 *
 * const configLayer = AgentConfig.layer({
 *   apiKeySource: "user",
 *   workingDirectory: process.cwd(),
 *   canUseTool: Tool.denyList(["Bash", "KillShell"])
 * })
 *
 * const program = Effect.gen(function* () {
 *   const config = yield* AgentConfig.ClaudeAgentConfig
 *   return config.apiKeySource
 * })
 *
 * Effect.runPromise(program.pipe(Effect.provide(configLayer)))
 * ```
 *
 * @since 1.0.0
 * @category Config
 */
export const layer = (options: ClaudeAgentConfigOptions = {}): Layer.Layer<ClaudeAgentConfig> =>
  Layer.succeed(ClaudeAgentConfig, make(options))

/**
 * Default configuration with no restrictions.
 *
 * - No API key source specified (SDK will auto-detect)
 * - Working directory defaults to process.cwd()
 * - All tools allowed
 * - No hooks configured
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentConfig from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentConfig"
 *
 * const program = Effect.gen(function* () {
 *   const config = yield* AgentConfig.ClaudeAgentConfig
 *   return config
 * }).pipe(Effect.provideService(AgentConfig.ClaudeAgentConfig, AgentConfig.defaultConfig))
 * ```
 *
 * @since 1.0.0
 * @category Config
 */
export const defaultConfig: ClaudeAgentConfig = make()
