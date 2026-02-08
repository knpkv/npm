import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Account, PRCommentLocationJson, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"

// API error returned to clients for AWS failures
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String
}) {}

// PR endpoints
export class PrsGroup extends HttpApiGroup.make("prs")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(Schema.Chunk(PullRequest)))
  .add(HttpApiEndpoint.post("refresh", "/refresh").addSuccess(Schema.String))
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(
        Schema.Struct({
          repositoryName: Schema.String,
          title: Schema.String,
          description: Schema.optional(Schema.String),
          sourceBranch: Schema.String,
          destinationBranch: Schema.String,
          account: Account
        })
      )
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("open", "/open")
      .setPayload(
        Schema.Struct({
          profile: Schema.String,
          link: Schema.String
        })
      )
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("comments", "/comments")
      .setPayload(
        Schema.Struct({
          pullRequestId: Schema.String,
          repositoryName: Schema.String,
          account: Account
        })
      )
      .addSuccess(Schema.Array(PRCommentLocationJson))
      .addError(ApiError)
  )
  .prefix("/api/prs")
{}

// SSE events
export class EventsGroup extends HttpApiGroup.make("events")
  .add(HttpApiEndpoint.get("stream", "/").addSuccess(Schema.String))
  .prefix("/api/events")
{}

// Config endpoints
const ConfigResponse = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      profile: Schema.String,
      regions: Schema.Array(Schema.String),
      enabled: Schema.Boolean
    })
  ),
  autoDetect: Schema.Boolean,
  currentUser: Schema.optional(Schema.String)
})

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(ConfigResponse))
  .prefix("/api/config")
{}

// Accounts endpoints
export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(Schema.Chunk(Account)))
  .prefix("/api/accounts")
{}

// Combined API
export class CodeCommitApi extends HttpApi.make("CodeCommitApi")
  .add(PrsGroup)
  .add(EventsGroup)
  .add(ConfigGroup)
  .add(AccountsGroup)
{}
