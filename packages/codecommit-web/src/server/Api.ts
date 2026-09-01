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
import { ReviewKind, ReviewProfileConfig, reviewProfileSkillLimit } from "@knpkv/codecommit-core/ReviewProfile.js"
import { WeeklyStats } from "@knpkv/codecommit-core/StatsService/WeeklyStats.js"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import {
  MAXIMUM_RELAY_REVIEW_MESSAGE_BYTES,
  MAXIMUM_RELAY_REVIEW_RESULT_BYTES,
  MAXIMUM_RELAY_REVIEW_TURNS_BYTES
} from "./review/ReviewPromptBudget.js"

const jsonByteEncoder = new TextEncoder()

// API error returned to clients for AWS failures
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  message: Schema.String
}) {}

export class UnauthorizedApiError extends Schema.TaggedError<UnauthorizedApiError>()(
  "UnauthorizedApiError",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

export class ForbiddenApiError extends Schema.TaggedError<ForbiddenApiError>()(
  "ForbiddenApiError",
  { message: Schema.String },
  { httpApiStatus: 403 }
) {}

/** Process-scoped owner session required by every CodeCommit API endpoint. */
export class OwnerSessionAuth extends HttpApiMiddleware.Service<OwnerSessionAuth>()(
  "@knpkv/codecommit-web/OwnerSessionAuth",
  {
    error: [UnauthorizedApiError, ForbiddenApiError],
    security: {
      ownerCookie: HttpApiSecurity.apiKey({ in: "cookie", key: "cc_owner" })
    }
  }
) {}

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

const PullRequestDiffFileResponse = Schema.Struct({
  index: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  beforeMode: Schema.NullOr(Schema.String),
  afterMode: Schema.NullOr(Schema.String)
})

/** Complete changed-file inventory bound to one immutable CodeCommit revision. */
export const PullRequestDiffResponse = Schema.Struct({
  pullRequestId: PullRequestId,
  revisionId: Schema.String,
  baseCommit: Schema.String,
  headCommit: Schema.String,
  files: Schema.Array(PullRequestDiffFileResponse)
})
export type PullRequestDiffResponse = typeof PullRequestDiffResponse.Type

/** Exact provider revision observed by a completed single-PR refresh. */
export const PullRequestRefreshResponse = Schema.Struct({
  revisionId: Schema.String,
  headCommit: Schema.String
})
export type PullRequestRefreshResponse = typeof PullRequestRefreshResponse.Type

/** Provider coordinates required to keep same-id pull requests distinct. */
const PullRequestCoordinates = Schema.Struct({
  repositoryName: Schema.String,
  region: AwsRegion
})

/** Legacy refresh links may omit coordinates, but a partial coordinate is never valid. */
const PullRequestRefreshCoordinates = Schema.Struct({
  repositoryName: Schema.optional(Schema.String),
  region: Schema.optional(AwsRegion)
}).check(
  Schema.makeFilter(
    ({ region, repositoryName }) => (repositoryName === undefined) === (region === undefined),
    { expected: "repositoryName and region must be provided together" }
  )
)

/** Bounded text for one inventory entry; exceptional content remains explicit. */
export const PullRequestDiffContentResponse = Schema.Struct({
  fileIndex: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  revisionId: Schema.String,
  state: Schema.Literals(["text", "binary", "oversized"]),
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String)
})
export type PullRequestDiffContentResponse = typeof PullRequestDiffContentResponse.Type

export const RelayReviewKind = ReviewKind
export type RelayReviewKind = typeof RelayReviewKind.Type

const RelayReviewFindingId = Schema.String.check(Schema.isPattern(/^F[1-9][0-9]{0,5}$/u))
const RelayReviewConversationTarget = Schema.Union([RelayReviewFindingId, Schema.Literal("PR")])
const RelayReviewConversationTurnId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
)
export const RelayReviewSkillId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(256)
)
export const RelayReviewSkillIds = Schema.Array(RelayReviewSkillId).check(
  Schema.isMaxLength(reviewProfileSkillLimit),
  Schema.isUnique()
)

