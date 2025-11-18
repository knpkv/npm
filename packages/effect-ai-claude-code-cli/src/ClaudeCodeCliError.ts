/**
 * @since 1.0.0
 */
import * as Data from "effect/Data"

/**
 * Error thrown when Claude Code CLI is not found in PATH.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
 *
 * Effect.gen(function* () {
 *   const client = yield* ClaudeCodeCliClient
 *   return yield* client.query("test")
 * }).pipe(
 *   Effect.catchTag("CliNotFoundError", (error) =>
 *     Effect.sync(() => {
 *       console.error(error.message)
 *       console.log("Install: npm i -g @anthropics/claude-code")
 *     })
 *   )
 * )
 * ```
 *
 * @category Errors
 * @since 1.0.0
 */
export class CliNotFoundError extends Data.TaggedError("CliNotFoundError")<{
  readonly message: string
}> {
  /**
   * @since 1.0.0
   */
  constructor() {
    super({
      message: "Claude Code CLI not found. Install with: npm i -g @anthropics/claude-code"
    })
  }
}

/**
 * Error thrown when CLI execution fails.
 *
 * @category Errors
 * @since 1.0.0
 */
export class CliExecutionError extends Data.TaggedError("CliExecutionError")<{
  readonly stderr: string
  readonly exitCode: number
}> {}

/**
 * Error thrown when stream JSON parsing fails.
 *
 * @category Errors
 * @since 1.0.0
 */
export class StreamParsingError extends Data.TaggedError("StreamParsingError")<{
  readonly line: string
  readonly error: unknown
}> {}

/**
 * Error thrown when rate limit is exceeded.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { ClaudeCodeCliClient } from "@knpkv/effect-ai-claude-code-cli"
 *
 * Effect.gen(function* () {
 *   const client = yield* ClaudeCodeCliClient
 *   return yield* client.query("test")
 * }).pipe(
 *   Effect.catchTag("RateLimitError", (error) =>
 *     Effect.sync(() => {
 *       console.error(`Rate limited. Retry after ${error.retryAfter ?? "unknown"} seconds`)
 *     })
 *   )
 * )
 * ```
 *
 * @category Errors
 * @since 1.0.0
 */
export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly retryAfter?: number
  readonly stderr: string
}> {}

/**
 * Error thrown when API key is invalid.
 *
 * @category Errors
 * @since 1.0.0
 */
export class InvalidApiKeyError extends Data.TaggedError("InvalidApiKeyError")<{
  readonly stderr: string
}> {}

/**
 * Error thrown when network request fails.
 *
 * @category Errors
 * @since 1.0.0
 */
export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly stderr: string
}> {}

/**
 * Error thrown when context length is exceeded.
 *
 * @category Errors
 * @since 1.0.0
 */
export class ContextLengthError extends Data.TaggedError("ContextLengthError")<{
  readonly stderr: string
}> {}

/**
 * Error thrown when input validation fails.
 *
 * @category Errors
 * @since 1.0.0
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string
}> {}

/**
 * Error thrown when CLI version is incompatible.
 *
 * @category Errors
 * @since 1.0.0
 */
export class CliVersionMismatchError extends Data.TaggedError("CliVersionMismatchError")<{
  readonly installed: string
  readonly required: string
  readonly message: string
}> {}

/**
 * Union of all possible CLI errors.
 *
 * @category Errors
 * @since 1.0.0
 */
export type ClaudeCodeCliError =
  | CliNotFoundError
  | CliExecutionError
  | StreamParsingError
  | RateLimitError
  | InvalidApiKeyError
  | NetworkError
  | ContextLengthError
  | ValidationError
  | CliVersionMismatchError

/**
 * Type guard to check if error is a ClaudeCodeCliError.
 *
 * @param error - The error to check
 * @returns True if error is a ClaudeCodeCliError
 *
 * @category Utilities
 * @since 1.0.0
 */
export const isClaudeCodeCliError = (error: unknown): error is ClaudeCodeCliError =>
  typeof error === "object" && error !== null && "_tag" in error &&
  (
    error._tag === "CliNotFoundError" ||
    error._tag === "CliExecutionError" ||
    error._tag === "StreamParsingError" ||
    error._tag === "RateLimitError" ||
    error._tag === "InvalidApiKeyError" ||
    error._tag === "NetworkError" ||
    error._tag === "ContextLengthError" ||
    error._tag === "ValidationError" ||
    error._tag === "CliVersionMismatchError"
  )

/**
 * Parse stderr output to determine error type.
 *
 * @param stderr - The stderr output from CLI
 * @returns Appropriate error instance
 *
 * @category Utilities
 * @since 1.0.0
 * @internal
 */
export const parseStderr = (stderr: string, exitCode: number): ClaudeCodeCliError => {
  const stderrLower = stderr.toLowerCase()

  // Check for rate limit errors
  if (stderrLower.includes("rate limit") || stderrLower.includes("429") || exitCode === 429) {
    const retryAfter = extractRetryAfter(stderr)
    return retryAfter !== undefined
      ? new RateLimitError({ retryAfter, stderr })
      : new RateLimitError({ stderr })
  }

  // Check for authentication errors
  if (
    stderrLower.includes("invalid") && (stderrLower.includes("key") || stderrLower.includes("api")) ||
    stderrLower.includes("unauthorized") ||
    stderrLower.includes("authentication") ||
    exitCode === 401
  ) {
    return new InvalidApiKeyError({ stderr })
  }

  // Check for network errors
  if (
    stderrLower.includes("network") ||
    stderrLower.includes("connection") ||
    stderrLower.includes("econnrefused") ||
    stderrLower.includes("enotfound") ||
    stderrLower.includes("timeout") ||
    stderrLower.includes("etimedout")
  ) {
    return new NetworkError({ stderr })
  }

  // Check for context length errors
  if (
    stderrLower.includes("context") && stderrLower.includes("length") ||
    stderrLower.includes("token limit") ||
    stderrLower.includes("too many tokens") ||
    stderrLower.includes("maximum context")
  ) {
    return new ContextLengthError({ stderr })
  }

  // Generic execution error
  return new CliExecutionError({ stderr, exitCode })
}

/**
 * Extract retry-after duration from stderr.
 *
 * @param stderr - The stderr output
 * @returns Retry duration in seconds if found
 *
 * @internal
 */
const extractRetryAfter = (stderr: string): number | undefined => {
  const match = stderr.match(/retry[- ]after[:\s]+(\d+)/i)
  return match ? parseInt(match[1], 10) : undefined
}
