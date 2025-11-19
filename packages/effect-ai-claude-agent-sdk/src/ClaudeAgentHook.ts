/**
 * Lifecycle hook definitions for Claude Agent SDK.
 *
 * NOTE: Hooks are not yet implemented. This module defines the types and
 * interfaces for future hook support. Hook handlers will not be executed
 * in the current version.
 *
 * TODO: Implement hook execution in ClaudeAgentClient by:
 * - Parsing SDK message stream for hook trigger points
 * - Calling appropriate hook handlers at lifecycle events
 * - Handling hook errors gracefully
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
 * NOTE: Not yet implemented. This interface is provided for future use.
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
