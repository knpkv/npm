import { fromSSO, type FromSSOInit, type SsoCredentialsParameters } from "@aws-sdk/credential-provider-sso"
import type { ResolvedCredentials } from "@distilled.cloud/aws/Credentials"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import type { SsoProfile } from "./profiles.js"
import { S3ReadError } from "./s3-reader.js"

const CredentialIdentity = Schema.Struct({
  accessKeyId: Schema.NonEmptyString,
  secretAccessKey: Schema.NonEmptyString,
  sessionToken: Schema.NonEmptyString
})

/** Credential-bearing service; results go only to server-side signing and never to persistence, HTTP or logs. */
export class SsoCredentials extends Context.Service<SsoCredentials, {
  readonly resolve: (profile: SsoProfile) => Effect.Effect<ResolvedCredentials, S3ReadError>
}>()("@knpkv/alchemy-console/SsoCredentials") {}

/** SDK factory returns credential-bearing material; inject it at this signing boundary for tests. */
export type SsoCredentialProviderFactory = typeof fromSSO

/** Use only an explicit SSO provider; never a default credential chain. */
export const ssoCredentialsLayer = (provider: SsoCredentialProviderFactory = fromSSO) =>
  Layer.succeed(SsoCredentials, {
    resolve: Effect.fn("AlchemyConsole.resolveSsoCredentials")(function*(profile: SsoProfile) {
      const request: FromSSOInit & SsoCredentialsParameters = {
        profile: profile.name,
        configFilepath: profile.configFile,
        ssoAccountId: profile.account,
        ssoRoleName: profile.role,
        ssoRegion: profile.ssoRegion,
        ssoStartUrl: profile.startUrl,
        clientConfig: { region: profile.ssoRegion },
        ignoreCache: true
      }
      if (profile.session !== null) request.ssoSession = profile.session
      const raw = yield* Effect.tryPromise({
        try: () => provider(request)(),
        catch: () => new S3ReadError({ reason: "authentication" })
      }).pipe(Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new S3ReadError({ reason: "authentication" }))
      }))
      const identity = yield* Schema.decodeUnknownEffect(CredentialIdentity)(raw).pipe(
        Effect.mapError(() => new S3ReadError({ reason: "authentication" }))
      )
      return {
        accessKeyId: Redacted.make(identity.accessKeyId),
        secretAccessKey: Redacted.make(identity.secretAccessKey),
        sessionToken: Redacted.make(identity.sessionToken),
        region: profile.region
      }
    })
  })