/** Complete server-validated execution configuration owned by one saved profile. */
export const RelayReviewProfile = ReviewProfileConfig
export type RelayReviewProfile = typeof RelayReviewProfile.Type

const RelayReviewLocation = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("general") }),
  Schema.Struct({
    scope: Schema.Literal("file"),
    filePath: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))
  }),
  Schema.Struct({
    scope: Schema.Literal("line"),
    filePath: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
    line: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
    side: Schema.Literals(["before", "after"])
  })
])

export const RelayReviewFinding = Schema.Struct({
  id: RelayReviewFindingId,
  priority: Schema.Literals(["P1", "P2", "P3", "P4"]),
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  summary: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  details: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_000)),
  recommendation: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  verification: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
  publicationTarget: Schema.Literals(["pr-comment", "line-comment"]),
  location: RelayReviewLocation
}).check(
  Schema.makeFilter(
    (finding) => (finding.location.scope === "line") === (finding.publicationTarget === "line-comment"),
    { expected: "line-comment paired with a line location and pr-comment paired with a general or file location" }
  )
)
export type RelayReviewFinding = typeof RelayReviewFinding.Type

const RelayReviewVerdict = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(8_000))
const RelayReviewExplanation = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(12_000)
)

const RelayReviewFindings = Schema.Array(RelayReviewFinding).check(
  Schema.isMaxLength(50),
  Schema.makeFilter((findings) => new Set(findings.map((finding) => finding.id)).size === findings.length, {
    expected: "unique Relay finding ids"
  })
)

/** Native non-Explain output excludes Explain's required explanation field. */
export const RelayNativeReviewResult = Schema.Struct({
  findings: RelayReviewFindings,
  verdict: RelayReviewVerdict
})

export const RelayReviewResult = Schema.Struct({
  ...RelayNativeReviewResult.fields,
  explanation: Schema.optional(RelayReviewExplanation)
}).check(
  Schema.makeFilter(
    (result) => jsonByteEncoder.encode(JSON.stringify(result)).byteLength <= MAXIMUM_RELAY_REVIEW_RESULT_BYTES,
    { expected: `a Relay review result no larger than ${String(MAXIMUM_RELAY_REVIEW_RESULT_BYTES)} UTF-8 bytes` }
  )
)
export type RelayReviewResult = typeof RelayReviewResult.Type

/** Explain-mode native schema makes a findings-shaped response impossible. */
export const RelayExplainResult = Schema.Struct({
  findings: Schema.Array(RelayReviewFinding).check(Schema.isMaxLength(0)),
  verdict: RelayReviewVerdict,
  explanation: RelayReviewExplanation
}).check(
  Schema.makeFilter(
    (result) => jsonByteEncoder.encode(JSON.stringify(result)).byteLength <= MAXIMUM_RELAY_REVIEW_RESULT_BYTES,
    { expected: `an Explain result no larger than ${String(MAXIMUM_RELAY_REVIEW_RESULT_BYTES)} UTF-8 bytes` }
  )
)

/** One Relay result bound to the exact diff that was reviewed within a durable pull-request thread. */
export const PullRequestRelayReviewResponse = Schema.Struct({
  pullRequestId: PullRequestId,
  revisionId: Schema.String,
  baseCommit: Schema.String,
  headCommit: Schema.String,
  kind: RelayReviewKind,
  profile: RelayReviewProfile,
  result: RelayReviewResult
}).check(
  Schema.makeFilter(
    (response) =>
      response.kind === response.profile.kind &&
      (response.kind !== "explain" ||
        (response.result.explanation !== undefined && response.result.findings.length === 0)),
    { expected: "a response matching its profile and Explain output contract" }
  )
)
export type PullRequestRelayReviewResponse = typeof PullRequestRelayReviewResponse.Type

