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
