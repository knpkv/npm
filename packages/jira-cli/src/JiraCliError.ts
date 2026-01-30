/**
 * Error types for Jira CLI.
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
}> {
  constructor() {
    super({ message: "Not logged in. Run 'jira auth login' first." })
  }
}

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
