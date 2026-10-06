/**
 * AWS credential resolution for one named local profile, shared by every AWS adapter.
 *
 * The SDK's standard chain reads `~/.aws/credentials` before the SSO settings in `~/.aws/config`, so a
 * leftover static section for a profile silently wins over a fresh `aws sso login`. Adapters resolve
 * through {@link makeProfileCredentialProvider} instead, which tries SSO first, and use
 * {@link describeProfileSources} to explain a rejected session in terms of those two files.
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
import { chain, loadSharedConfigFiles } from "@smithy/core/config"

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

/** Where a profile's credentials can come from, by file. Names only, never values. */
export interface ProfileSources {
  readonly profile: string
  /** `~/.aws/config` configures SSO for this profile (`sso_session` or `sso_start_url`). */
  readonly ssoConfigured: boolean
  /** `~/.aws/credentials` holds a static key section for this profile. */
  readonly staticKeys: boolean
}

type IniSections = Readonly<Record<string, Readonly<Record<string, string | undefined>> | undefined>>

/** Classify a profile from already-parsed shared config files. Pure; exported for tests. */
export const profileSourcesOf = (
  profile: string,
  files: { readonly configFile: IniSections; readonly credentialsFile: IniSections }
): ProfileSources => {
  const config = files.configFile[profile]
  const credentials = files.credentialsFile[profile]
  return {
    profile,
    ssoConfigured: config?.["sso_session"] !== undefined || config?.["sso_start_url"] !== undefined,
    staticKeys: credentials?.["aws_access_key_id"] !== undefined
  }
}

/** Read the shared AWS files and classify one profile. */
export const describeProfileSources = async (profile: string): Promise<ProfileSources> =>
  profileSourcesOf(profile, await loadSharedConfigFiles())

/** Static keys shadow SSO: the standard chain would pick the static section over the SSO login. */
export const staticKeysShadowSso = (sources: ProfileSources): boolean => sources.ssoConfigured && sources.staticKeys
