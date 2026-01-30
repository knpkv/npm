/**
 * Serialization error types.
 *
 * @module
 */
import * as Data from "effect/Data"

/**
 * Error thrown when serializing AST fails.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { SerializeError } from "@knpkv/atlassian-common"
 *
 * Effect.gen(function* () {
 *   // ... serialization operation
 * }).pipe(
 *   Effect.catchTag("SerializeError", (error) =>
 *     Effect.sync(() => console.error(`Serialize error: ${error.message}`))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class SerializeError extends Data.TaggedError("SerializeError")<{
  readonly target: "confluence" | "markdown" | "adf"
  readonly nodeType: string
  readonly message: string
}> {}

/**
 * Error thrown when parsing content fails.
 *
 * @category Errors
 */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly source: "confluence" | "markdown" | "adf"
  readonly message: string
  readonly position?: { readonly line: number; readonly column: number }
  readonly rawContent?: string
}> {}
