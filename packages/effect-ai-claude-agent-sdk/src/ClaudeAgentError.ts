/**
 * Error types for Claude Agent SDK operations.
 *
 * @category Errors
 */

import { Data } from "effect"

/**
 * Error raised when the Claude Agent SDK encounters an error during initialization or execution.
 *
 * This error typically indicates issues with SDK setup, API communication, or invalid SDK configuration.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentError from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentError"
 *
 * const program = Effect.gen(function* () {
 *   // SDK operation that might fail
 *   yield* Effect.fail(
 *     new AgentError.SdkError({
 *       message: "Failed to initialize SDK",
 *       cause: originalError
 *     })
 *   )
 * })
 *
 * // Handle SDK errors specifically
 * program.pipe(
 *   Effect.catchTag("SdkError", (error) =>
 *     Effect.sync(() => {
 *       console.error("SDK Error:", error.message)
 *       return "fallback"
 *     })
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class SdkError extends Data.TaggedError("SdkError")<{
  /**
   * Human-readable error message describing what went wrong.
   */
  readonly message: string
  /**
   * Optional underlying error that caused this SDK error.
   */
  readonly cause?: unknown
}> {}

/**
 * Error raised when message streaming fails.
 *
 * This error indicates problems with consuming the async generator stream from the SDK,
 * such as network interruptions, malformed messages, or unexpected stream termination.
 *
 * @example
 * ```typescript
 * import { Effect, Stream } from "effect"
 * import * as AgentError from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentError"
 *
 * const handleStream = (stream: Stream.Stream<Message, StreamError>) =>
 *   stream.pipe(
 *     Stream.catchTag("StreamError", (error) =>
 *       Stream.make({
 *         type: "error",
 *         message: `Stream failed: ${error.message}`,
 *         messageId: error.messageId
 *       })
 *     ),
 *     Stream.runCollect
 *   )
 * ```
 *
 * @category Errors
 */
export class StreamError extends Data.TaggedError("StreamError")<{
  /**
   * Human-readable error message describing the streaming failure.
   */
  readonly message: string
  /**
   * Optional message ID where the stream error occurred.
   */
  readonly messageId?: string
  /**
   * Optional underlying error that caused the stream failure.
   */
  readonly cause?: unknown
}> {}

/**
 * Error raised when tool execution fails.
 *
 * This error indicates that a specific tool (Read, Write, Bash, etc.) encountered
 * an error during execution, such as file not found, permission denied, or command failure.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentError from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentError"
 *
 * const executeTool = (toolName: string) =>
 *   Effect.gen(function* () {
 *     // Tool execution that might fail
 *     yield* Effect.fail(
 *       new AgentError.ToolError({
 *         toolName,
 *         message: "Tool execution failed",
 *         cause: toolError
 *       })
 *     )
 *   })
 *
 * // Handle tool errors with context
 * executeTool("Read").pipe(
 *   Effect.catchTag("ToolError", (error) =>
 *     Effect.sync(() => {
 *       console.error(`Tool ${error.toolName} failed:`, error.message)
 *       return null
 *     })
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class ToolError extends Data.TaggedError("ToolError")<{
  /**
   * Name of the tool that failed (e.g., "Read", "Bash", "Write").
   */
  readonly toolName: string
  /**
   * Human-readable error message describing the tool failure.
   */
  readonly message: string
  /**
   * Optional underlying error that caused the tool failure.
   */
  readonly cause?: unknown
}> {}

/**
 * Error raised when input validation fails.
 *
 * This error indicates that user-provided input (prompt, configuration options, etc.)
 * failed schema validation or contained invalid values.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentError from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentError"
 *
 * const validatePrompt = (prompt: string) =>
 *   prompt.length > 0
 *     ? Effect.succeed(prompt)
 *     : Effect.fail(
 *         new AgentError.ValidationError({
 *           field: "prompt",
 *           message: "Prompt cannot be empty"
 *         })
 *       )
 *
 * // Handle validation errors
 * validatePrompt("").pipe(
 *   Effect.catchTag("ValidationError", (error) =>
 *     Effect.sync(() => {
 *       console.error(`Validation failed for ${error.field}:`, error.message)
 *       return "default prompt"
 *     })
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  /**
   * Name of the field that failed validation.
   */
  readonly field: string
  /**
   * Human-readable error message describing why validation failed.
   */
  readonly message: string
  /**
   * Optional input value that failed validation.
   */
  readonly input?: unknown
}> {}

/**
 * Error raised when tool permission is denied.
 *
 * This error indicates that a tool execution was blocked by the permission callback
 * (canUseTool), either due to configuration or security policy.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentError from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentError"
 *
 * const checkPermission = (toolName: string, allowed: boolean) =>
 *   allowed
 *     ? Effect.succeed(toolName)
 *     : Effect.fail(
 *         new AgentError.PermissionError({
 *           toolName,
 *           message: `Tool ${toolName} is not allowed`
 *         })
 *       )
 *
 * // Handle permission errors
 * checkPermission("Bash", false).pipe(
 *   Effect.catchTag("PermissionError", (error) =>
 *     Effect.sync(() => {
 *       console.warn(`Permission denied for ${error.toolName}:`, error.message)
 *       return "permission_denied"
 *     })
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class PermissionError extends Data.TaggedError("PermissionError")<{
  /**
   * Name of the tool that was denied permission.
   */
  readonly toolName: string
  /**
   * Human-readable error message describing why permission was denied.
   */
  readonly message: string
}> {}

/**
 * Union type of all possible Agent SDK errors.
 *
 * Use this type when you want to handle all error cases in a single match expression.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import * as AgentError from "@knpkv/effect-ai-claude-agent-sdk/ClaudeAgentError"
 *
 * const handleError = (error: AgentError.AgentError) => {
 *   switch (error._tag) {
 *     case "SdkError":
 *       return `SDK initialization failed: ${error.message}`
 *     case "StreamError":
 *       return `Stream failed at message ${error.messageId}: ${error.message}`
 *     case "ToolError":
 *       return `Tool ${error.toolName} failed: ${error.message}`
 *     case "ValidationError":
 *       return `Invalid ${error.field}: ${error.message}`
 *     case "PermissionError":
 *       return `Permission denied for ${error.toolName}: ${error.message}`
 *   }
 * }
 * ```
 *
 * @category Errors
 */
export type AgentError = SdkError | StreamError | ToolError | ValidationError | PermissionError
