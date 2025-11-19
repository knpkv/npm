/**
 * Tool definitions and permission management for Claude Agent SDK.
 *
 * @since 1.0.0
 * @category Tools
 */

import { Effect } from "effect"
import type * as Brand from "./Brand.js"

/**
 * Type alias for tool names (using branded type).
 *
 * @since 1.0.0
 * @category Tools
 */
export type ToolName = Brand.ToolName

/**
 * All 16 built-in tools available in the Claude Agent SDK.
 *
 * @example
 * ```typescript
 * import * as Tool from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentTool"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   // Use specific tools
 *   const result = yield* client.queryText({
 *     prompt: "Read package.json",
 *     allowedTools: Tool.allTools.slice(0, 3) // Read, Write, Edit
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @since 1.0.0
 * @category Tools
 */
export const allTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
  "SlashCommand",
  "Skill",
  "TodoWrite",
  "AskUserQuestion",
  "NotebookEdit",
  "BashOutput",
  "KillShell"
] as const

/**
 * Union type of all known tool names.
 *
 * @since 1.0.0
 * @category Tools
 */
export type KnownToolName = (typeof allTools)[number]

/**
 * Tool name that can be either a known tool or a custom string.
 *
 * Provides autocomplete for known tools while allowing custom tool names.
 *
 * @since 1.0.0
 * @category Tools
 */
export type ToolNameOrString = KnownToolName | (string & {})

/**
 * Callback function type for tool permission decisions.
 *
 * The callback receives the tool name and returns an Effect that resolves to a boolean
 * indicating whether the tool is allowed to execute.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as Tool from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentTool"
 *
 * // Simple permission callback
 * const canUseTool: Tool.CanUseToolCallback = (toolName) =>
 *   Effect.succeed(toolName !== "Bash") // Deny Bash, allow others
 *
 * // Async permission callback with logging
 * const canUseToolAsync: Tool.CanUseToolCallback = (toolName) =>
 *   Effect.gen(function* () {
 *     yield* Effect.sync(() => console.log(`Checking permission for ${toolName}`))
 *
 *     // Check against whitelist
 *     const allowed = ["Read", "Write", "Edit"].includes(toolName)
 *
 *     yield* Effect.sync(() =>
 *       console.log(`${toolName}: ${allowed ? "ALLOWED" : "DENIED"}`)
 *     )
 *
 *     return allowed
 *   })
 * ```
 *
 * @since 1.0.0
 * @category Tools
 */
export type CanUseToolCallback = (toolName: string) => Effect.Effect<boolean, never, never>

/**
 * Permission helper that allows all tools.
 *
 * @example
 * ```typescript
 * import * as Tool from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentTool"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   const result = yield* client.queryText({
 *     prompt: "Use any tool you need",
 *     canUseTool: Tool.allowAll
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @since 1.0.0
 * @category Tools
 */
export const allowAll: CanUseToolCallback = () => Effect.succeed(true)

/**
 * Permission helper that denies all tools.
 *
 * @example
 * ```typescript
 * import * as Tool from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentTool"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   // Prevent all tool usage
 *   const result = yield* client.queryText({
 *     prompt: "Answer without using tools",
 *     canUseTool: Tool.denyAll
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @since 1.0.0
 * @category Tools
 */
export const denyAll: CanUseToolCallback = () => Effect.succeed(false)

/**
 * Permission helper that allows only specified tools.
 *
 * @example
 * ```typescript
 * import * as Tool from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentTool"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   // Only allow safe read-only tools
 *   const result = yield* client.queryText({
 *     prompt: "Analyze the codebase",
 *     canUseTool: Tool.allowList(["Read", "Glob", "Grep"])
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @since 1.0.0
 * @category Tools
 */
export const allowList = (tools: ReadonlyArray<ToolNameOrString>): CanUseToolCallback => (toolName) =>
  Effect.succeed(tools.includes(toolName))

/**
 * Permission helper that denies only specified tools.
 *
 * @example
 * ```typescript
 * import * as Tool from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentTool"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   // Deny dangerous tools, allow everything else
 *   const result = yield* client.queryText({
 *     prompt: "Help me with this task",
 *     canUseTool: Tool.denyList(["Bash", "KillShell"])
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @since 1.0.0
 * @category Tools
 */
export const denyList = (tools: ReadonlyArray<ToolNameOrString>): CanUseToolCallback => (toolName) =>
  Effect.succeed(!tools.includes(toolName))
