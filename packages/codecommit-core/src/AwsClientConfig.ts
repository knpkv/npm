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
import { fromNodeProviderChain, fromSSO } from "@aws-sdk/credential-providers"
import type { Duration } from "effect"
import { Context, Layer } from "effect"

import { makeProfileCredentialProvider } from "./AwsClientConfig/internal/ProfileCredentialProvider.js"

/** Credential material consumed only by the AWS signing layer. */
export interface AwsCredentialIdentity {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly expiration?: Date
}

/** Replaceable credential boundary used by deterministic provider runtimes. */
export type AwsCredentialProvider = (input: {
  readonly profile: string
  readonly region: string
}) => Promise<AwsCredentialIdentity>

/**
 * Shape of the AWS client configuration.
 *
 * @category Config
 */
export interface AwsClientConfigContract {
  readonly credentialProvider: AwsCredentialProvider
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
  AwsClientConfigContract
>()("@knpkv/codecommit-core/AwsClientConfig") {}

const profileCredentialProvider = makeProfileCredentialProvider({
  sso: fromSSO,
  fallback: fromNodeProviderChain
})

const defaults: AwsClientConfigContract = {
  credentialProvider: async ({ profile }) => {
    const identity = await profileCredentialProvider(profile)
    return {
      accessKeyId: identity.accessKeyId,
      secretAccessKey: identity.secretAccessKey,
      ...(!(identity.sessionToken === undefined) && { sessionToken: identity.sessionToken }),
      ...(!(identity.expiration === undefined) && { expiration: identity.expiration })
    }
  },
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
export const layer = (overrides: Partial<AwsClientConfigContract>): Layer.Layer<AwsClientConfig> =>
  Layer.succeed(AwsClientConfig, { ...defaults, ...overrides })
