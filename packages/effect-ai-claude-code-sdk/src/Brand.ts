/**
 * Branded types for type-safe domain primitives.
 *
 * @since 1.0.0
 * @category Validation
 */

import { Brand } from "effect"

/**
 * API key source type for Claude Agent SDK authentication.
 *
 * - `"user"`: Use user-level API key
 * - `"project"`: Use project-level API key
 * - `"org"`: Use organization-level API key
 * - `"temporary"`: Use temporary API key
 *
 * @example
 * ```typescript
 * import * as Brand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 * import * as AgentClient from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   // Use project-level API key
 *   const result = yield* client.queryText({
 *     prompt: "Hello!",
 *     apiKeySource: "project"
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export type ApiKeySource = "user" | "project" | "org" | "temporary"

/**
 * Branded type for tool names.
 *
 * Ensures that only valid tool names from the SDK's built-in tool set can be used.
 *
 * @example
 * ```typescript
 * import { Brand } from "effect"
 * import * as AgentBrand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 *
 * // Create a tool name
 * const toolName: AgentBrand.ToolName = Brand.nominal<AgentBrand.ToolName>()("Read")
 *
 * // Use in configuration
 * const allowedTools: ReadonlyArray<AgentBrand.ToolName> = [
 *   Brand.nominal<AgentBrand.ToolName>()("Read"),
 *   Brand.nominal<AgentBrand.ToolName>()("Write"),
 *   Brand.nominal<AgentBrand.ToolName>()("Bash")
 * ]
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export type ToolName = string & Brand.Brand<"ToolName">

/**
 * Constructor for ToolName branded type.
 *
 * @example
 * ```typescript
 * import * as Brand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 *
 * const readTool = Brand.ToolName("Read")
 * const bashTool = Brand.ToolName("Bash")
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export const ToolName = Brand.nominal<ToolName>()

/**
 * Branded type for hook names.
 *
 * Ensures that only valid hook names from the SDK's lifecycle hook set can be used.
 *
 * @example
 * ```typescript
 * import { Brand } from "effect"
 * import * as AgentBrand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 *
 * // Create a hook name
 * const hookName: AgentBrand.HookName = Brand.nominal<AgentBrand.HookName>()("SessionStart")
 *
 * // Use in hook configuration
 * const hooks = {
 *   onSessionStart: (context) => Effect.sync(() => console.log("Session started"))
 * }
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export type HookName = string & Brand.Brand<"HookName">

/**
 * Constructor for HookName branded type.
 *
 * @example
 * ```typescript
 * import * as Brand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 *
 * const sessionStart = Brand.HookName("SessionStart")
 * const toolUse = Brand.HookName("PreToolUse")
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export const HookName = Brand.nominal<HookName>()

/**
 * Branded type for working directory paths.
 *
 * Ensures that working directories are non-empty strings representing valid paths.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as Brand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 * import * as AgentClient from "@knpkv/effect-ai-claude-code-sdk/ClaudeAgentClient"
 *
 * const program = Effect.gen(function* () {
 *   // Create working directory with validation
 *   const workingDir = yield* Brand.WorkingDirectory("/path/to/project")
 *
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   const result = yield* client.queryText({
 *     prompt: "List files",
 *     workingDirectory: workingDir
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export type WorkingDirectory = string & Brand.Brand<"WorkingDirectory">

/**
 * Constructor for WorkingDirectory branded type with validation.
 *
 * Validates that the directory path is non-empty.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as Brand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 *
 * // Valid directory
 * const validDir = Brand.WorkingDirectory("/home/user/project")
 *
 * // Invalid directory (empty string) - returns validation error
 * const invalidDir = Brand.WorkingDirectory("")
 *
 * // Use with Effect error handling
 * const program = Effect.gen(function* () {
 *   const dir = yield* Brand.WorkingDirectory("/my/path")
 *   return dir
 * })
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export const WorkingDirectory = Brand.refined<WorkingDirectory>(
  (s) => s.length > 0,
  (s) => Brand.error(`Working directory cannot be empty: "${s}"`)
)

/**
 * Branded type for message IDs.
 *
 * Ensures type safety when working with message identifiers in streams.
 *
 * @example
 * ```typescript
 * import { Brand } from "effect"
 * import * as AgentBrand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 *
 * // Create a message ID
 * const messageId: AgentBrand.MessageId = Brand.nominal<AgentBrand.MessageId>()("msg_123")
 *
 * // Use in error context
 * const error = new StreamError({
 *   message: "Stream failed",
 *   messageId
 * })
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export type MessageId = string & Brand.Brand<"MessageId">

/**
 * Constructor for MessageId branded type.
 *
 * @example
 * ```typescript
 * import * as Brand from "@knpkv/effect-ai-claude-code-sdk/Brand"
 *
 * const msgId = Brand.MessageId("msg_abc123")
 * ```
 *
 * @since 1.0.0
 * @category Validation
 */
export const MessageId = Brand.nominal<MessageId>()
