import * as AwsClientConfig from "@knpkv/codecommit-core/AwsClientConfig.js"
import { isCredentialInvalidCause } from "@knpkv/codecommit-core/AwsCredentialErrors.js"
import * as CodeCommit from "@knpkv/codecommit-core/ReadClient.js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"

import type {
  AwsResourceDiscoveryRequest,
  AwsResourceDiscoveryResponse,
  AwsServiceResourceDiscovery
} from "../../api/plugins.js"
import {
  ApplicationAwsSignInRequired,
  ApplicationInvalidRequest,
  ApplicationRateLimited,
  ApplicationServiceUnavailable
} from "../api/ApplicationServices.js"
import { CodePipelineReadClient } from "../plugins/codepipeline/CodePipelineReadClient.js"
import type { CodePipelineNamePage } from "../plugins/codepipeline/CodePipelineReadClient.js"
import type { CodePipelineProviderFailure } from "../plugins/codepipeline/CodePipelineReadProvider.js"
import { awsRegionDiscoveryLayer } from "./awsRegionDiscovery.js"

const MAXIMUM_RESOURCE_NAMES = 20
const MAXIMUM_PROVIDER_PAGES = 5
const OPERATION_TIMEOUT_MILLIS = 10_000

interface ResourceCollection {
  readonly names: ReadonlyArray<string>
  readonly truncated: boolean
}

class AwsResourcePaginationFailure extends Schema.TaggedError<AwsResourcePaginationFailure>()(
  "AwsResourcePaginationFailure",
  {}
) {}

type AwsIdentityDiscoveryError =
  | ApplicationAwsSignInRequired
  | ApplicationInvalidRequest
  | ApplicationRateLimited
  | ApplicationServiceUnavailable
type AwsResourceFailureClass = Extract<AwsServiceResourceDiscovery, { readonly _tag: "failed" }>["failureClass"]

/** Testable, credential-free application boundary for explicit AWS discovery. */
export interface AwsResourceDiscoveryService {
  readonly discover: (
    request: AwsResourceDiscoveryRequest
  ) => Effect.Effect<AwsResourceDiscoveryResponse, AwsIdentityDiscoveryError>
}

/** Injectable application service used by owner-only AWS onboarding. */
export class AwsResourceDiscovery extends Context.Service<AwsResourceDiscovery, AwsResourceDiscoveryService>()(
  "@knpkv/control-center/AwsResourceDiscovery"
) {}

const hasAwsTag = (cause: unknown, tags: ReadonlyArray<string>): boolean =>
  tags.some((tag) => Predicate.isTagged(cause, tag))

const isAuthorizationCause = (cause: unknown): boolean =>
  hasAwsTag(cause, ["AccessDenied", "AccessDeniedException", "UnauthorizedException"])

/** AWS names the policy type in an SCP denial: "… with an explicit deny in a service control policy". */
const isServiceControlPolicyDenial = (failure: CodeCommit.CodeCommitReadError | AwsResourcePaginationFailure) =>
  Predicate.isTagged(failure, "AwsApiError") &&
  isAuthorizationCause(failure.cause) &&
  Predicate.hasProperty(failure.cause, "message") &&
  Predicate.isString(failure.cause.message) &&
  failure.cause.message.includes("service control policy")

const isAuthenticationCause = (cause: unknown): boolean =>
  isCredentialInvalidCause(cause) || hasAwsTag(cause, ["CredentialsProviderError"])

const isTimeoutCause = (cause: unknown): boolean =>
  hasAwsTag(cause, ["TimeoutError", "RequestTimeoutException", "RequestExpired"])

const isRateLimitCause = (cause: unknown): boolean =>
  hasAwsTag(cause, [
    "RequestLimitExceeded",
    "SlowDown",
    "Throttling",
    "ThrottlingException",
    "TooManyRequestsException"
  ])

/** Expired or missing credentials ask for a fresh sign-in; a profile that can sign in but isn't allowed stays invalid. */
const mapIdentityFailure = (
  profile: string,
  failure: CodeCommit.CodeCommitReadError
): AwsIdentityDiscoveryError => {
  if (Predicate.isTagged(failure, "AwsCredentialError")) return new ApplicationAwsSignInRequired({ profile })
  if (Predicate.isTagged(failure, "AwsThrottleError")) return new ApplicationRateLimited({ retryAt: null })
  if (Predicate.isTagged(failure, "AwsApiError")) {
    if (isAuthenticationCause(failure.cause)) return new ApplicationAwsSignInRequired({ profile })
    if (isAuthorizationCause(failure.cause)) return new ApplicationInvalidRequest()
    if (isRateLimitCause(failure.cause)) return new ApplicationRateLimited({ retryAt: null })
  }
  return new ApplicationServiceUnavailable({ retryAt: null })
}

