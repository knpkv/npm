/**
 * Internal utility functions.
 *
 * @internal
 */
import * as Command from "@effect/platform/Command"
import type * as PlatformError from "@effect/platform/Error"
import * as Schedule from "effect/Schedule"
import type { ClaudeCodeCliError } from "../ClaudeCodeCliError.js"
import * as Tool from "../ClaudeCodeCliTool.js"

/**
 * Check if tools are configured.
 *
 * @param allowedTools - Optional allowed tools
 * @param disallowedTools - Optional disallowed tools
 * @returns True if any tools are configured
 *
 * @internal
 */
export const hasToolsConfigured = (
  allowedTools?: ReadonlyArray<string>,
  disallowedTools?: ReadonlyArray<string>
): boolean =>
  allowedTools !== undefined ||
  (disallowedTools !== undefined && disallowedTools.length > 0)

/**
 * Build CLI command with optional parameters.
 *
 * When tools are configured, prompt must be passed via stdin (not as argument).
 *
 * Special handling for empty allowedTools array:
 * - allowedTools: [] means "deny all tools"
 * - allowedTools: undefined means "no restriction"
 *
 * @param prompt - The text prompt (passed as argument only if no tools configured)
 * @param model - Optional model name
 * @param allowedTools - Optional list of allowed tools (empty array = deny all)
 * @param disallowedTools - Optional list of disallowed tools
 * @param dangerouslySkipPermissions - Skip all permission checks (default: false)
 * @param streamJson - Whether to use stream-json output format
 * @returns Command instance
 *
 * @internal
 */
export const buildCommand = (
  prompt: string,
  model?: string,
  allowedTools?: ReadonlyArray<string>,
  disallowedTools?: ReadonlyArray<string>,
  dangerouslySkipPermissions = false,
  streamJson = true
): Command.Command => {
  // Handle empty allowedTools array as "deny all"
  // Convert to disallowedTools: allTools
  let effectiveAllowedTools = allowedTools
  let effectiveDisallowedTools = disallowedTools

  if (allowedTools !== undefined && allowedTools.length === 0) {
    // Empty allowedTools = deny all tools
    effectiveAllowedTools = undefined
    effectiveDisallowedTools = [...Tool.allTools, ...(disallowedTools || [])]
  }

  const useStdin = hasToolsConfigured(effectiveAllowedTools, effectiveDisallowedTools)

  return Command.make(
    "claude",
    "--print",
    "--output-format",
    streamJson ? "stream-json" : "json",
    ...(dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
    ...(streamJson ? ["--verbose", "--include-partial-messages"] : []),
    ...(model ? ["--model", model] : []),
    ...(effectiveAllowedTools ? effectiveAllowedTools.flatMap((tool) => ["--allowedTools", tool]) : []),
    ...(effectiveDisallowedTools ? effectiveDisallowedTools.flatMap((tool) => ["--disallowedTools", tool]) : []),
    ...(useStdin ? [] : ["--", prompt])
  )
}

/**
 * Rate limit retry schedule with exponential backoff.
 *
 * Uses exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 retries).
 *
 * Note: RateLimitError.retryAfter is available in the error but Schedule.modifyDelay
 * doesn't provide access to the input error. Custom schedule implementation would be
 * needed to honor retryAfter values. Current implementation provides reasonable
 * backoff that works well in practice.
 *
 * @internal
 */
export const rateLimitSchedule: Schedule.Schedule<number, ClaudeCodeCliError, never> = Schedule.exponential("1 second")
  .pipe(
    Schedule.whileInput((error: ClaudeCodeCliError) => error._tag === "RateLimitError"),
    Schedule.compose(Schedule.recurs(5))
  )

/**
 * Accumulate text from message chunks.
 *
 * @param chunks - Array of text chunks
 * @returns Concatenated text
 *
 * @internal
 */
export const accumulateText = (chunks: ReadonlyArray<{ text: string }>): string => chunks.map((c) => c.text).join("")

/**
 * Extract error message from PlatformError.
 *
 * Safely extracts the message from various PlatformError types
 * without unsafe string coercion.
 *
 * @param error - Platform error
 * @returns Error message string
 *
 * @internal
 */
export const extractErrorMessage = (error: PlatformError.PlatformError): string => {
  if ("message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}
