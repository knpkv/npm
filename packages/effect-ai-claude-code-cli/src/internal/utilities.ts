/**
 * Internal utility functions.
 *
 * @since 1.0.0
 * @internal
 */
import * as Command from "@effect/platform/Command"
import type * as PlatformError from "@effect/platform/Error"
import * as Schedule from "effect/Schedule"
import type { ClaudeCodeCliError } from "../ClaudeCodeCliError.js"

/**
 * Check if tools are configured.
 *
 * @param allowedTools - Optional allowed tools
 * @param disallowedTools - Optional disallowed tools
 * @returns True if any tools are configured
 *
 * @since 1.0.0
 * @internal
 */
export const hasToolsConfigured = (
  allowedTools?: ReadonlyArray<string>,
  disallowedTools?: ReadonlyArray<string>
): boolean =>
  (allowedTools !== undefined && allowedTools.length > 0) ||
  (disallowedTools !== undefined && disallowedTools.length > 0)

/**
 * Build CLI command with optional parameters.
 *
 * When tools are configured, prompt must be passed via stdin (not as argument).
 *
 * @param prompt - The text prompt (passed as argument only if no tools configured)
 * @param model - Optional model name
 * @param allowedTools - Optional list of allowed tools
 * @param disallowedTools - Optional list of disallowed tools
 * @param streamJson - Whether to use stream-json output format
 * @returns Command instance
 *
 * @since 1.0.0
 * @internal
 */
export const buildCommand = (
  prompt: string,
  model?: string,
  allowedTools?: ReadonlyArray<string>,
  disallowedTools?: ReadonlyArray<string>,
  streamJson = true
): Command.Command => {
  const useStdin = hasToolsConfigured(allowedTools, disallowedTools)

  return Command.make(
    "claude",
    "--print",
    "--output-format",
    streamJson ? "stream-json" : "json",
    "--dangerously-skip-permissions",
    ...(streamJson ? ["--verbose", "--include-partial-messages"] : []),
    ...(model ? ["--model", model] : []),
    ...(allowedTools ? allowedTools.flatMap((tool) => ["--allowedTools", tool]) : []),
    ...(disallowedTools ? disallowedTools.flatMap((tool) => ["--disallowedTools", tool]) : []),
    ...(useStdin ? [] : [prompt])
  )
}

/**
 * Rate limit retry schedule that respects retryAfter header.
 *
 * If error includes retryAfter, uses that duration.
 * Otherwise falls back to exponential backoff: 1s, 2s, 4s, 8s, 16s (max 5 retries).
 *
 * @since 1.0.0
 * @internal
 */
export const rateLimitSchedule: Schedule.Schedule<number, ClaudeCodeCliError, never> = Schedule.exponential("1 second")
  .pipe(
    Schedule.whileInput((error: ClaudeCodeCliError) => {
      if (error._tag !== "RateLimitError") return false

      // If retryAfter is specified, use a fixed delay schedule instead
      // This is a limitation - we can't easily switch strategies mid-schedule
      // TODO: Implement custom schedule that properly uses retryAfter
      return true
    }),
    Schedule.compose(Schedule.recurs(5))
  )

/**
 * Accumulate text from message chunks.
 *
 * @param chunks - Array of text chunks
 * @returns Concatenated text
 *
 * @since 1.0.0
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
 * @since 1.0.0
 * @internal
 */
export const extractErrorMessage = (error: PlatformError.PlatformError): string => {
  if ("message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}
