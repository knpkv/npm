/**
 * Lists the regions a local AWS profile's account has enabled, for the setup form's region select.
 * Read-only: one `account:ListRegions` walk with the profile's own credentials.
 *
 * @module
 */
import { fromIni, fromSSO } from "@aws-sdk/credential-providers"
import * as account from "@distilled.cloud/aws/account"
import * as DistilledCredentials from "@distilled.cloud/aws/Credentials"
import * as DistilledRegion from "@distilled.cloud/aws/Region"
import { credentialInvalidTags, isCredentialInvalidCause } from "@knpkv/codecommit-core/AwsCredentialErrors.js"
import { makeProfileCredentialProvider } from "@knpkv/codecommit-core/AwsProfileCredentials.js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type { AwsRegionDiscoveryResponse } from "../../api/plugins.js"
import { AwsRegionDiscoveryRequest, DiscoveredAwsRegions } from "../../api/plugins.js"
import {
  ApplicationAwsSignInRequired,
  ApplicationInvalidRequest,
  ApplicationRateLimited,
  ApplicationServiceUnavailable
} from "../api/ApplicationServices.js"

/**
 * Why the enabled regions could not be read; never carries the provider's cause. `denied` is the profile
 * lacking `account:ListRegions`, which the API answers as a `denied` result rather than an error.
 */
export class AwsRegionReadFailure extends Schema.TaggedError<AwsRegionReadFailure>()("AwsRegionReadFailure", {
  reason: Schema.Literals(["denied", "sign-in", "throttled", "unavailable"])
}) {}

/** The provider boundary: the enabled region names for one profile, unsorted. */
export class AwsRegionReader extends Context.Service<AwsRegionReader, {
  readonly enabledRegions: (profile: string) => Effect.Effect<ReadonlyArray<string>, AwsRegionReadFailure>
}>()("@knpkv/control-center/AwsRegionReader") {}

/** The application service the API calls. */
export class AwsRegionDiscovery extends Context.Service<AwsRegionDiscovery, {
  readonly regions: (
    profile: string
  ) => Effect.Effect<
    AwsRegionDiscoveryResponse,
    ApplicationAwsSignInRequired | ApplicationInvalidRequest | ApplicationRateLimited | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/AwsRegionDiscovery") {}

const decodeRequest = Schema.decodeUnknownEffect(AwsRegionDiscoveryRequest)
const decodeRegions = Schema.decodeUnknownEffect(DiscoveredAwsRegions)

/**
 * Sort, drop repeats and validate provider region names. A malformed name or a list over the contract's bound
 * is a provider fault, never trimmed to fit. @internal
 */
export const decodeEnabledRegions = (names: ReadonlyArray<string>) =>
  decodeRegions([...new Set(names)].sort((left, right) => left.localeCompare(right))).pipe(
    Effect.mapError(() => new AwsRegionReadFailure({ reason: "unavailable" }))
  )

/** Construct region discovery over an injected reader. @internal */
export const makeAwsRegionDiscovery = Effect.fn("AwsRegionDiscovery.make")(function*() {
  const reader = yield* AwsRegionReader
  const regions = Effect.fn("AwsRegionDiscovery.regions")(function*(profile: string) {
    const request = yield* decodeRequest({ profile }).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
    return yield* reader.enabledRegions(request.profile).pipe(
      Effect.flatMap(decodeEnabledRegions),
      Effect.map((regions): AwsRegionDiscoveryResponse => ({ _tag: "available", regions })),
      Effect.catchTag("AwsRegionReadFailure", (failure) =>
        failure.reason === "denied"
          ? Effect.succeed<AwsRegionDiscoveryResponse>({ _tag: "denied" })
          : Effect.fail(
            failure.reason === "sign-in"
              ? new ApplicationAwsSignInRequired({ profile: request.profile })
              : failure.reason === "throttled"
              ? new ApplicationRateLimited({ retryAt: null })
              : new ApplicationServiceUnavailable({ retryAt: null })
          ))
    )
  })
  return AwsRegionDiscovery.of({ regions })
})

const AwsCredentialIdentity = Schema.Struct({
  accessKeyId: Schema.String.check(Schema.isNonEmpty()),
  secretAccessKey: Schema.String.check(Schema.isNonEmpty()),
  sessionToken: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty()))
})