export const RelayReviewMessage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(8_000),
  Schema.makeFilter(
    (message) => jsonByteEncoder.encode(message).byteLength <= MAXIMUM_RELAY_REVIEW_MESSAGE_BYTES,
    {
      expected: `a Relay conversation message no larger than ${String(MAXIMUM_RELAY_REVIEW_MESSAGE_BYTES)} UTF-8 bytes`
    }
  ),
  Schema.makeFilter(
    (message) =>
      jsonByteEncoder.encode(JSON.stringify(message)).byteLength <=
        Math.floor((MAXIMUM_RELAY_REVIEW_TURNS_BYTES - 128) / 2),
    { expected: "a Relay conversation message retainable as one half of a completed exchange" }
  )
)

export const RelayReviewConversationTurn = Schema.Struct({
  id: Schema.optional(RelayReviewConversationTurnId),
  findingId: RelayReviewConversationTarget,
  role: Schema.Literals(["user", "assistant"]),
  message: RelayReviewMessage
})
export type RelayReviewConversationTurn = typeof RelayReviewConversationTurn.Type

export const RelayReviewProgressPhase = Schema.Literals([
  "revision",
  "files",
  "patch",
  "agent",
  "validation",
  "posting"
])
export type RelayReviewProgressPhase = typeof RelayReviewProgressPhase.Type

export const RelayReviewStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    phase: RelayReviewProgressPhase,
    message: Schema.String,
    detail: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    review: PullRequestRelayReviewResponse,
    reply: Schema.optional(RelayReviewMessage)
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String
  })
])
export type RelayReviewStreamEvent = typeof RelayReviewStreamEvent.Type

export const RelayFindingPostResponse = Schema.Struct({
  findingId: RelayReviewFindingId,
  operationId: Schema.String,
  summary: Schema.String
})
export type RelayFindingPostResponse = typeof RelayFindingPostResponse.Type

export const RelayReviewStreamRequest = Schema.Struct({
  revisionId: Schema.String,
  baseCommit: Schema.String,
  headCommit: Schema.String,
  profile: RelayReviewProfile
})
export type RelayReviewStreamRequest = typeof RelayReviewStreamRequest.Type

export const MAXIMUM_RELAY_REVIEW_TURNS = 40

export const RelayReviewConversationTurns = Schema.Array(RelayReviewConversationTurn).check(
  Schema.isMaxLength(MAXIMUM_RELAY_REVIEW_TURNS),
  Schema.makeFilter(
    (turns) => jsonByteEncoder.encode(JSON.stringify(turns)).byteLength <= MAXIMUM_RELAY_REVIEW_TURNS_BYTES,
    { expected: `Relay conversation turns no larger than ${String(MAXIMUM_RELAY_REVIEW_TURNS_BYTES)} UTF-8 bytes` }
  )
)