const codeCommitFailureClass = (
  failure: CodeCommit.CodeCommitReadError | AwsResourcePaginationFailure
): AwsResourceFailureClass => {
  if (
    Predicate.isTagged(failure, "CodeCommitMalformedResponseError") ||
    Predicate.isTagged(failure, "AwsResourcePaginationFailure")
  ) {
    return "malformed-response"
  }
  if (Predicate.isTagged(failure, "AwsThrottleError")) return "rate-limit"
  if (Predicate.isTagged(failure, "AwsCredentialError")) return "authentication"
  if (Predicate.isTagged(failure, "AwsApiError")) {
    if (isAuthenticationCause(failure.cause)) return "authentication"
    if (isAuthorizationCause(failure.cause)) return "authorization"
    if (isRateLimitCause(failure.cause)) return "rate-limit"
    if (isTimeoutCause(failure.cause)) return "timeout"
  }
  return "unavailable"
}

const codePipelineFailureClass = (
  failure: CodePipelineProviderFailure | AwsResourcePaginationFailure
): AwsResourceFailureClass => {
  switch (failure._tag) {
    case "PluginAuthenticationFailure":
      return "authentication"
    case "PluginAuthorizationFailure":
      return "authorization"
    case "PluginMalformedResponseFailure":
    case "AwsResourcePaginationFailure":
      return "malformed-response"
    case "PluginRateLimitFailure":
      return "rate-limit"
    case "PluginTimeoutFailure":
      return "timeout"
    case "CodePipelineProviderNotFoundFailure":
    case "PluginCancellationFailure":
    case "PluginConfigurationFailure":
    case "PluginConflictFailure":
    case "PluginOutageFailure":
    case "PluginUnknownOutcomeFailure":
    case "PluginUnsupportedCapabilityFailure":
      return "unavailable"
  }
}

const normalizeNames = (names: ReadonlySet<string>): ReadonlyArray<string> =>
  [...names].sort((left, right) => left.localeCompare(right)).slice(0, MAXIMUM_RESOURCE_NAMES)

const collectCodeCommitRepositories = Effect.fn("AwsResourceDiscovery.collectCodeCommitRepositories")(function*(
  client: CodeCommit.CodeCommitReadClientService,
  account: CodeCommit.CodeCommitReadAccount
) {
  const names = new Set<string>()
  const seenTokens = new Set<string>()
  let nextToken: string | null = null
  let pagesRead = 0
  while (pagesRead < MAXIMUM_PROVIDER_PAGES && names.size < MAXIMUM_RESOURCE_NAMES) {
    const page: CodeCommit.CodeCommitRepositoryPage = yield* client.listRepositoriesPage({ account, nextToken })
    for (const name of page.repositoryNames) names.add(name)
    pagesRead += 1
    if (page.nextToken === null) {
      return { names: normalizeNames(names), truncated: names.size > MAXIMUM_RESOURCE_NAMES }
    }
    if (seenTokens.has(page.nextToken)) return yield* new AwsResourcePaginationFailure()
    seenTokens.add(page.nextToken)
    nextToken = page.nextToken
  }
  return { names: normalizeNames(names), truncated: nextToken !== null || names.size > MAXIMUM_RESOURCE_NAMES }
})

const collectCodePipelinePipelines = Effect.fn("AwsResourceDiscovery.collectCodePipelinePipelines")(function*(
  client: CodePipelineReadClient["Service"],
  account: { readonly profile: string; readonly region: string; readonly operationTimeoutMillis: number }
) {
  const names = new Set<string>()
  const seenTokens = new Set<string>()
  let nextToken: string | null = null
  let pagesRead = 0
  while (pagesRead < MAXIMUM_PROVIDER_PAGES && names.size < MAXIMUM_RESOURCE_NAMES) {
    const page: CodePipelineNamePage = yield* client.listPipelinesPage({ account, nextToken })
    for (const name of page.pipelineNames) names.add(name)
    pagesRead += 1
    if (page.nextToken === null) {
      return { names: normalizeNames(names), truncated: names.size > MAXIMUM_RESOURCE_NAMES }
    }
    if (seenTokens.has(page.nextToken)) return yield* new AwsResourcePaginationFailure()
    seenTokens.add(page.nextToken)
    nextToken = page.nextToken
  }
  return { names: normalizeNames(names), truncated: nextToken !== null || names.size > MAXIMUM_RESOURCE_NAMES }
})

