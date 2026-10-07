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
import { Predicate, Schema } from "effect"
import { AwsProfileName, AwsRegion, SandboxId } from "./Domain.js"

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
    cause: Schema.Defect()
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
    cause: Schema.Defect()
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
    cause: Schema.Defect()
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
    cause: Schema.optional(Schema.Defect())
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
    cause: Schema.Defect()
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
    cause: Schema.optional(Schema.Defect())
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
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Docker Engine interaction failure.
 *
 * @category Errors
 */
export class DockerError extends Schema.TaggedError<DockerError>()(
  "DockerError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Sandbox lifecycle failure.
 *
 * @category Errors
 */
export class SandboxError extends Schema.TaggedError<SandboxError>()(
  "SandboxError",
  {
    sandboxId: Schema.optional(SandboxId),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * Sandbox configuration rejected before persistence or container creation.
 *
 * @category Errors
 */
export class SandboxConfigurationError extends Schema.TaggedError<SandboxConfigurationError>()(
  "SandboxConfigurationError",
  {
    message: Schema.String
  }
) {}

/**
 * API call blocked by permission gate.
 *
 * @category Errors
 */
export class PermissionDeniedError extends Schema.TaggedError<PermissionDeniedError>()(
  "PermissionDeniedError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["denied", "timeout"])
  }
) {}

/**
 * A pull request route names an account whose configured profile is switched off, so nothing may read
 * it until the user switches it back on. Pull request URLs stay addressable for hidden accounts, so this
 * is what such a route reports instead of a generic refresh failure.
 *
 * @category Errors
 */
export class AccountSwitchedOff extends Schema.TaggedError<AccountSwitchedOff>()("AccountSwitchedOff", {
  awsAccountId: Schema.String,
  profile: Schema.String
}) {
  override get message() {
    return `${this.profile} is switched off, so this pull request can't be read. Switch it on in Settings → Accounts.`
  }
}

/**
 * A pull request route names an account that no configured profile is known to own.
 *
 * @category Errors
 */
export class AccountUnknown extends Schema.TaggedError<AccountUnknown>()("AccountUnknown", {
  awsAccountId: Schema.String
}) {
  override get message() {
    return `None of your accounts is known to read ${this.awsAccountId}. Switch on the account that owns it in Settings → Accounts, or check the link.`
  }
}

/**
 * Union of errors from AwsClient methods.
 *
 * @category Errors
 */
export type AwsClientError = AwsCredentialError | AwsThrottleError | AwsApiError

/**
 * One line naming what the provider said, for notifications and logs: the provider error's own name and
 * message ("UnrecognizedClientException: The security token included in the request is invalid."), not
 * the wrapper's tag. Credentials and throttling say so first.
 */
export const describeAwsClientError = (error: AwsClientError): string => {
  const inner = error.cause
  const provider = Predicate.isError(inner)
    ? `${inner.name !== "Error" ? `${inner.name}: ` : ""}${inner.message}`
    : String(inner)
  const detail = provider.trim().length > 0 ? provider.trim() : "no detail from the provider"
  switch (error._tag) {
    case "AwsCredentialError":
      return `Credentials unavailable: ${detail}`
    case "AwsThrottleError":
      return `Throttled: ${detail}`
    case "AwsApiError":
      return detail
  }
}

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
  | DockerError
  | SandboxError
  | SandboxConfigurationError
  | PermissionDeniedError
