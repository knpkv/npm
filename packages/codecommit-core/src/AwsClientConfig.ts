/**
 * Centralized configuration for AWS client timeouts and retry behavior.
 *
 * Replaces all hardcoded timeout/retry values scattered across AwsClient.
 *
 * @example
 * ```typescript
 * import { AwsClientConfig } from "@knpkv/codecommit-core"
 *
 * // Use defaults
 * const layer = AwsClientConfig.Default
 *
 * // Custom overrides
 * const layer = AwsClientConfig.layer({
 *   credentialTimeout: "10 seconds",
 *   maxRetries: 3
 * })
 * ```
 *
 * @category Config
 * @module
 */
import type { Duration } from "effect"
import { Context, Layer } from "effect"

/**
 * Shape of the AWS client configuration.
 *
 * @category Config
 */
export interface AwsClientConfigShape {
  readonly credentialTimeout: Duration.DurationInput
  readonly operationTimeout: Duration.DurationInput
  readonly streamTimeout: Duration.DurationInput
  readonly refreshTimeout: Duration.DurationInput
  readonly maxRetries: number
  readonly retryBaseDelay: Duration.DurationInput
  readonly maxRetryDelay: Duration.DurationInput
}

/**
 * AWS client configuration service.
 *
 * Provides timeout and retry settings consumed by AwsClient methods.
 *
 * @category Config
 */
export class AwsClientConfig extends Context.Tag("@knpkv/codecommit-core/AwsClientConfig")<
  AwsClientConfig,
  AwsClientConfigShape
>() {}

const defaults: AwsClientConfigShape = {
  credentialTimeout: "5 seconds",
  operationTimeout: "30 seconds",
  streamTimeout: "60 seconds",
  refreshTimeout: "120 seconds",
  maxRetries: 10,
  retryBaseDelay: "2 seconds",
  maxRetryDelay: "60 seconds"
}

/**
 * Default configuration with production-ready values.
 */
export const Default: Layer.Layer<AwsClientConfig> = Layer.succeed(AwsClientConfig, defaults)

/**
 * Create a configuration layer with custom overrides.
 */
export const layer = (overrides: Partial<AwsClientConfigShape>): Layer.Layer<AwsClientConfig> =>
  Layer.succeed(AwsClientConfig, { ...defaults, ...overrides })
