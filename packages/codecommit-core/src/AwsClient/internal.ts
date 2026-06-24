/**
 * Shared helpers, parameter types, and transport schemas for all AwsClient
 * method files.
 *
 * Provides {@link withAwsContext} (credential acquisition + Layer provision +
 * throttle-retry + timeout), {@link throttleRetry} (exponential backoff on
 * ThrottlingException), {@link normalizeAuthor} (ARN → human name), and
 * {@link PullRequestDetail} (internal transport type for single-PR fetch
 * with approval rules, approver ARNs, and repo account ID).
 *
 * **Mental model**
 *
 * - {@link withAwsContext}: acquires credentials, provides Credentials + Region +
 *   HttpClient + AwsClientConfig to inner effect, wraps with throttle-retry + timeout
 * - {@link throttleRetry}: exponential backoff on AWS ThrottlingException
 * - {@link normalizeAuthor}: `arn:aws:sts::ACCT:assumed-role/Role/Session` → `Session`
 * - {@link PullRequestDetail}: transport type for single-PR path. Uses inline struct
 *   for `approvalRules` — Schema.Class constructors reject plain objects.
 *
 * **Gotchas**
 *
 * - `withAwsContext` effect type includes `AwsClientConfig` — inner effects
 *   that use `throttleRetry` need this in their context
 * - `PullRequestDetail.approvalRules` intentionally diverges from `Domain.ApprovalRule`
 *
 * @internal
 */
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import * as DistilledCredentials from "distilled-aws/Credentials"
import * as DistilledRegion from "distilled-aws/Region"
import { Duration, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AwsClientConfig, type AwsClientConfigShape } from "../AwsClientConfig.js"
import type { Account, AwsProfileName, AwsRegion } from "../Domain.js"
import { AwsApiError, AwsCredentialError } from "../Errors.js"

export { AwsApiError, AwsCredentialError } from "../Errors.js"
export type { AwsClientError } from "../Errors.js"

/**
 * Check if an error is an AWS throttling exception.
 * Inspects structured error properties instead of pretty-printing.
 */
export const isThrottlingError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const name = "name" in error ? String(error.name) : ""
  const code = "code" in error ? String(error.code).toLowerCase() : ""
  const message = "message" in error ? String(error.message).toLowerCase() : ""
  return name === "ThrottlingException"
    || name === "TooManyRequestsException"
    || code === "throttling"
    || code === "requestlimitexceeded"
    || code === "slowdown"
    || message.includes("rate exceed")
    || message.includes("too many requests")
}

interface AwsCredentialIdentity {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly expiration?: Date
}

type AwsRuntimeEnv =
  | AwsClientConfig
  | DistilledCredentials.Credentials
  | DistilledRegion.Region
  | HttpClient.HttpClient

const makeThrottleSchedule = (config: AwsClientConfigShape) =>
  Schedule.both(
    Schedule.exponential(config.retryBaseDelay, 2).pipe(Schedule.jittered),
    Schedule.recurs(config.maxRetries)
  ).pipe(
    Schedule.modifyDelay((_output, delay) =>
      Effect.succeed(Duration.min(delay, Duration.fromInputUnsafe(config.maxRetryDelay)))
    )
  )

/**
 * Pipe-friendly throttle retry. Reads schedule config from AwsClientConfig context.
 */
export const throttleRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | AwsClientConfig> =>
  Effect.flatMap(AwsClientConfig, (config) =>
    effect.pipe(
      Effect.retry({ schedule: makeThrottleSchedule(config), while: isThrottlingError })
    ))

/**
 * Normalize AWS author ARN to a human-readable name.
 *
 * e.g. `arn:aws:sts::...:assumed-role/Role/SessionName` → `SessionName`
 */
export const normalizeAuthor = (arn: string): string => {
  const parts = arn.split(":")
  const identityPart = parts[parts.length - 1] ?? ""
  const segments = identityPart.split("/")
  return segments[segments.length - 1] || arn
}

/**
 * Acquire AWS credentials for a profile.
 * Reads credential timeout from AwsClientConfig context.
 */
export const acquireCredentials = (
  profile: AwsProfileName,
  region: AwsRegion
): Effect.Effect<AwsCredentialIdentity, AwsCredentialError, AwsClientConfig> =>
  Effect.flatMap(AwsClientConfig, (config) =>
    Effect.tryPromise({
      try: async () => await fromNodeProviderChain(profile === "default" ? {} : { profile })() as AwsCredentialIdentity,
      catch: (cause) => new AwsCredentialError({ profile, region, cause })
    }).pipe(
      Effect.timeout(config.credentialTimeout),
      Effect.catchTag("TimeoutError", (cause) => new AwsCredentialError({ profile, region, cause }))
    ))

