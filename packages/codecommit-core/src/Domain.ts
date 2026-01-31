import { Schema } from "effect"

export const Account = Schema.Struct({
  id: Schema.String,
  region: Schema.String
})

export type Account = Schema.Schema.Type<typeof Account>

export const PullRequest = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  author: Schema.String,
  repositoryName: Schema.String,
  creationDate: Schema.Date,
  lastModifiedDate: Schema.Date,
  link: Schema.String,
  account: Account,
  status: Schema.String,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Boolean,
  isApproved: Schema.Boolean
})

export type PullRequest = Schema.Schema.Type<typeof PullRequest>

export const PRComment = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  author: Schema.String,
  creationDate: Schema.Date,
  inReplyTo: Schema.optional(Schema.String),
  deleted: Schema.Boolean,
  filePath: Schema.optional(Schema.String),
  lineNumber: Schema.optional(Schema.Number)
})

export type PRComment = Schema.Schema.Type<typeof PRComment>

export interface CommentThread {
  readonly root: PRComment
  readonly replies: ReadonlyArray<CommentThread>
}

export interface PRCommentLocation {
  readonly filePath?: string
  readonly beforeCommitId?: string
  readonly afterCommitId?: string
  readonly comments: ReadonlyArray<CommentThread>
}
