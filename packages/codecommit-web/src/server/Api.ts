import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import {
  Account,
  AwsProfileName,
  PRCommentLocationJson,
  PullRequest,
  PullRequestId,
  SandboxId,
  SandboxStatus
} from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"

// API error returned to clients for AWS failures
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String
}) {}

// Cached PR schema (flat row from SQLite)
export const CachedPullRequestResponse = Schema.Struct({
  id: Schema.String,
  awsAccountId: Schema.String,
  accountProfile: Schema.String,
  accountRegion: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  author: Schema.String,
  repositoryName: Schema.String,
  creationDate: Schema.String,
  lastModifiedDate: Schema.String,
  status: Schema.String,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  isMergeable: Schema.Number,
  isApproved: Schema.Number,
  commentCount: Schema.NullOr(Schema.Number),
  link: Schema.String,
  fetchedAt: Schema.String
})

// Notification schema (unified)
export const NotificationResponse = Schema.Struct({
  id: Schema.Number,
  pullRequestId: Schema.String,
  awsAccountId: Schema.String,
  type: Schema.String,
  title: Schema.String,
  profile: Schema.String,
  message: Schema.String,
  createdAt: Schema.String,
  read: Schema.Number
})

// PR endpoints
export class PrsGroup extends HttpApiGroup.make("prs")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(Schema.Chunk(PullRequest)))
  .add(HttpApiEndpoint.post("refresh", "/refresh").addSuccess(Schema.String))
  .add(
    HttpApiEndpoint.get("search", "/search")
      .setUrlParams(Schema.Struct({
        q: Schema.String,
        limit: Schema.optional(Schema.NumberFromString.pipe(Schema.between(1, 50))),
        offset: Schema.optional(Schema.NumberFromString.pipe(Schema.greaterThanOrEqualTo(0)))
      }))
      .addSuccess(Schema.Struct({
        items: Schema.Array(CachedPullRequestResponse),
        total: Schema.Number,
        hasMore: Schema.Boolean
      }))
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("refreshSingle", "/:awsAccountId/:prId/refresh")
      .setPath(Schema.Struct({ awsAccountId: Schema.String, prId: PullRequestId }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
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
          link: Schema.String.pipe(
            Schema.filter((s) => /^https:\/\/[\w-]+\.console\.aws\.amazon\.com\//.test(s))
          )
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
const VolumeMount = Schema.Struct({
  hostPath: Schema.String,
  containerPath: Schema.String,
  readonly: Schema.Boolean
})

const SandboxSettingsResponse = Schema.Struct({
  image: Schema.String,
  extensions: Schema.Array(Schema.String),
  setupCommands: Schema.Array(Schema.String),
  env: Schema.Record({ key: Schema.String, value: Schema.String }),
  enableClaudeCode: Schema.Boolean,
  volumeMounts: Schema.Array(VolumeMount),
  cloneDepth: Schema.Number
})

const ConfigResponse = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      profile: Schema.String,
      regions: Schema.Array(Schema.String),
      enabled: Schema.Boolean
    })
  ),
  autoDetect: Schema.Boolean,
  autoRefresh: Schema.Boolean,
  refreshIntervalSeconds: Schema.Number,
  currentUser: Schema.optional(Schema.String),
  sandbox: Schema.optional(SandboxSettingsResponse)
})

const ConfigPathResponse = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean,
  modifiedAt: Schema.optional(Schema.String)
})

const DatabaseInfoResponse = Schema.Struct({
  path: Schema.String,
  sizeBytes: Schema.Number,
  exists: Schema.Boolean,
  modifiedAt: Schema.optional(Schema.String)
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
  autoDetect: Schema.Boolean,
  autoRefresh: Schema.Boolean,
  refreshIntervalSeconds: Schema.Number,
  sandbox: Schema.optional(SandboxSettingsResponse)
})

const ConfigResetResponse = Schema.Struct({
  backupPath: Schema.optional(Schema.String),
  config: ConfigResponse
})

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(HttpApiEndpoint.get("list", "/").addSuccess(ConfigResponse))
  .add(HttpApiEndpoint.get("path", "/path").addSuccess(ConfigPathResponse).addError(ApiError))
  .add(HttpApiEndpoint.get("database", "/database").addSuccess(DatabaseInfoResponse).addError(ApiError))
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