/**
 * Create a typed AwsApiError for a specific operation.
 */
export const makeApiError = (operation: string, profile: AwsProfileName, region: AwsRegion, cause: unknown) =>
  new AwsApiError({ operation, profile, region, cause })

/**
 * Common account parameter shape. Derived from Domain.Account.
 */
export type AccountParams = Pick<Account, "profile" | "region">

/**
 * Shared combinator: acquire credentials → build Layer → provide → retry → timeout.
 * Eliminates boilerplate repeated across all AwsClient method files.
 */
export const withAwsContext = <A, E>(
  operation: string,
  account: AccountParams,
  effect: Effect.Effect<A, E, AwsRuntimeEnv>,
  options?: { readonly timeout?: "stream" }
): Effect.Effect<A, E | AwsCredentialError | AwsApiError, AwsClientConfig | HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const config = yield* AwsClientConfig
    const httpClient = yield* HttpClient.HttpClient
    const credentials = yield* acquireCredentials(account.profile, account.region)
    const timeout = options?.timeout === "stream" ? config.streamTimeout : config.operationTimeout

    return yield* Effect.provide(
      effect,
      Layer.mergeAll(
        DistilledCredentials.fromCredentials(credentials),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(DistilledRegion.Region, account.region),
        Layer.succeed(AwsClientConfig, config)
      )
    ).pipe(
      throttleRetry,
      Effect.timeout(timeout),
      Effect.catchTag(
        "TimeoutError",
        (cause) => Effect.fail(makeApiError(operation, account.profile, account.region, cause))
      )
    )
  })

// ---------------------------------------------------------------------------
// Method Parameter Types
// ---------------------------------------------------------------------------

export interface CreatePullRequestParams {
  readonly account: AccountParams
  readonly repositoryName: string
  readonly title: string
  readonly description?: string
  readonly sourceReference: string
  readonly destinationReference: string
}

export interface ListBranchesParams {
  readonly account: AccountParams
  readonly repositoryName: string
}

export interface GetCommentsForPullRequestParams {
  readonly account: AccountParams
  readonly pullRequestId: string
  /** @deprecated Currently unused — passing repositoryName without commit IDs triggers CommitIdRequiredException. Kept for API compatibility. */
  readonly repositoryName: string
}

export interface UpdatePullRequestTitleParams {
  readonly account: AccountParams
  readonly pullRequestId: string
  readonly title: string
}

export interface UpdatePullRequestDescriptionParams {
  readonly account: AccountParams
  readonly pullRequestId: string
  readonly description: string
}

export interface GetPullRequestParams {
  readonly account: AccountParams
  readonly pullRequestId: string
}

export interface GetDifferencesParams {
  readonly account: AccountParams
  readonly repositoryName: string
  readonly beforeCommitSpecifier: string
  readonly afterCommitSpecifier: string
}

export interface DiffStats {
  readonly filesAdded: number
  readonly filesModified: number
  readonly filesDeleted: number
}

export interface CreateApprovalRuleParams {
  readonly account: AccountParams
  readonly pullRequestId: string
  readonly approvalRuleName: string
  readonly approvalRuleContent: string
}

export interface UpdateApprovalRuleParams {
  readonly account: AccountParams
  readonly pullRequestId: string
  readonly approvalRuleName: string
  readonly newApprovalRuleContent: string
}

export interface DeleteApprovalRuleParams {
  readonly account: AccountParams
  readonly pullRequestId: string
  readonly approvalRuleName: string
}

export class PullRequestDetail extends Schema.Class<PullRequestDetail>("PullRequestDetail")({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  author: Schema.String,
  status: Schema.String,
  repositoryName: Schema.String,
  sourceBranch: Schema.String,
  destinationBranch: Schema.String,
  creationDate: Schema.Date,
  lastActivityDate: Schema.Date,
  mergedBy: Schema.optional(Schema.String),
  approvedBy: Schema.Array(Schema.String),
  approvedByArns: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  repoAccountId: Schema.optional(Schema.String),
  // Inline struct instead of Domain.ApprovalRule — Schema.Class constructors reject plain objects
  // from buildApprovalRules(). PullRequestDetail is an internal transport type, not a domain boundary.
  approvalRules: Schema.Array(Schema.Struct({
    ruleName: Schema.String,
    requiredApprovals: Schema.Number,
    poolMembers: Schema.Array(Schema.String),
    poolMemberArns: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
    satisfied: Schema.Boolean,
    fromTemplate: Schema.optional(Schema.String)
  })).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([])))
}) {}