/** Report a failed discovery and log only safe provider diagnostics. */
const failed = Effect.fn("AwsResourceDiscovery.failed")(function*(
  profile: string,
  service: "codecommit" | "codepipeline",
  failureClass: AwsResourceFailureClass,
  failure: CodeCommit.CodeCommitReadError | CodePipelineProviderFailure | AwsResourcePaginationFailure
) {
  yield* Effect.logWarning("AWS resource discovery failed").pipe(
    Effect.annotateLogs({
      service,
      profile,
      failureClass,
      failure: failure._tag,
      ...("operation" in failure && { operation: failure.operation }),
      ...("diagnosticCode" in failure && { diagnosticCode: failure.diagnosticCode })
    })
  )
  return { _tag: "failed", failureClass } satisfies AwsServiceResourceDiscovery
})

const available = (collection: ResourceCollection): AwsServiceResourceDiscovery => ({
  _tag: "available",
  names: collection.names,
  truncated: collection.truncated
})

/** Construct AWS discovery over the owning Schema-decoded provider clients. @internal */
export const makeAwsResourceDiscovery = Effect.fn("AwsResourceDiscovery.make")(function*() {
  const codeCommit = yield* CodeCommit.CodeCommitReadClient
  const codePipeline = yield* CodePipelineReadClient
  const discover = Effect.fn("AwsResourceDiscovery.discover")(function*(request: AwsResourceDiscoveryRequest) {
    const account = yield* Schema.decodeUnknownEffect(CodeCommit.CodeCommitReadAccount)(request).pipe(
      Effect.mapError(() => new ApplicationInvalidRequest())
    )
    const identity = yield* codeCommit.discoverAccount(account).pipe(
      Effect.mapError((failure) => mapIdentityFailure(request.profile, failure))
    )
    const pipelineAccount = {
      profile: request.profile,
      region: request.region,
      operationTimeoutMillis: OPERATION_TIMEOUT_MILLIS
    }
    const deniedByPolicy = yield* Ref.make(false)
    const services = yield* Effect.all(
      {
        codeCommit: collectCodeCommitRepositories(codeCommit, account).pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              Ref.set(deniedByPolicy, isServiceControlPolicyDenial(failure)).pipe(
                Effect.andThen(failed(request.profile, "codecommit", codeCommitFailureClass(failure), failure))
              ),
            onSuccess: (collection) => Effect.succeed(available(collection))
          })
        ),
        codePipeline: collectCodePipelinePipelines(codePipeline, pipelineAccount).pipe(
          Effect.matchEffect({
            onFailure: (failure) => failed(request.profile, "codepipeline", codePipelineFailureClass(failure), failure),
            onSuccess: (collection) => Effect.succeed(available(collection))
          })
        )
      },
      { concurrency: "unbounded" }
    )
    // An SCP region allowlist denies every regional service: both lists fail on authorization.
    const regionDenied = (yield* Ref.get(deniedByPolicy)) &&
      services.codePipeline._tag === "failed" &&
      services.codePipeline.failureClass === "authorization"
    const response: AwsResourceDiscoveryResponse = { accountId: identity.accountId, ...services }
    const denied: AwsResourceDiscoveryResponse = { ...response, regionDenied: true }
    return regionDenied ? denied : response
  })
  return AwsResourceDiscovery.of({ discover })
})

const discoveryClients = (
  codeCommitHttpClient?: HttpClient.HttpClient,
  codeCommitAwsConfiguration: Layer.Layer<AwsClientConfig.AwsClientConfig> = AwsClientConfig.layer({
    operationTimeout: "10 seconds",
    maxRetries: 0
  })
) =>
  Layer.merge(
    codeCommitHttpClient === undefined
      ? CodeCommit.CodeCommitReadClient.live.pipe(Layer.provide(codeCommitAwsConfiguration))
      : CodeCommit.CodeCommitReadClient.live.pipe(
        Layer.provide(codeCommitAwsConfiguration),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, codeCommitHttpClient))
      ),
    CodePipelineReadClient.live
  )

/**
 * Production AWS discovery with only CodeCommit identity and repository calls on a dedicated transport.
 * Region discovery reads `account:ListRegions` on that same transport.
 */
export const awsResourceDiscoveryLayerWithCodeCommitHttpClient = (
  codeCommitHttpClient: HttpClient.HttpClient,
  codeCommitAwsConfiguration?: Layer.Layer<AwsClientConfig.AwsClientConfig>
) =>
  Layer.merge(
    Layer.effect(AwsResourceDiscovery, makeAwsResourceDiscovery()).pipe(
      Layer.provide(discoveryClients(codeCommitHttpClient, codeCommitAwsConfiguration))
    ),
    awsRegionDiscoveryLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, codeCommitHttpClient)))
  )

/** Production AWS discovery layer with bounded provider timeouts, and region discovery beside it. */
export const awsResourceDiscoveryLayer = Layer.merge(
  Layer.effect(AwsResourceDiscovery, makeAwsResourceDiscovery()).pipe(Layer.provide(discoveryClients())),
  awsRegionDiscoveryLayer
)