// Subscription endpoints
const SubscriptionPayload = Schema.Struct({
  awsAccountId: Schema.String,
  pullRequestId: PullRequestId
})

const SubscriptionResponse = Schema.Struct({
  awsAccountId: Schema.String,
  pullRequestId: Schema.String
})

export class SubscriptionsGroup extends HttpApiGroup.make("subscriptions")
  .add(
    HttpApiEndpoint.post("subscribe", "/subscribe")
      .setPayload(SubscriptionPayload)
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("unsubscribe", "/unsubscribe")
      .setPayload(SubscriptionPayload)
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.get("list", "/")
      .addSuccess(Schema.Array(SubscriptionResponse))
  )
  .prefix("/api/subscriptions")
{}

// Notification endpoints (unified)
const PaginatedNotifications = Schema.Struct({
  items: Schema.Array(NotificationResponse),
  nextCursor: Schema.optional(Schema.Number)
})

export class NotificationsGroup extends HttpApiGroup.make("notifications")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setUrlParams(Schema.Struct({
        limit: Schema.optional(Schema.NumberFromString.pipe(Schema.between(1, 100))),
        cursor: Schema.optional(Schema.NumberFromString),
        filter: Schema.optional(Schema.Literal("system", "prs")),
        unreadOnly: Schema.optional(Schema.NumberFromString)
      }))
      .addSuccess(PaginatedNotifications)
  )
  .add(
    HttpApiEndpoint.get("count", "/count")
      .addSuccess(Schema.Struct({ unread: Schema.Number }))
  )
  .add(
    HttpApiEndpoint.post("markRead", "/read")
      .setPayload(Schema.Struct({ id: Schema.Number }))
      .addSuccess(Schema.String)
  )
  .add(
    HttpApiEndpoint.post("markUnread", "/unread")
      .setPayload(Schema.Struct({ id: Schema.Number }))
      .addSuccess(Schema.String)
  )
  .add(
    HttpApiEndpoint.post("markAllRead", "/read-all")
      .addSuccess(Schema.String)
  )
  .add(
    HttpApiEndpoint.post("ssoLogin", "/sso-login")
      .setPayload(Schema.Struct({ profile: AwsProfileName }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("ssoLogout", "/sso-logout")
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .prefix("/api/notifications")
{}

// Sandbox endpoints
export const SandboxResponse = Schema.Struct({
  id: Schema.String,
  pullRequestId: Schema.String,
  awsAccountId: Schema.String,
  repositoryName: Schema.String,
  sourceBranch: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  status: SandboxStatus,
  statusDetail: Schema.NullOr(Schema.String),
  logs: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastActivityAt: Schema.String
})

const CreateSandboxPayload = Schema.Struct({
  pullRequestId: PullRequestId,
  awsAccountId: Schema.String,
  repositoryName: Schema.String,
  sourceBranch: Schema.String,
  profile: AwsProfileName,
  region: Schema.String
})

const SandboxIdPath = Schema.Struct({ sandboxId: SandboxId })

export class SandboxGroup extends HttpApiGroup.make("sandbox")
  .add(
    HttpApiEndpoint.post("create", "/")
      .setPayload(CreateSandboxPayload)
      .addSuccess(SandboxResponse)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.get("list", "/")
      .addSuccess(Schema.Array(SandboxResponse))
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.get("get", "/:sandboxId")
      .setPath(SandboxIdPath)
      .addSuccess(SandboxResponse)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("stop", "/:sandboxId/stop")
      .setPath(SandboxIdPath)
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("restart", "/:sandboxId/restart")
      .setPath(SandboxIdPath)
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.del("delete", "/:sandboxId")
      .setPath(SandboxIdPath)
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .prefix("/api/sandbox")
{}

// Combined API
export class CodeCommitApi extends HttpApi.make("CodeCommitApi")
  .add(PrsGroup)
  .add(EventsGroup)
  .add(ConfigGroup)
  .add(AccountsGroup)
  .add(NotificationsGroup)
  .add(SubscriptionsGroup)
  .add(SandboxGroup)
{}
