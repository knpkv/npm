/**
 * Shared internal helpers for AwsClient methods.
 *
 * @internal
 */
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import { Credentials } from "distilled-aws"
import { Cause, Effect, Schedule } from "effect"
import { AwsClientConfig, type AwsClientConfigShape } from "../AwsClientConfig.js"
import type { AwsProfileName, AwsRegion } from "../Domain.js"
import { AwsApiError, AwsCredentialError } from "../Errors.js"

export { AwsApiError, AwsCredentialError } from "../Errors.js"
export type { AwsClientError } from "../Errors.js"

/**
 * Check if an error is an AWS throttling exception.
 */
export const isThrottlingError = (error: unknown): boolean => {
  const errorStr = Cause.pretty(Cause.fail(error)).toLowerCase()
  return errorStr.includes("throttl")
    || errorStr.includes("rate exceed")
    || errorStr.includes("too many requests")
    || errorStr.includes("requestlimitexceeded")
    || errorStr.includes("slowdown")
    || errorStr.includes("toomanyrequestsexception")
}

const makeThrottleSchedule = (config: AwsClientConfigShape) =>
  Schedule.intersect(
    Schedule.exponential(config.retryBaseDelay, 2).pipe(Schedule.jittered),
    Schedule.recurs(config.maxRetries)
  ).pipe(Schedule.upTo(config.maxRetryDelay))

/**
 * Pipe-friendly throttle retry. Reads schedule config from AwsClientConfig context.
 */
export const throttleRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | AwsClientConfig> =>
  Effect.flatMap(AwsClientConfig, (config) =>
    effect.pipe(
      Effect.retry(
        makeThrottleSchedule(config).pipe(
          Schedule.whileInput((error: E) => isThrottlingError(error))
        )
      )
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
export const acquireCredentials = (profile: AwsProfileName, region: AwsRegion) =>
  Effect.flatMap(AwsClientConfig, (config) =>
    Effect.tryPromise({
      try: () => fromNodeProviderChain(profile === "default" ? {} : { profile })(),
      catch: (cause) => new AwsCredentialError({ profile, region, cause })
    }).pipe(
      Effect.map(Credentials.fromAwsCredentialIdentity),
      Effect.timeout(config.credentialTimeout),
      Effect.catchTag("TimeoutException", (cause) => new AwsCredentialError({ profile, region, cause }))
    ))

/**
 * Create a typed AwsApiError for a specific operation.
 */
export const makeApiError = (operation: string, profile: AwsProfileName, region: AwsRegion, cause: unknown) =>
  new AwsApiError({ operation, profile, region, cause })

/**
 * Common account parameter shape.
 */
export interface AccountParams {
  readonly profile: AwsProfileName
  readonly region: AwsRegion
}

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

export interface PullRequestDetail {
  readonly title: string
  readonly description?: string
  readonly author: string
  readonly status: string
  readonly repositoryName: string
  readonly sourceBranch: string
  readonly destinationBranch: string
  readonly creationDate: Date
}
