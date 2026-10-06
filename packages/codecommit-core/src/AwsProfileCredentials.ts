/**
 * AWS credential resolution for one named local profile, shared by every AWS adapter.
 *
 * The SDK's standard chain reads `~/.aws/credentials` before the SSO settings in `~/.aws/config`, so a
 * leftover static section for a profile silently wins over a fresh `aws sso login`. Adapters resolve
 * through {@link makeProfileCredentialProvider} instead, which tries SSO first.
 *
 * @example
 * ```typescript
 * import { fromNodeProviderChain, fromSSO } from "@aws-sdk/credential-providers"
 * import { makeProfileCredentialProvider } from "@knpkv/codecommit-core/AwsProfileCredentials.js"
 *
 * const resolve = makeProfileCredentialProvider({ sso: fromSSO, fallback: fromNodeProviderChain })
 * const identity = await resolve("dev-administratoraccess")
 * ```
 *
 * @module
 */
import { chain } from "@smithy/core/config"

/** Credential material returned by a provider. */
export interface ProfileCredentialIdentity {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly expiration?: Date
}

type Provider = () => Promise<ProfileCredentialIdentity>
type ProviderFactory = (options?: { readonly profile?: string }) => Provider

/** The SSO provider and the standard-chain fallback, injected so tests can stand in for the SDK. */
export interface ProfileCredentialProviders {
  readonly sso: ProviderFactory
  readonly fallback: ProviderFactory
}

const providerOptions = (profile: string): { readonly profile?: string } => profile === "default" ? {} : { profile }

/**
 * Resolve a profile, preferring its SSO configuration over static keys and never masking an SSO
 * failure: the fallback runs only when the profile has no SSO configuration at all.
 */
export const makeProfileCredentialProvider =
  ({ fallback, sso }: ProfileCredentialProviders) => async (profile: string): Promise<ProfileCredentialIdentity> => {
    const options = providerOptions(profile)
    return chain(sso(options), fallback(options))()
  }
