/** Typed failures produced by the CodeCommit read boundary. @module */
import { Schema } from "effect"

import type { AwsApiError, AwsCredentialError, AwsThrottleError } from "../Errors.js"

const OperationName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

/** Untrusted provider output failed Schema decoding. */
export class CodeCommitMalformedResponseError extends Schema.TaggedErrorClass<CodeCommitMalformedResponseError>()(
  "CodeCommitMalformedResponseError",
  {
    operation: OperationName,
    diagnosticCode: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))
  }
) {}

/** The requested CodeCommit object does not exist in the configured account. */
export class CodeCommitReadNotFoundError extends Schema.TaggedErrorClass<CodeCommitReadNotFoundError>()(
  "CodeCommitReadNotFoundError",
  { operation: OperationName }
) {}

/** CodeCommit or the bounded read client refused blob content that was too large. */
export class CodeCommitBlobTooLargeError extends Schema.TaggedErrorClass<CodeCommitBlobTooLargeError>()(
  "CodeCommitBlobTooLargeError",
  {
    operation: OperationName,
    maximumBytes: Schema.Int.check(Schema.isGreaterThan(0)),
    actualBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    source: Schema.Literals(["provider", "read-client"])
  }
) {}

/** Closed error union for CodeCommit read operations. */
export type CodeCommitReadError =
  | AwsCredentialError
  | AwsThrottleError
  | AwsApiError
  | CodeCommitBlobTooLargeError
  | CodeCommitMalformedResponseError
  | CodeCommitReadNotFoundError
