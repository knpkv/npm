/** Typed failures produced by the CodeCommit review boundary. @module */
import { Predicate, Schema } from "effect"

import type { AwsApiError, AwsCredentialError, AwsThrottleError } from "../Errors.js"
import type {
  CodeCommitBlobTooLargeError,
  CodeCommitMalformedResponseError,
  CodeCommitReadNotFoundError
} from "../ReadClient/errors.js"

const OperationName = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))

/** The authorized immutable pull-request revision is no longer current or actionable. */
export class CodeCommitReviewConflictError extends Schema.TaggedError<CodeCommitReviewConflictError>()(
  "CodeCommitReviewConflictError",
  {
    operation: OperationName,
    reason: Schema.Literals([
      "revision-changed",
      "source-commit-changed",
      "destination-commit-changed",
      "destination-reference-changed",
      "repository-changed",
      "caller-account-changed",
      "repository-account-changed",
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

const mergeProviderOperations = new Set([
  "mergePullRequestByFastForward",
  "mergePullRequestBySquash",
  "mergePullRequestByThreeWay"
])

// Modeled provider responses that prove the merge was rejected before mutation.
// Network, timeout, server, and future unknown tags stay conservative.
const definitiveMergeRejectionTags = new Set([
  "AccessDeniedException",
  "CommitMessageLengthExceededException",
  "ConcurrentReferenceUpdateException",
  "EncryptionIntegrityChecksFailedException",
  "EncryptionKeyAccessDeniedException",
  "EncryptionKeyDisabledException",
  "EncryptionKeyNotFoundException",
  "EncryptionKeyUnavailableException",
  "ExpiredTokenException",
  "FileContentSizeLimitExceededException",
  "FolderContentSizeLimitExceededException",
  "IncompleteSignature",
  "InvalidCommitIdException",
  "InvalidConflictDetailLevelException",
  "InvalidConflictResolutionException",
  "InvalidConflictResolutionStrategyException",
  "InvalidEmailException",
  "InvalidFileModeException",
  "InvalidPathException",
  "InvalidPullRequestIdException",
  "InvalidReplacementContentException",
  "InvalidReplacementTypeException",
  "InvalidRepositoryNameException",
  "MalformedHttpRequestException",
  "ManualMergeRequiredException",
  "MaximumConflictResolutionEntriesExceededException",
  "MaximumFileContentToLoadExceededException",
  "MaximumItemsToCompareExceededException",
  "MultipleConflictResolutionEntriesException",
  "NameLengthExceededException",
  "NotAuthorized",
  "OptInRequired",
  "PathRequiredException",
  "PullRequestAlreadyClosedException",
  "PullRequestApprovalRulesNotSatisfiedException",
  "PullRequestDoesNotExistException",
  "PullRequestIdRequiredException",
  "ReferenceDoesNotExistException",
  "ReplacementContentRequiredException",
  "ReplacementTypeRequiredException",
  "RepositoryDoesNotExistException",
  "RepositoryNameRequiredException",
  "RepositoryNotAssociatedWithPullRequestException",
  "RequestEntityTooLargeException",
  "RequestExpired",
  "ThrottlingException",
  "TipOfSourceReferenceIsDifferentException",
  "TipsDivergenceExceededException",
  "UnknownOperationException",
  "UnrecognizedClientException",
  "ValidationError",
  "ValidationException"
])

/** True only when a raw merge failure does not prove that the provider rejected the mutation. */
export const isAmbiguousMergeProviderError = (error: AwsApiError): boolean => {
  if (!mergeProviderOperations.has(error.operation)) return false
  if (!Predicate.hasProperty(error.cause, "_tag") || !Predicate.isString(error.cause._tag)) return true
  return !definitiveMergeRejectionTags.has(error.cause._tag)
}
