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
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

// API error returned to clients for AWS failures
export class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
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
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Chunk(PullRequest) })
  )
  .add(
    HttpApiEndpoint.post("refresh", "/refresh", { success: Schema.String })
  )
  .add(
    HttpApiEndpoint.get("search", "/search", {
      query: Schema.Struct({
        q: Schema.String,
        limit: Schema.optional(
          Schema.NumberFromString.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 })))
        ),
        offset: Schema.optional(Schema.NumberFromString.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))))
      }),
      success: Schema.Struct({
        items: Schema.Array(CachedPullRequestResponse),
        total: Schema.Number,
        hasMore: Schema.Boolean
      }),
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("refreshSingle", "/:awsAccountId/:prId/refresh", {
      params: Schema.Struct({ awsAccountId: Schema.String, prId: PullRequestId }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schema.Struct({
        repositoryName: Schema.String,
        title: Schema.String,
        description: Schema.optional(Schema.String),
        sourceBranch: Schema.String,
        destinationBranch: Schema.String,
        account: Account
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("open", "/open", {
      payload: Schema.Struct({
        profile: Schema.String,
        link: Schema.String.pipe(
          Schema.check(Schema.makeFilter((s) => /^https:\/\/[\w-]+\.console\.aws\.amazon\.com\//.test(s)))
        )
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.get("comments", "/comments", {
      query: Schema.Struct({
        pullRequestId: Schema.String,
        repositoryName: Schema.String,
        profile: AwsProfileName,
        region: AwsRegion
      }),
      success: Schema.Array(PRCommentLocationJson),
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("createApprovalRule", "/approval-rules", {
      payload: Schema.Struct({
        pullRequestId: Schema.String,
        approvalRuleName: Schema.String,
        requiredApprovals: Schema.Number,
        poolMembers: Schema.Array(Schema.String),
        account: Account
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.put("updateApprovalRule", "/approval-rules", {
      payload: Schema.Struct({
        pullRequestId: Schema.String,
        approvalRuleName: Schema.String,
        requiredApprovals: Schema.Number,
        poolMembers: Schema.Array(Schema.String),
        account: Account
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.delete("deleteApprovalRule", "/approval-rules", {
      payload: Schema.Struct({
        pullRequestId: Schema.String,
        approvalRuleName: Schema.String,
        account: Account
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .prefix("/api/prs")
{}

// SSE events
export class EventsGroup extends HttpApiGroup.make("events")
  .add(HttpApiEndpoint.get("stream", "/", { success: Schema.String }))
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
  env: Schema.Record(Schema.String, Schema.String),
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
  status: Schema.Literals(["valid", "missing", "corrupted"]),
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
  .add(HttpApiEndpoint.get("list", "/", { success: ConfigResponse }))
  .add(HttpApiEndpoint.get("path", "/path", { success: ConfigPathResponse, error: ApiError }))
  .add(HttpApiEndpoint.get("database", "/database", { success: DatabaseInfoResponse, error: ApiError }))
  .add(HttpApiEndpoint.get("validate", "/validate", { success: ConfigValidationResponse, error: ApiError }))
  .add(HttpApiEndpoint.post("save", "/save", { payload: ConfigSavePayload, success: Schema.String, error: ApiError }))
  .add(HttpApiEndpoint.post("reset", "/reset", { success: ConfigResetResponse, error: ApiError }))
  .prefix("/api/config")
{}

// Accounts endpoints
export class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(HttpApiEndpoint.get("list", "/", { success: Schema.Chunk(Account) }))
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
    HttpApiEndpoint.post("subscribe", "/subscribe", {
      payload: SubscriptionPayload,
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("unsubscribe", "/unsubscribe", {
      payload: SubscriptionPayload,
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(SubscriptionResponse) })
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
    HttpApiEndpoint.get("list", "/", {
      query: Schema.Struct({
        limit: Schema.optional(
          Schema.NumberFromString.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })))
        ),
        cursor: Schema.optional(Schema.NumberFromString),
        filter: Schema.optional(Schema.Literals(["system", "prs"])),
        unreadOnly: Schema.optional(Schema.NumberFromString)
      }),
      success: PaginatedNotifications
    })
  )
  .add(
    HttpApiEndpoint.get("count", "/count", { success: Schema.Struct({ unread: Schema.Number }) })
  )
  .add(
    HttpApiEndpoint.post("markRead", "/read", {
      payload: Schema.Struct({ id: Schema.Number }),
      success: Schema.String
    })
  )
  .add(
    HttpApiEndpoint.post("markUnread", "/unread", {
      payload: Schema.Struct({ id: Schema.Number }),
      success: Schema.String
    })
  )
  .add(
    HttpApiEndpoint.post("markAllRead", "/read-all", { success: Schema.String })
  )
  .add(
    HttpApiEndpoint.post("ssoLogin", "/sso-login", {
      payload: Schema.Struct({ profile: AwsProfileName }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("ssoLogout", "/sso-logout", { success: Schema.String, error: ApiError })
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
    HttpApiEndpoint.post("create", "/", {
      payload: CreateSandboxPayload,
      success: SandboxResponse,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(SandboxResponse), error: ApiError })
  )
  .add(
    HttpApiEndpoint.get("get", "/:sandboxId", {
      params: SandboxIdPath,
      success: SandboxResponse,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("stop", "/:sandboxId/stop", {
      params: SandboxIdPath,
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("restart", "/:sandboxId/restart", {
      params: SandboxIdPath,
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.delete("delete", "/:sandboxId", {
      params: SandboxIdPath,
      success: Schema.String,
      error: ApiError
    })
  )
  .prefix("/api/sandbox")
{}

// Stats endpoints
export { WeeklyStats }

export class StatsGroup extends HttpApiGroup.make("stats")
  .add(
    HttpApiEndpoint.get("get", "/", {
      query: Schema.Struct({
        week: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-W\d{2}$/))),
        repo: Schema.optional(Schema.String),
        author: Schema.optional(Schema.String),
        account: Schema.optional(Schema.String)
      }),
      success: WeeklyStats,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("sync", "/sync", {
      payload: Schema.Struct({ week: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-W\d{2}$/))) }),
      success: Schema.String,
      error: ApiError
    })
  )
  .prefix("/api/stats")
{}

// Permission endpoints
const PermissionStateSchema = Schema.Literals(["always_allow", "allow", "deny"])

const PermissionEntry = Schema.Struct({
  operation: Schema.String,
  state: PermissionStateSchema,
  category: Schema.Literals(["read", "write"]),
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
    HttpApiEndpoint.post("respond", "/respond", {
      payload: Schema.Struct({
        id: Schema.String,
        response: Schema.Literals(["allow_once", "always_allow", "deny"])
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(PermissionEntry) })
  )
  .add(
    HttpApiEndpoint.post("update", "/update", {
      payload: Schema.Struct({
        operation: Schema.String,
        state: PermissionStateSchema
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("reset", "/reset", { success: Schema.String })
  )
  .add(
    HttpApiEndpoint.get("auditSettings", "/audit", {
      success: Schema.Struct({
        enabled: Schema.Boolean,
        retentionDays: Schema.Number
      })
    })
  )
  .add(
    HttpApiEndpoint.post("updateAuditSettings", "/audit", {
      payload: Schema.Struct({
        enabled: Schema.optional(Schema.Boolean),
        retentionDays: Schema.optional(Schema.Number)
      }),
      success: Schema.String,
      error: ApiError
    })
  )
  .prefix("/api/permissions")
{}

// Audit log endpoints
export class AuditGroup extends HttpApiGroup.make("audit")
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: Schema.Struct({
        limit: Schema.optional(
          Schema.NumberFromString.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 })))
        ),
        offset: Schema.optional(Schema.NumberFromString.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
        operation: Schema.optional(Schema.String),
        accountProfile: Schema.optional(Schema.String),
        permissionState: Schema.optional(Schema.String),
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String),
        search: Schema.optional(Schema.String)
      }),
      success: Schema.Struct({
        items: Schema.Array(AuditLogEntryResponse),
        total: Schema.Number,
        nextCursor: Schema.optional(Schema.Number)
      }),
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.get("export", "/export", {
      query: Schema.Struct({
        from: Schema.optional(Schema.String),
        to: Schema.optional(Schema.String)
      }),
      success: Schema.Array(AuditLogEntryResponse),
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.delete("clear", "/", {
      success: Schema.Struct({ deleted: Schema.Number }),
      error: ApiError
    })
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
