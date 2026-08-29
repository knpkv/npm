import { chain } from "@smithy/core/config"

interface CredentialIdentity {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly expiration?: Date
}

type Provider = () => Promise<CredentialIdentity>
type ProviderFactory = (options?: { readonly profile?: string }) => Provider

interface ProfileCredentialProviders {
  readonly sso: ProviderFactory
  readonly fallback: ProviderFactory
}

/** Prefer an explicitly configured SSO profile without masking SSO failures. */
export const makeProfileCredentialProvider =
  ({ fallback, sso }: ProfileCredentialProviders) => async (profile: string): Promise<CredentialIdentity> => {
    const options = profile === "default" ? {} : { profile }
    return chain(sso(options), fallback(options))()
  }
