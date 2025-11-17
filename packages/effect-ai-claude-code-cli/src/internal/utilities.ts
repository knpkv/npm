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
 * @param prompt - The text prompt
 * @param model - Optional model name
 * @param allowedTools - Optional list of allowed tools
 * @param disallowedTools - Optional list of disallowed tools
 * @returns Command instance
 *
 * @since 1.0.0
 * @internal
 */
export const buildCommand = (
  prompt: string,
  model?: string,
  allowedTools?: ReadonlyArray<string>,
  disallowedTools?: ReadonlyArray<string>
): Command.Command =>
  Command.make(
    "claude",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    ...(model ? ["--model", model] : []),
    ...(allowedTools ? allowedTools.flatMap((tool) => ["--allowedTools", tool]) : []),
    ...(disallowedTools ? disallowedTools.flatMap((tool) => ["--disallowedTools", tool]) : [])
  )

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
