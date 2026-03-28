/**
 * Tagged error for Clockify API failures.
 *
 * **Mental model**
 *
 * - **Catch by tag**: `Effect.catchTag("ClockifyApiError", ...)` handles all API errors.
 *   The `status` field distinguishes HTTP errors (>0) from network errors (0).
 *
 * @module
 */
import * as Data from "effect/Data"

export class ClockifyApiError extends Data.TaggedError("ClockifyApiError")<{
  readonly status: number
  readonly message: string
  readonly cause?: unknown
}> {}
