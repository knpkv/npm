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
import { AwsProfileName, AwsRegion, SandboxId } from "./Domain.js"

/**
 * AWS credential acquisition failure.
 *
 * @category Errors
 */
export class AwsCredentialError extends Schema.TaggedErrorClass<AwsCredentialError>()(
  "AwsCredentialError",
  {
    profile: AwsProfileName,
    region: AwsRegion,
    cause: Schema.Defect()
  }
) {
  constructor(args: { readonly profile: AwsProfileName; readonly region: AwsRegion; readonly cause: unknown }) {
    super({ _tag: "AwsCredentialError", ...args })
  }
}

/**
 * AWS API throttling / rate limiting.
 *
 * @category Errors
 */
export class AwsThrottleError extends Schema.TaggedErrorClass<AwsThrottleError>()(
  "AwsThrottleError",
  {
    operation: Schema.String,
    retryCount: Schema.Number,
    cause: Schema.Defect()
  }
) {
  constructor(args: { readonly operation: string; readonly retryCount: number; readonly cause: unknown }) {
    super({ _tag: "AwsThrottleError", ...args })
  }
}

/**
 * AWS API call failure.
 *
 * @category Errors
 */
export class AwsApiError extends Schema.TaggedErrorClass<AwsApiError>()(
  "AwsApiError",
  {
    operation: Schema.String,
    profile: AwsProfileName,
    region: AwsRegion,
    cause: Schema.Defect()
  }
) {
  constructor(args: {
    readonly operation: string
    readonly profile: AwsProfileName
    readonly region: AwsRegion
    readonly cause: unknown
  }) {
    super({ _tag: "AwsApiError", ...args })
  }
}

/**
 * Configuration load/save failure.
 *
 * @category Errors
 */
export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {
  constructor(args: { readonly message: string; readonly cause?: unknown }) {
    super({ _tag: "ConfigError", ...args })
  }
}

/**
 * Configuration file parse failure (JSON or Schema validation).
 *
 * @category Errors
 */
export class ConfigParseError extends Schema.TaggedErrorClass<ConfigParseError>()(
  "ConfigParseError",
  {
    path: Schema.String,
    cause: Schema.Defect()
  }
) {
  constructor(args: { readonly path: string; readonly cause: unknown }) {
    super({ _tag: "ConfigParseError", ...args })
  }
}

/**
 * AWS profile detection failure.
 *
 * @category Errors
 */
export class ProfileDetectionError extends Schema.TaggedErrorClass<ProfileDetectionError>()(
  "ProfileDetectionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {
  constructor(args: { readonly message: string; readonly cause?: unknown }) {
    super({ _tag: "ProfileDetectionError", ...args })
  }
}

/**
 * Refresh orchestration failure — one or more accounts failed.
 *
 * @category Errors
 */
export class RefreshError extends Schema.TaggedErrorClass<RefreshError>()(
  "RefreshError",
  {
    failedAccounts: Schema.Array(Schema.String),
    cause: Schema.optional(Schema.Defect())
  }
) {
  constructor(args: { readonly failedAccounts: ReadonlyArray<string>; readonly cause?: unknown }) {
    super({ _tag: "RefreshError", ...args })
  }
}

/**
 * Docker Engine interaction failure.
 *
 * @category Errors
 */
export class DockerError extends Schema.TaggedErrorClass<DockerError>()(
  "DockerError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {
  constructor(args: { readonly operation: string; readonly cause?: unknown }) {
    super({ _tag: "DockerError", ...args })
  }
}

/**
 * Sandbox lifecycle failure.
 *
 * @category Errors
 */
export class SandboxError extends Schema.TaggedErrorClass<SandboxError>()(
  "SandboxError",
  {
    sandboxId: Schema.optional(SandboxId),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {
  constructor(args: { readonly sandboxId?: SandboxId; readonly message: string; readonly cause?: unknown }) {
    super({ _tag: "SandboxError", ...args })
  }
}

/**
 * API call blocked by permission gate.
 *
 * @category Errors
 */
export class PermissionDeniedError extends Schema.TaggedErrorClass<PermissionDeniedError>()(
  "PermissionDeniedError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["denied", "timeout"])
  }
) {
  constructor(args: { readonly operation: string; readonly reason: "denied" | "timeout" }) {
    super({ _tag: "PermissionDeniedError", ...args })
  }
}

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
  | DockerError
  | SandboxError
  | PermissionDeniedError
