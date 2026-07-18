/**
 * Schema-decoded read models for immutable CodeCommit pull request revisions
 * and complete changed-file inventory pages.
 *
 * @category Read client
 * @module
 */
import { Schema } from "effect"

import { AwsProfileName, AwsRegion, PullRequestId, RepositoryName } from "../Domain.js"

const NonEmptyString = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())

/** Maximum blob content retained by one CodeCommit read. */
export const CODECOMMIT_BLOB_MAXIMUM_BYTES = 1_048_576

/** Opaque CodeCommit pagination token. */
export const CodeCommitPageToken = NonEmptyString.pipe(Schema.brand("CodeCommitPageToken"))

/** Decoded CodeCommit pagination token. */
export type CodeCommitPageToken = typeof CodeCommitPageToken.Type

/** Stable immutable CodeCommit commit identifier. */
export const CodeCommitCommitId = NonEmptyString.pipe(Schema.brand("CodeCommitCommitId"))

/** Decoded immutable CodeCommit commit identifier. */
export type CodeCommitCommitId = typeof CodeCommitCommitId.Type

/** Stable immutable CodeCommit blob identifier. */
export const CodeCommitBlobId = NonEmptyString.pipe(Schema.brand("CodeCommitBlobId"))

/** Decoded immutable CodeCommit blob identifier. */
export type CodeCommitBlobId = typeof CodeCommitBlobId.Type

/** Bounded immutable CodeCommit blob content. */
export class CodeCommitBlobContent extends Schema.Class<CodeCommitBlobContent>(
  "CodeCommitBlobContent"
)({
  blobId: CodeCommitBlobId,
  bytes: Schema.Uint8Array.check(
    Schema.makeFilter((bytes) => bytes.byteLength <= CODECOMMIT_BLOB_MAXIMUM_BYTES, {
      expected: `at most ${CODECOMMIT_BLOB_MAXIMUM_BYTES} blob bytes`
    })
  )
}) {
  /** Exact decoded content length without duplicated caller-controlled metadata. */
  get byteLength(): number {
    return this.bytes.byteLength
  }
}

/** Account coordinates used by CodeCommit provider reads. */
export const CodeCommitReadAccount = Schema.Struct({
  profile: AwsProfileName,
  region: AwsRegion
}).annotate({ identifier: "CodeCommitReadAccount" })

/** Decoded account coordinates used by CodeCommit provider reads. */
export type CodeCommitReadAccount = typeof CodeCommitReadAccount.Type

/** Secret-free identity returned by AWS STS for a configured account. */
export class CodeCommitAccountIdentity extends Schema.Class<CodeCommitAccountIdentity>(
  "CodeCommitAccountIdentity"
)({
  accountId: NonEmptyString,
  arn: NonEmptyString
}) {}

/** Immutable CodeCommit pull request revision and its exact base/head commits. */
export class CodeCommitPullRequestRevision extends Schema.Class<CodeCommitPullRequestRevision>(
  "CodeCommitPullRequestRevision"
)({
  pullRequestId: PullRequestId,
  revisionId: NonEmptyString,
  repositoryName: RepositoryName,
  title: NonEmptyString,
  description: Schema.optional(Schema.String),
  authorArn: NonEmptyString,
  status: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  sourceReference: NonEmptyString,
  destinationReference: NonEmptyString,
  sourceCommit: CodeCommitCommitId,
  destinationCommit: CodeCommitCommitId,
  mergeBase: Schema.NullOr(CodeCommitCommitId),
  creationDate: Schema.Date,
  lastActivityDate: Schema.Date
}) {}

/** One decoded page of pull requests from a repository. */
export class CodeCommitPullRequestPage extends Schema.Class<CodeCommitPullRequestPage>(
  "CodeCommitPullRequestPage"
)({
  pullRequests: Schema.Array(CodeCommitPullRequestRevision),
  nextToken: Schema.NullOr(CodeCommitPageToken)
}) {}

/** Immutable blob metadata attached to one side of a changed file. */
export class CodeCommitBlobMetadata extends Schema.Class<CodeCommitBlobMetadata>(
  "CodeCommitBlobMetadata"
)({
  blobId: CodeCommitBlobId,
  path: NonEmptyString,
  mode: NonEmptyString
}) {}

/** One changed file with both provider paths, blobs, and modes preserved. */
export class CodeCommitChangedFile extends Schema.Class<CodeCommitChangedFile>(
  "CodeCommitChangedFile"
)({
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  before: Schema.NullOr(CodeCommitBlobMetadata),
  after: Schema.NullOr(CodeCommitBlobMetadata)
}) {}

/** One bounded provider page from the complete CodeCommit changed-file inventory. */
export class CodeCommitChangedFilesPage extends Schema.Class<CodeCommitChangedFilesPage>(
  "CodeCommitChangedFilesPage"
)({
  files: Schema.Array(CodeCommitChangedFile),
  nextToken: Schema.NullOr(CodeCommitPageToken),
  providerPageLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
}) {}
