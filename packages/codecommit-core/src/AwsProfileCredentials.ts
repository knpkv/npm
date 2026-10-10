/**
 * AWS credential resolution for one named local profile, shared by every AWS adapter.
 *
 * The SDK's standard chain reads `~/.aws/credentials` before the SSO settings in `~/.aws/config`, so a
 * leftover static section for a profile silently wins over a fresh `aws sso login`. Adapters resolve
 * through {@link makeProfileCredentialProvider} instead, which tries SSO first.
 *
 * Every profile, `default` included, is passed to both providers by name. Without a name the SDK
 * would pick `AWS_PROFILE` or ambient environment credentials, and the identity actually used would
 * differ from the profile the UI and audit records name. For the same reason the fallback should
 * read only the named shared-config profile (`fromIni`), not the full node chain with its
 * environment, web-identity and instance-metadata sources.
 *
 * @example
 * ```typescript
 * import { fromIni, fromSSO } from "@aws-sdk/credential-providers"
 * import { makeProfileCredentialProvider } from "@knpkv/codecommit-core/AwsProfileCredentials.js"
 *
 * const resolve = makeProfileCredentialProvider({ sso: fromSSO, fallback: fromIni })
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

/** The SSO provider and the shared-config fallback, injected so tests can stand in for the SDK. */
export interface ProfileCredentialProviders {
  readonly sso: ProviderFactory
  readonly fallback: ProviderFactory
}

/**
 * Resolve a profile, preferring its SSO configuration over static keys and never masking an SSO
 * failure: the fallback runs only when the profile has no SSO configuration at all.
 */
export const makeProfileCredentialProvider =
  ({ fallback, sso }: ProfileCredentialProviders) => async (profile: string): Promise<ProfileCredentialIdentity> => {
    const options = { profile }
    return chain(sso(options), fallback(options))()
  }
