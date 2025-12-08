/**
 * Error types for schema-based conversion.
 *
 * @module
 */
import * as Data from "effect/Data"

/**
 * Error thrown when parsing HTML or Markdown fails.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { ParseError } from "@knpkv/confluence-to-markdown/SchemaConverterError"
 *
 * Effect.gen(function* () {
 *   // ... parsing operation
 * }).pipe(
 *   Effect.catchTag("ParseError", (error) =>
 *     Effect.sync(() => console.error(`Parse error: ${error.message}`))
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class ParseError extends Data.TaggedError("ParseError")<{
  readonly source: "confluence" | "markdown"
  readonly message: string
  readonly position?: { readonly line: number; readonly column: number }
  readonly rawContent?: string
}> {}

/**
 * Error thrown when serializing AST to HTML or Markdown fails.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { SerializeError } from "@knpkv/confluence-to-markdown/SchemaConverterError"
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
  readonly target: "confluence" | "markdown"
  readonly nodeType: string
  readonly message: string
}> {}

/**
 * Error thrown when migrating between schema versions fails.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { MigrationError } from "@knpkv/confluence-to-markdown/SchemaConverterError"
 *
 * Effect.gen(function* () {
 *   // ... migration operation
 * }).pipe(
 *   Effect.catchTag("MigrationError", (error) =>
 *     Effect.sync(() =>
 *       console.error(`Migration error: ${error.nodeType} v${error.fromVersion} -> v${error.toVersion}`)
 *     )
 *   )
 * )
 * ```
 *
 * @category Errors
 */
export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly nodeType: string
  readonly fromVersion: number
  readonly toVersion: number
  readonly message: string
}> {}

/**
 * Union of all schema converter errors.
 *
 * @category Errors
 */
export type SchemaConverterError = ParseError | SerializeError | MigrationError

/**
 * Type guard to check if error is a SchemaConverterError.
 *
 * @param error - The error to check
 * @returns True if error is a SchemaConverterError
 *
 * @category Utilities
 */
export const isSchemaConverterError = (error: unknown): error is SchemaConverterError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  ["ParseError", "SerializeError", "MigrationError"].includes(
    (error as { _tag: string })._tag
  )
