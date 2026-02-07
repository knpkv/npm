/**
 * Domain models for CodeCommit operations.
 *
 * Uses `Schema.Class` for rich models with computed properties,
 * branded types for compile-time ID safety, and `Schema.Literal`
 * for type-safe enumerations.
 *
 * @category Domain
 * @module
 */
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Branded Types
// ---------------------------------------------------------------------------

/**
 * Branded pull request identifier.
 *
 * @category Domain
 */
export const PullRequestId = Schema.String.pipe(Schema.brand("PullRequestId"))
export type PullRequestId = typeof PullRequestId.Type

/**
 * Branded repository name.
 *
 * @category Domain
 */
export const RepositoryName = Schema.String.pipe(Schema.brand("RepositoryName"))
export type RepositoryName = typeof RepositoryName.Type

/**
 * Branded AWS profile name.
 *
 * @category Domain
 */
export const AwsProfileName = Schema.String.pipe(Schema.brand("AwsProfileName"))
export type AwsProfileName = typeof AwsProfileName.Type

/**
 * Branded AWS region name.
 *
 * @category Domain
 */
export const AwsRegion = Schema.String.pipe(Schema.brand("AwsRegion"))
export type AwsRegion = typeof AwsRegion.Type

/**
 * Branded comment identifier.
 *
 * @category Domain
 */
export const CommentId = Schema.String.pipe(Schema.brand("CommentId"))
export type CommentId = typeof CommentId.Type

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * Pull request status.
 *
 * @category Domain
 */
export const PullRequestStatus = Schema.Literal("OPEN", "CLOSED")
export type PullRequestStatus = typeof PullRequestStatus.Type

/**
 * Notification severity type.
 *
 * @category Domain
 */
export const NotificationType = Schema.Literal("error", "info", "warning", "success")
export type NotificationType = typeof NotificationType.Type

/**
 * Application loading status.
 *
 * @category Domain
 */
export const AppStatus = Schema.Literal("idle", "loading", "error")
export type AppStatus = typeof AppStatus.Type

// ---------------------------------------------------------------------------
// Domain Models
// ---------------------------------------------------------------------------

/**
 * AWS account reference (profile + region).
 *
 * @category Domain
 */
export class Account extends Schema.Class<Account>("Account")({
  id: AwsProfileName,
  region: AwsRegion
}) {}

/**
 * CodeCommit pull request.
 *
 * @category Domain
 */
export class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
  id: PullRequestId,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  author: Schema.String,
  repositoryName: RepositoryName,
  creationDate: Schema.DateFromSelf,
  lastModifiedDate: Schema.DateFromSelf,
  link: Schema.String,
  account: Account,
  status: PullRequestStatus,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Boolean,
  isApproved: Schema.Boolean
}) {
  /**
   * AWS Console URL for this pull request.
   */
  get consoleUrl(): string {
    return `https://${this.account.region}.console.aws.amazon.com/codesuite/codecommit/repositories/${this.repositoryName}/pull-requests/${this.id}?region=${this.account.region}`
  }
}

/**
 * Comment on a pull request.
 *
 * @category Domain
 */
export class PRComment extends Schema.Class<PRComment>("PRComment")({
  id: CommentId,
  content: Schema.String,
  author: Schema.String,
  creationDate: Schema.DateFromSelf,
  inReplyTo: Schema.optional(CommentId),
  deleted: Schema.Boolean,
  filePath: Schema.optional(Schema.String),
  lineNumber: Schema.optional(Schema.Number)
}) {}

/**
 * Recursive comment thread (root comment + nested replies).
 *
 * @category Domain
 */
export interface CommentThread {
  readonly root: PRComment
  readonly replies: ReadonlyArray<CommentThread>
}

/**
 * Comments grouped by file location in a pull request.
 *
 * @category Domain
 */
export interface PRCommentLocation {
  readonly filePath?: string
  readonly beforeCommitId?: string
  readonly afterCommitId?: string
  readonly comments: ReadonlyArray<CommentThread>
}

// ---------------------------------------------------------------------------
// State Models
// ---------------------------------------------------------------------------

/**
 * Notification item with timestamp.
 *
 * @category Domain
 */
export class NotificationItem extends Schema.Class<NotificationItem>("NotificationItem")({
  type: NotificationType,
  title: Schema.String,
  message: Schema.String,
  timestamp: Schema.DateFromSelf
}) {}

/**
 * Notification state container.
 *
 * @category Domain
 */
export interface NotificationsState {
  readonly items: ReadonlyArray<NotificationItem>
}

/**
 * Account configuration in app state.
 *
 * @category Domain
 */
export interface AccountState {
  readonly profile: AwsProfileName
  readonly region: AwsRegion
  readonly enabled: boolean
}

/**
 * Application state.
 *
 * @category Domain
 */
export interface AppState {
  readonly pullRequests: ReadonlyArray<PullRequest>
  readonly accounts: ReadonlyArray<AccountState>
  readonly status: AppStatus
  readonly statusDetail?: string | undefined
  readonly error?: string | undefined
  readonly lastUpdated?: Date
  readonly currentUser?: string
}
