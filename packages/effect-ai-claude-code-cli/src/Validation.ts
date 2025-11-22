/**
 * Input validation for Claude Code CLI parameters.
 */

import * as Effect from "effect/Effect"
import * as ParseResult from "effect/ParseResult"
import * as Schema from "effect/Schema"
import * as Brand from "./Brand.js"
import { ValidationError } from "./ClaudeCodeCliError.js"

/**
 * Maximum prompt length in characters.
 *
 * @category Constants
 */
export const MAX_PROMPT_LENGTH = 1_000_000

/**
 * Maximum timeout in milliseconds (10 minutes).
 *
 * @category Constants
 */
export const MAX_TIMEOUT_MS = 600_000

/**
 * Minimum timeout in milliseconds (1 second).
 *
 * @category Constants
 */
export const MIN_TIMEOUT_MS = 1000

/**
 * Valid known tool names.
 *
 * @category Constants
 */
export const KNOWN_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Task",
  "WebFetch",
  "WebSearch"
] as const

/**
 * Validate prompt text.
 *
 * Ensures prompt is non-empty and within length limits.
 *
 * @param prompt - Prompt text to validate
 * @returns Effect with validated PromptText or ValidationError
 *
 * @category Validation
 * @example
 *   import { validatePrompt } from "@knpkv/effect-ai-claude-code-cli/Validation"
 *
 *   const program = validatePrompt("Explain TypeScript")
 */
export const validatePrompt = (prompt: string): Effect.Effect<Brand.PromptText, ValidationError> =>
  Effect.gen(function*() {
    // Decode using schema which validates non-empty and trimmed
    const validated = yield* Schema.decodeUnknown(Brand.PromptTextSchema)(prompt).pipe(
      Effect.mapError(
        (error) =>
          new ValidationError({ message: `Invalid prompt: ${ParseResult.TreeFormatter.formatErrorSync(error)}` })
      )
    )

    // Check length
    if (validated.length > MAX_PROMPT_LENGTH) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`
        })
      )
    }

    return validated
  })

/**
 * Validate model identifier.
 *
 * Ensures model ID starts with 'claude-'.
 *
 * @param model - Model ID to validate
 * @returns Effect with validated ModelId or ValidationError
 *
 * @category Validation
 * @example
 *   import { validateModel } from "@knpkv/effect-ai-claude-code-cli/Validation"
 *
 *   const program = validateModel("claude-4-sonnet-20250514")
 */
export const validateModel = (model: string): Effect.Effect<Brand.ModelId, ValidationError> =>
  Schema.decodeUnknown(Brand.ModelIdSchema)(model).pipe(
    Effect.mapError(
      (error) =>
        new ValidationError({ message: `Invalid model ID: ${ParseResult.TreeFormatter.formatErrorSync(error)}` })
    )
  )

/**
 * Validate tool name.
 *
 * Ensures tool name is properly formatted (PascalCase).
 * Optionally warns if tool is not in known tools list.
 *
 * @param tool - Tool name to validate
 * @param strict - If true, fails on unknown tools. Default: false (warning only)
 * @returns Effect with validated ToolName or ValidationError
 *
 * @category Validation
 * @example
 *   import { validateToolName } from "@knpkv/effect-ai-claude-code-cli/Validation"
 *
 *   const program = validateToolName("Read")
 */
export const validateToolName = (
  tool: string,
  strict = false
): Effect.Effect<Brand.ToolName, ValidationError> =>
  Effect.gen(function*() {
    const validated = yield* Schema.decodeUnknown(Brand.ToolNameSchema)(tool).pipe(
      Effect.mapError(
        (error) =>
          new ValidationError({ message: `Invalid tool name: ${ParseResult.TreeFormatter.formatErrorSync(error)}` })
      )
    )

    // Check if tool is known
    if (!(KNOWN_TOOLS as ReadonlyArray<string>).includes(validated)) {
      if (strict) {
        return yield* Effect.fail(
          new ValidationError({
            message: `Unknown tool: ${validated}. Known tools: ${KNOWN_TOOLS.join(", ")}`
          })
        )
      }
      // Just log a warning
      yield* Effect.logWarning(`Tool '${validated}' is not in known tools list`)
    }

    return validated
  })

/**
 * Validate file path.
 *
 * Ensures path is safe (no null bytes, no path traversal).
 *
 * @param path - File path to validate
 * @returns Effect with validated FilePath or ValidationError
 *
 * @category Validation
 * @example
 *   import { validateFilePath } from "@knpkv/effect-ai-claude-code-cli/Validation"
 *
 *   const program = validateFilePath("/home/user/file.txt")
 */
export const validateFilePath = (path: string): Effect.Effect<Brand.FilePath, ValidationError> =>
  Schema.decodeUnknown(Brand.FilePathSchema)(path).pipe(
    Effect.mapError(
      (error) =>
        new ValidationError({ message: `Invalid file path: ${ParseResult.TreeFormatter.formatErrorSync(error)}` })
    )
  )

/**
 * Validate timeout value.
 *
 * Ensures timeout is within reasonable bounds.
 *
 * @param timeoutMs - Timeout in milliseconds
 * @returns Effect with validated timeout or ValidationError
 *
 * @category Validation
 * @example
 *   import { validateTimeout } from "@knpkv/effect-ai-claude-code-cli/Validation"
 *
 *   const program = validateTimeout(30000) // 30 seconds
 */
export const validateTimeout = (timeoutMs: number): Effect.Effect<number, ValidationError> =>
  Effect.gen(function*() {
    if (timeoutMs < MIN_TIMEOUT_MS) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Timeout must be at least ${MIN_TIMEOUT_MS}ms (${MIN_TIMEOUT_MS / 1000}s)`
        })
      )
    }

    if (timeoutMs > MAX_TIMEOUT_MS) {
      return yield* Effect.fail(
        new ValidationError({
          message: `Timeout must not exceed ${MAX_TIMEOUT_MS}ms (${MAX_TIMEOUT_MS / 1000}s)`
        })
      )
    }

    return timeoutMs
  })

/**
 * Validate array of tool names.
 *
 * Validates each tool name in the array.
 *
 * @param tools - Array of tool names to validate
 * @param strict - If true, fails on unknown tools
 * @returns Effect with validated array of ToolNames or ValidationError
 *
 * @category Validation
 * @example
 *   import { validateTools } from "@knpkv/effect-ai-claude-code-cli/Validation"
 *
 *   const program = validateTools(["Read", "Write", "Grep"])
 */
export const validateTools = (
  tools: ReadonlyArray<string>,
  strict = false
): Effect.Effect<ReadonlyArray<Brand.ToolName>, ValidationError> =>
  Effect.all(
    tools.map((tool) => validateToolName(tool, strict)),
    { concurrency: "unbounded" }
  )
