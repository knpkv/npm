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

/**
 * Error when reading or writing Jira Markdown Sync workspace state.
 *
 * @category Errors
 */
export class SyncWorkspaceError extends Data.TaggedError("SyncWorkspaceError")<{
  readonly message: string
  readonly path?: string | undefined
  readonly cause?: unknown
}> {}

/**
 * Error when local Jira Markdown Sync configuration or data fails validation.
 *
 * @category Errors
 */
export class SyncValidationError extends Data.TaggedError("SyncValidationError")<{
  readonly message: string
  readonly issueKey?: string | undefined
  readonly field?: string | undefined
  readonly path?: string | undefined
  readonly cause?: unknown
}> {}
