import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Account, AwsProfileName, PRCommentLocationJson, PullRequest } from "@knpkv/codecommit-core/Domain.js"
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

const ConfigPathResponse = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean
})

const ConfigValidationResponse = Schema.Struct({
  status: Schema.Literal("valid", "missing", "corrupted"),
  path: Schema.String,
  errors: Schema.Array(Schema.String)
})

const ConfigSavePayload = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      profile: Schema.String,
      regions: Schema.Array(Schema.String),
      enabled: Schema.Boolean
    })
  ),
  autoDetect: Schema.Boolean
})

const ConfigResetResponse = Schema.Struct({
  backupPath: Schema.optional(Schema.String),
  config: ConfigResponse
})

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(ConfigResponse))
  .add(HttpApiEndpoint.get("path", "/path").addSuccess(ConfigPathResponse).addError(ApiError))
  .add(HttpApiEndpoint.get("validate", "/validate").addSuccess(ConfigValidationResponse).addError(ApiError))
  .add(HttpApiEndpoint.post("save", "/save").setPayload(ConfigSavePayload).addSuccess(Schema.String).addError(ApiError))
  .add(HttpApiEndpoint.post("reset", "/reset").addSuccess(ConfigResetResponse).addError(ApiError))
  .prefix("/api/config")
{}

// Accounts endpoints
export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(Schema.Chunk(Account)))
  .prefix("/api/accounts")
{}

// Notifications endpoints
export const NotificationItemResponse = Schema.Struct({
  type: Schema.Literal("error", "info", "warning", "success"),
  title: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
  profile: Schema.optional(Schema.String)
})

export class NotificationsGroup extends HttpApiGroup.make("notifications")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(Schema.Array(NotificationItemResponse)))
  .add(HttpApiEndpoint.post("clear", "/clear").addSuccess(Schema.String))
  .add(
    HttpApiEndpoint.post("ssoLogin", "/sso-login")
      .setPayload(Schema.Struct({ profile: AwsProfileName }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("ssoLogout", "/sso-logout")
      .setPayload(Schema.Struct({ profile: Schema.String }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .prefix("/api/notifications")
{}

// Combined API
export class CodeCommitApi extends HttpApi.make("CodeCommitApi")
  .add(PrsGroup)
  .add(EventsGroup)
  .add(ConfigGroup)
  .add(AccountsGroup)
  .add(NotificationsGroup)
{}