export const RelayReviewContinueStreamRequest = Schema.Struct({
  ...RelayReviewStreamRequest.fields,
  currentReview: RelayReviewResult,
  turns: RelayReviewConversationTurns,
  findingId: RelayReviewConversationTarget,
  message: RelayReviewMessage
}).check(
  Schema.makeFilter(
    ({ findingId, message }) => Schema.is(RelayReviewConversationTurn)({ findingId, role: "user", message }),
    { expected: "a continuation message retainable as its user conversation turn" }
  )
)
export type RelayReviewContinueStreamRequest = typeof RelayReviewContinueStreamRequest.Type

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
      query: PullRequestRefreshCoordinates,
      success: PullRequestRefreshResponse,
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
    HttpApiEndpoint.get("diff", "/:awsAccountId/:prId/diff", {
      params: Schema.Struct({ awsAccountId: Schema.String, prId: PullRequestId }),
      query: PullRequestCoordinates,
      success: PullRequestDiffResponse,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.get("diffContent", "/:awsAccountId/:prId/diff/:fileIndex", {
      params: Schema.Struct({
        awsAccountId: Schema.String,
        prId: PullRequestId,
        fileIndex: Schema.NumberFromString.pipe(
          Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
        )
      }),
      query: Schema.Struct({
        ...PullRequestCoordinates.fields,
        revisionId: Schema.String,
        baseCommit: Schema.String,
        headCommit: Schema.String
      }),
      success: PullRequestDiffContentResponse,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("relayReview", "/:awsAccountId/:prId/relay-review", {
      params: Schema.Struct({ awsAccountId: Schema.String, prId: PullRequestId }),
      query: PullRequestCoordinates,
      payload: Schema.Struct({
        revisionId: Schema.String,
        baseCommit: Schema.String,
        headCommit: Schema.String,
        profile: RelayReviewProfile
      }),
      success: PullRequestRelayReviewResponse,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("relayReviewStream", "/:awsAccountId/:prId/relay-review/stream", {
      params: Schema.Struct({ awsAccountId: Schema.String, prId: PullRequestId }),
      query: PullRequestCoordinates,
      payload: RelayReviewStreamRequest,
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("relayReviewContinueStream", "/:awsAccountId/:prId/relay-review/continue", {
      params: Schema.Struct({ awsAccountId: Schema.String, prId: PullRequestId }),
      query: PullRequestCoordinates,
      payload: RelayReviewContinueStreamRequest,
      success: Schema.String,
      error: ApiError
    })
  )
  .add(
    HttpApiEndpoint.post("postRelayFinding", "/:awsAccountId/:prId/relay-review/findings/:findingId/post", {
      params: Schema.Struct({ awsAccountId: Schema.String, prId: PullRequestId, findingId: RelayReviewFindingId }),
      query: PullRequestCoordinates,
      payload: Schema.Struct({
        revisionId: Schema.String,
        baseCommit: Schema.String,
        headCommit: Schema.String,
        finding: RelayReviewFinding
      }),
      success: RelayFindingPostResponse,
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

const ReviewProfileResponse = RelayReviewProfile

const ReviewSettingsResponse = Schema.Struct({
  defaultProfileId: Schema.String,
  profiles: Schema.Array(ReviewProfileResponse)
})

export const ReviewSkillResponse = Schema.Struct({
  id: RelayReviewSkillId,
  name: Schema.String,
  description: Schema.String,
  source: Schema.String
})
export type ReviewSkillResponse = typeof ReviewSkillResponse.Type

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
  review: ReviewSettingsResponse,
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
  review: Schema.optional(ReviewSettingsResponse),
  sandbox: Schema.optional(SandboxSettingsResponse)
})

const ConfigRefreshStatus = Schema.Literals(["refreshed", "failed"])

const ConfigResetResponse = Schema.Struct({
  backupPath: Schema.optional(Schema.String),
  config: ConfigResponse,
  refreshStatus: ConfigRefreshStatus
})

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(HttpApiEndpoint.get("list", "/", { success: ConfigResponse }))
  .add(HttpApiEndpoint.get("path", "/path", { success: ConfigPathResponse, error: ApiError }))
  .add(HttpApiEndpoint.get("database", "/database", { success: DatabaseInfoResponse, error: ApiError }))
  .add(HttpApiEndpoint.get("validate", "/validate", { success: ConfigValidationResponse, error: ApiError }))
  .add(HttpApiEndpoint.get("reviewSkills", "/review-skills", {
    success: Schema.Array(ReviewSkillResponse),
    error: ApiError
  }))
  .add(HttpApiEndpoint.post("save", "/save", {
    payload: ConfigSavePayload,
    success: Schema.Literals(["saved", "saved-refresh-failed"]),
    error: ApiError
  }))
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
  region: Schema.String,
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

export const SandboxCredentialsResponse = Schema.Struct({
  password: Schema.String
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
    HttpApiEndpoint.get("credentials", "/:sandboxId/credentials", {
      params: SandboxIdPath,
      success: SandboxCredentialsResponse,
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
  .middleware(OwnerSessionAuth)
{}
