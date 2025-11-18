/**
 * Internal utility functions.
 *
 * @since 1.0.0
 * @internal
 */
import * as Command from "@effect/platform/Command"
import * as Schedule from "effect/Schedule"
import type { ClaudeCodeCliError } from "../ClaudeCodeCliError.js"

/**
 * Build CLI command with optional parameters.
 *
 * @param prompt - The text prompt (passed as argument if no tools, omitted if tools are configured)
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
  // When tools are configured, the prompt must be passed via stdin, not as an argument
  const hasTools = (allowedTools && allowedTools.length > 0) || (disallowedTools && disallowedTools.length > 0)

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
    ...(hasTools ? [] : [prompt]) // Only include prompt as argument if no tools
  )
}

/**
 * Rate limit retry schedule with exponential backoff.
 *
 * Retries: 1s, 2s, 4s, 8s, 16s (max 5 retries)
 *
 * @since 1.0.0
 * @internal
 */
export const rateLimitSchedule = Schedule.exponential("1 second").pipe(
  Schedule.compose(Schedule.recurs(5)),
  Schedule.whileInput((error: ClaudeCodeCliError) => error._tag === "RateLimitError")
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
