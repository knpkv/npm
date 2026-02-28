/**
 * Typed error for all cache/SQL operations.
 *
 * @module
 */
import { Schema } from "effect"

/**
 * Cache layer operation failure (SQL, parse, or connection error).
 *
 * @category Errors
 */
export class CacheError extends Schema.TaggedError<CacheError>()(
  "CacheError",
  {
    operation: Schema.String,
    cause: Schema.Defect
  }
) {}
