/**
 * Lifecycle hook definitions for Claude Agent SDK.
 *
 * @category Hooks
 */

import type { Effect } from "effect"
import type * as Brand from "./Brand.js"

/**
 * Type alias for hook names (using branded type).
 *
 * @category Hooks
 */
export type HookName = Brand.HookName

/**
 * All 8 lifecycle hooks available in the Claude Agent SDK.
 *
 * @category Hooks
 */
export const allHooks: ReadonlyArray<string> = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreApiCall",
  "PostApiCall",
  "ModelResponse"
] as const

/**
 * Context provided to SessionStart hook.
 *
 * @category Hooks
 */
export interface SessionStartContext {
  readonly workingDirectory?: string
  readonly apiKeySource?: string
}

/**
 * Context provided to SessionEnd hook.
 *
 * @category Hooks
 */
export interface SessionEndContext {
  readonly duration?: number
  readonly messagesCount?: number
}

/**
 * Context provided to PreToolUse hook.
 *
 * @category Hooks
 */
export interface PreToolUseContext {
  readonly toolName: string
  readonly toolInput?: unknown
}

/**
 * Context provided to PostToolUse hook.
 *
 * @category Hooks
 */
export interface PostToolUseContext {
  readonly toolName: string
  readonly toolInput?: unknown
  readonly toolOutput?: unknown
  readonly error?: unknown
}

/**
 * Context provided to UserPromptSubmit hook.
 *
 * @category Hooks
 */
export interface UserPromptSubmitContext {
  readonly prompt: string
  readonly messageCount?: number
}

/**
 * Context provided to PreApiCall hook.
 *
 * @category Hooks
 */
export interface PreApiCallContext {
  readonly endpoint?: string
  readonly payload?: unknown
}

/**
 * Context provided to PostApiCall hook.
 *
 * @category Hooks
 */
export interface PostApiCallContext {
  readonly endpoint?: string
  readonly response?: unknown
  readonly error?: unknown
}

/**
 * Context provided to ModelResponse hook.
 *
 * @category Hooks
 */
export interface ModelResponseContext {
  readonly content: string
  readonly messageId?: string
}

/**
 * Hook handler functions for lifecycle events.
 *
 * All hook handlers are optional and executed as Effect computations.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as Hook from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentHook"
 * import * as AgentClient from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentClient"
 *
 * const hooks: Hook.HookHandlers = {
 *   onSessionStart: (context) =>
 *     Effect.sync(() => {
 *       console.log("Session started:", context.workingDirectory)
 *     }),
 *
 *   onPreToolUse: (context) =>
 *     Effect.sync(() => {
 *       console.log("About to use tool:", context.toolName)
 *     }),
 *
 *   onPostToolUse: (context) =>
 *     Effect.sync(() => {
 *       if (context.error) {
 *         console.error(`Tool ${context.toolName} failed:`, context.error)
 *       } else {
 *         console.log(`Tool ${context.toolName} succeeded`)
 *       }
 *     }),
 *
 *   onModelResponse: (context) =>
 *     Effect.sync(() => {
 *       console.log("Model response:", context.content.slice(0, 100))
 *     })
 * }
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* AgentClient.ClaudeAgentClient
 *
 *   const result = yield* client.queryText({
 *     prompt: "Hello!",
 *     hooks
 *   })
 *
 *   return result
 * })
 * ```
 *
 * @category Hooks
 */
export interface HookHandlers {
  /**
   * Called when a new session starts.
   */
  readonly onSessionStart?: (context: SessionStartContext) => Effect.Effect<void, never, never>

  /**
   * Called when a session ends.
   */
  readonly onSessionEnd?: (context: SessionEndContext) => Effect.Effect<void, never, never>

  /**
   * Called before a tool is executed.
   */
  readonly onPreToolUse?: (context: PreToolUseContext) => Effect.Effect<void, never, never>

  /**
   * Called after a tool is executed.
   */
  readonly onPostToolUse?: (context: PostToolUseContext) => Effect.Effect<void, never, never>

  /**
   * Called when user submits a prompt.
   */
  readonly onUserPromptSubmit?: (context: UserPromptSubmitContext) => Effect.Effect<void, never, never>

  /**
   * Called before an API call to Anthropic.
   */
  readonly onPreApiCall?: (context: PreApiCallContext) => Effect.Effect<void, never, never>

  /**
   * Called after an API call to Anthropic.
   */
  readonly onPostApiCall?: (context: PostApiCallContext) => Effect.Effect<void, never, never>

  /**
   * Called when model generates a response.
   */
  readonly onModelResponse?: (context: ModelResponseContext) => Effect.Effect<void, never, never>
}
