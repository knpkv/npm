/**
 * Tagged error types for Jira CLI operations.
 *
 * **Mental model**
 *
 * - **Three error tags**: {@link AuthMissingError} (not logged in),
 *   {@link JiraApiError} (API call failed), {@link WriteError} (file I/O failed).
 * - **Factory helper**: {@link authMissing} creates `AuthMissingError` with the default message.
 *
 * @module
 */
import * as Data from "effect/Data"

/**
 * Error when user is not authenticated.
 *
 * @category Errors
 */
export class AuthMissingError extends Data.TaggedError("AuthMissingError")<{
  readonly message: string
}> {}

export const authMissing = () => new AuthMissingError({ message: "Not logged in. Run 'jira auth login' first." })

/**
 * Error during Jira API operations.
 *
 * @category Errors
 */
export class JiraApiError extends Data.TaggedError("JiraApiError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Error when writing files.
 *
 * @category Errors
 */
export class WriteError extends Data.TaggedError("WriteError")<{
  readonly path: string
  readonly message: string
  readonly cause?: unknown
}> {}
