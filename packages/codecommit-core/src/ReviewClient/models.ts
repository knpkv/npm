/**
 * Bounded commands and receipts for immutable CodeCommit pull-request review actions.
 *
 * @category Review client
 * @module
 */
import { Schema } from "effect"

import { PullRequestId, RepositoryName } from "../Domain.js"
import { CodeCommitCommitId, CodeCommitReadAccount } from "../ReadClient/models.js"

const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())
const BoundedText = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(10_100))
const ClientRequestToken = NonEmptyString.check(Schema.isMaxLength(64))
const ReviewRevision = NonEmptyString.check(Schema.isMaxLength(64))
const ReviewCommitId = CodeCommitCommitId.check(Schema.isMaxLength(64))
const ReviewReference = NonEmptyString.check(Schema.isMaxLength(256))

/** Exact provider revision against which a review action was authorized. */
export const CodeCommitReviewTarget = Schema.Struct({
  account: CodeCommitReadAccount,
  repositoryName: RepositoryName,
  pullRequestId: PullRequestId,
  revisionId: ReviewRevision,
  sourceCommit: ReviewCommitId,
  destinationCommit: ReviewCommitId,
  destinationReference: ReviewReference
}).annotate({ identifier: "CodeCommitReviewTarget" })

/** Decoded immutable review target. */
export type CodeCommitReviewTarget = typeof CodeCommitReviewTarget.Type

const CommentActionFields = {
  target: CodeCommitReviewTarget,
  content: BoundedText,
  clientRequestToken: ClientRequestToken
}

/** Closed set of CodeCommit review mutations supported by the owning package. */
export const CodeCommitReviewAction = Schema.Union([
  Schema.TaggedStruct("request-review", CommentActionFields),
  Schema.TaggedStruct("comment", CommentActionFields),
  Schema.TaggedStruct("request-changes", CommentActionFields),
  Schema.TaggedStruct("approve", { target: CodeCommitReviewTarget }),
  Schema.TaggedStruct("revoke-approval", { target: CodeCommitReviewTarget })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded CodeCommit review mutation. */
export type CodeCommitReviewAction = typeof CodeCommitReviewAction.Type

/** Safe provider receipt returned only after a confirmed mutation. */
export class CodeCommitReviewReceipt extends Schema.Class<CodeCommitReviewReceipt>(
  "CodeCommitReviewReceipt"
)({
  operationId: NonEmptyString.check(Schema.isMaxLength(512)),
  summary: NonEmptyString.check(Schema.isMaxLength(1_000))
}) {}

/** Read-only reconciliation result that never replays a provider write. */
export const CodeCommitReviewReconciliation = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("succeeded", { receipt: CodeCommitReviewReceipt }),
  Schema.TaggedStruct("failed", { summary: NonEmptyString.check(Schema.isMaxLength(1_000)) })
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded reconciliation result. */
export type CodeCommitReviewReconciliation = typeof CodeCommitReviewReconciliation.Type
