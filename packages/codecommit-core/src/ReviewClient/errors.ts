/** Typed failures produced by the CodeCommit review boundary. @module */
import { Schema } from "effect"

import type { AwsApiError, AwsCredentialError, AwsThrottleError } from "../Errors.js"
import type {
  CodeCommitBlobTooLargeError,
  CodeCommitMalformedResponseError,
  CodeCommitReadNotFoundError
} from "../ReadClient/errors.js"

const OperationName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

/** The authorized immutable pull-request revision is no longer current or actionable. */
export class CodeCommitReviewConflictError extends Schema.TaggedErrorClass<CodeCommitReviewConflictError>()(
  "CodeCommitReviewConflictError",
  {
    operation: OperationName,
    reason: Schema.Literals([
      "revision-changed",
      "source-commit-changed",
      "destination-commit-changed",
      "destination-reference-changed",
      "repository-changed",
      "pull-request-closed",
      "approval-by-author",
      "approval-rules-unsatisfied",
      "merge-conflict"
    ])
  }
) {}

/** Closed error union for CodeCommit review operations. */
export type CodeCommitReviewError =
  | AwsCredentialError
  | AwsThrottleError
  | AwsApiError
  | CodeCommitBlobTooLargeError
  | CodeCommitMalformedResponseError
  | CodeCommitReadNotFoundError
  | CodeCommitReviewConflictError