/** Matches a provider error by `_tag`, `name`, or the `errorTag` of an undeclared (`UnknownAwsError`) one. */
const hasTag = (cause: unknown, tags: ReadonlyArray<string>): boolean =>
  tags.some((tag) =>
    Predicate.isTagged(cause, tag) ||
    (Predicate.hasProperty(cause, "name") && Predicate.isString(cause.name) && cause.name === tag) ||
    (Predicate.hasProperty(cause, "errorTag") && Predicate.isString(cause.errorTag) && cause.errorTag === tag)
  )

/** Map a provider cause to a read failure, dropping the cause itself. @internal */
export const classifyRegionReadCause = (cause: unknown): AwsRegionReadFailure =>
  new AwsRegionReadFailure({
    reason: isCredentialInvalidCause(cause) || hasTag(cause, [...credentialInvalidTags, "CredentialsProviderError"])
      ? "sign-in"
      : hasTag(cause, ["AccessDenied", "AccessDeniedException", "UnauthorizedException"])
      ? "denied"
      : hasTag(cause, ["Throttling", "ThrottlingException", "TooManyRequestsException"])
      ? "throttled"
      : "unavailable"
  })

const resolveProfileCredentials = makeProfileCredentialProvider({ sso: fromSSO, fallback: fromIni })
/**
 * ListRegions is served from the Account API's home region, whatever the profile's region is. This is the
 * commercial partition's; GovCloud and China profiles are not supported and fail as unavailable.
 */
const ACCOUNT_API_REGION = "us-east-1"
const MAXIMUM_PAGES = 5
const OPERATION_TIMEOUT = "10 seconds"

/** Live reader: the profile's credentials, then `account:ListRegions` for enabled regions only. */
export const AwsRegionReaderLive = Layer.effect(
  AwsRegionReader,
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
    const enabledRegions = Effect.fn("AwsRegionReader.enabledRegions")(function*(profile: string) {
      const raw = yield* Effect.tryPromise({
        try: () => resolveProfileCredentials(profile),
        catch: () => new AwsRegionReadFailure({ reason: "sign-in" })
      })
      const credentials = yield* Schema.decodeUnknownEffect(AwsCredentialIdentity)(raw).pipe(
        Effect.mapError(() => new AwsRegionReadFailure({ reason: "sign-in" }))
      )
      const names: Array<string> = []
      let nextToken: string | undefined
      for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
        const enabled = ["ENABLED", "ENABLED_BY_DEFAULT"]
        const request = nextToken === undefined
          ? { RegionOptStatusContains: enabled }
          : { RegionOptStatusContains: enabled, NextToken: nextToken }
        const response = yield* account.listRegions(request).pipe(
          Effect.provideService(
            DistilledCredentials.Credentials,
            Effect.succeed(DistilledCredentials.fromAwsCredentialIdentity(credentials, ACCOUNT_API_REGION))
          ),
          Effect.provideService(DistilledRegion.Region, Effect.succeed(ACCOUNT_API_REGION)),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError(classifyRegionReadCause)
        )
        for (const region of response.Regions ?? []) if (region.RegionName !== undefined) names.push(region.RegionName)
        nextToken = response.NextToken
        if (nextToken === undefined) break
      }
      return names
    }, (effect) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: OPERATION_TIMEOUT,
          orElse: () => Effect.fail(new AwsRegionReadFailure({ reason: "unavailable" }))
        })
      ))
    return AwsRegionReader.of({ enabledRegions })
  })
)

/** Region discovery over the live reader; the caller provides the HTTP client. */
export const awsRegionDiscoveryLayer = Layer.effect(AwsRegionDiscovery, makeAwsRegionDiscovery()).pipe(
  Layer.provide(AwsRegionReaderLive)
)
