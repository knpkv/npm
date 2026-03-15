/**
 * HTTP API schema definitions for the CodeCommit web server.
 *
 * Defines all endpoint groups ({@link PrsGroup}, {@link EventsGroup},
 * {@link ConfigGroup}, {@link AccountsGroup}, {@link SubscriptionsGroup},
 * {@link NotificationsGroup}, {@link SandboxGroup}, {@link StatsGroup},
 * {@link PermissionsGroup}, {@link AuditGroup}) and combines them into
 * {@link CodeCommitApi}. Each group uses `HttpApiEndpoint` with
 * schema-validated payloads and responses.
 *
 * **Mental model**
 *
 * - PrsGroup: CRUD for PRs + approval-rule endpoints (create/update/delete)
 *   on /api/prs/approval-rules with `account` payload for cross-account routing
 * - CodeCommitApi combines all groups into a single API definition
 *
 * @module
 */
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import {
  Account,
  AwsProfileName,
  AwsRegion,
  PRCommentLocationJson,
  PullRequest,
  PullRequestId,
  SandboxId,
  SandboxStatus
} from "@knpkv/codecommit-core/Domain.js"
import { WeeklyStats } from "@knpkv/codecommit-core/StatsService/WeeklyStats.js"
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
    HttpApiEndpoint.get("comments", "/comments")
      .setUrlParams(
        Schema.Struct({
          pullRequestId: Schema.String,
          repositoryName: Schema.String,
          profile: AwsProfileName,
          region: AwsRegion
        })
      )
      .addSuccess(Schema.Array(PRCommentLocationJson))
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("createApprovalRule", "/approval-rules")
      .setPayload(
        Schema.Struct({
          pullRequestId: Schema.String,
          approvalRuleName: Schema.String,
          requiredApprovals: Schema.Number,
          poolMembers: Schema.Array(Schema.String),
          account: Account
        })
      )
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.put("updateApprovalRule", "/approval-rules")
      .setPayload(
        Schema.Struct({
          pullRequestId: Schema.String,
          approvalRuleName: Schema.String,
          requiredApprovals: Schema.Number,
          poolMembers: Schema.Array(Schema.String),
          account: Account
        })
      )
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.del("deleteApprovalRule", "/approval-rules")
      .setPayload(
        Schema.Struct({
          pullRequestId: Schema.String,
          approvalRuleName: Schema.String,
          account: Account
        })
      )
      .addSuccess(Schema.String)
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

// Stats endpoints
export { WeeklyStats }

export class StatsGroup extends HttpApiGroup.make("stats")
  .add(
    HttpApiEndpoint.get("get", "/")
      .setUrlParams(Schema.Struct({
        week: Schema.String.pipe(Schema.pattern(/^\d{4}-W\d{2}$/)),
        repo: Schema.optional(Schema.String),
        author: Schema.optional(Schema.String),
        account: Schema.optional(Schema.String)
      }))
      .addSuccess(WeeklyStats)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("sync", "/sync")
      .setPayload(Schema.Struct({ week: Schema.String.pipe(Schema.pattern(/^\d{4}-W\d{2}$/)) }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .prefix("/api/stats")
{}

// Permission endpoints
const PermissionStateSchema = Schema.Literal("always_allow", "allow", "deny")

const PermissionEntry = Schema.Struct({
  operation: Schema.String,
  state: PermissionStateSchema,
  category: Schema.Literal("read", "write"),
  description: Schema.String
})

export const AuditLogEntryResponse = Schema.Struct({
  id: Schema.Number,
  timestamp: Schema.String,
  operation: Schema.String,
  accountProfile: Schema.String,
  region: Schema.String,
  permissionState: Schema.String,
  context: Schema.String,
  durationMs: Schema.NullOr(Schema.Number)
})

export class PermissionsGroup extends HttpApiGroup.make("permissions")
  .add(
    HttpApiEndpoint.post("respond", "/respond")
      .setPayload(Schema.Struct({
        id: Schema.String,
        response: Schema.Literal("allow_once", "always_allow", "deny")
      }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.get("list", "/")
      .addSuccess(Schema.Array(PermissionEntry))
  )
  .add(
    HttpApiEndpoint.post("update", "/update")
      .setPayload(Schema.Struct({
        operation: Schema.String,
        state: PermissionStateSchema
      }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.post("reset", "/reset")
      .addSuccess(Schema.String)
  )
  .add(
    HttpApiEndpoint.get("auditSettings", "/audit")
      .addSuccess(Schema.Struct({
        enabled: Schema.Boolean,
        retentionDays: Schema.Number
      }))
  )
  .add(
    HttpApiEndpoint.post("updateAuditSettings", "/audit")
      .setPayload(Schema.Struct({
        enabled: Schema.optional(Schema.Boolean),
        retentionDays: Schema.optional(Schema.Number)
      }))
      .addSuccess(Schema.String)
      .addError(ApiError)
  )
  .prefix("/api/permissions")
{}

// Audit log endpoints
export class AuditGroup extends HttpApiGroup.make("audit")
  .add(
    HttpApiEndpoint.get("list", "/")
      .setUrlParams(Schema.Struct({
        limit: Schema.optional(Schema.NumberFromString.pipe(Schema.between(1, 200))),
        offset: Schema.optional(Schema.NumberFromString.pipe(Schema.greaterThanOrEqualTo(0))),
        operation: Schema.optional(Schema.String),
        accountProfile: Schema.optional(Schema.String),
        permissionState: Schema.optional(Schema.String),
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String),
        search: Schema.optional(Schema.String)
      }))
      .addSuccess(Schema.Struct({
        items: Schema.Array(AuditLogEntryResponse),
        total: Schema.Number,
        nextCursor: Schema.optional(Schema.Number)
      }))
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.get("export", "/export")
      .setUrlParams(Schema.Struct({
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String)
      }))
      .addSuccess(Schema.Array(AuditLogEntryResponse))
      .addError(ApiError)
  )
  .add(
    HttpApiEndpoint.del("clear", "/")
      .addSuccess(Schema.Struct({ deleted: Schema.Number }))
      .addError(ApiError)
  )
  .prefix("/api/audit")
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
  .add(StatsGroup)
  .add(PermissionsGroup)
  .add(AuditGroup)
{}
