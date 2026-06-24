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
  readonly credentialTimeout: Duration.Input
  readonly operationTimeout: Duration.Input
  readonly streamTimeout: Duration.Input
  readonly refreshTimeout: Duration.Input
  readonly maxRetries: number
  readonly retryBaseDelay: Duration.Input
  readonly maxRetryDelay: Duration.Input
}

/**
 * AWS client configuration service.
 *
 * Provides timeout and retry settings consumed by AwsClient methods.
 *
 * @category Config
 */
export class AwsClientConfig extends Context.Service<
  AwsClientConfig,
  AwsClientConfigShape
>()("@knpkv/codecommit-core/AwsClientConfig") {}

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
