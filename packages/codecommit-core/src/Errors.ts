/**
 * Comprehensive error hierarchy for CodeCommit operations.
 *
 * All errors use `Schema.TaggedError` for serialization + pattern matching.
 * Errors are yieldable — no `Effect.fail()` wrapper needed.
 *
 * @example
 * ```typescript
 * import { Errors } from "@knpkv/codecommit-core"
 *
 * // Yield directly in Effect.gen
 * yield* new Errors.AwsCredentialError({ profile: "dev", region: "us-east-1", cause: err })
 *
 * // Pattern match with catchTags
 * effect.pipe(
 *   Effect.catchTags({
 *     AwsCredentialError: (e) => handleAuth(e),
 *     AwsApiError: (e) => handleApi(e)
 *   })
 * )
 * ```
 *
 * @category Errors
 * @module
 */
import { Schema } from "effect"
import { AwsProfileName, AwsRegion } from "./Domain.js"

/**
 * AWS credential acquisition failure.
 *
 * @category Errors
 */
export class AwsCredentialError extends Schema.TaggedError<AwsCredentialError>()(
  "AwsCredentialError",
  {
    profile: AwsProfileName,
    region: AwsRegion,
    cause: Schema.Defect
  }
) {}

/**
 * AWS API throttling / rate limiting.
 *
 * @category Errors
 */
export class AwsThrottleError extends Schema.TaggedError<AwsThrottleError>()(
  "AwsThrottleError",
  {
    operation: Schema.String,
    retryCount: Schema.Number,
    cause: Schema.Defect
  }
) {}

/**
 * AWS API call failure.
 *
 * @category Errors
 */
export class AwsApiError extends Schema.TaggedError<AwsApiError>()(
  "AwsApiError",
  {
    operation: Schema.String,
    profile: AwsProfileName,
    region: AwsRegion,
    cause: Schema.Defect
  }
) {}

/**
 * Configuration load/save failure.
 *
 * @category Errors
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {}

/**
 * Configuration file parse failure (JSON or Schema validation).
 *
 * @category Errors
 */
export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()(
  "ConfigParseError",
  {
    path: Schema.String,
    cause: Schema.Defect
  }
) {}

/**
 * AWS profile detection failure.
 *
 * @category Errors
 */
export class ProfileDetectionError extends Schema.TaggedError<ProfileDetectionError>()(
  "ProfileDetectionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {}

/**
 * Refresh orchestration failure — one or more accounts failed.
 *
 * @category Errors
 */
export class RefreshError extends Schema.TaggedError<RefreshError>()(
  "RefreshError",
  {
    failedAccounts: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect)
  }
) {}

/**
 * Union of errors from AwsClient methods.
 *
 * @category Errors
 */
export type AwsClientError = AwsCredentialError | AwsThrottleError | AwsApiError

/**
 * Union of all CodeCommit errors for exhaustive matching.
 *
 * @category Errors
 */
export type CodeCommitError =
  | AwsCredentialError
  | AwsThrottleError
  | AwsApiError
  | ConfigError
  | ConfigParseError
  | ProfileDetectionError
  | RefreshError
