import * as AwsClientConfig from "@knpkv/codecommit-core/AwsClientConfig.js"
import * as CodeCommit from "@knpkv/codecommit-core/ReadClient.js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"

import type {
  AwsResourceDiscoveryRequest,
  AwsResourceDiscoveryResponse,
  AwsServiceResourceDiscovery
} from "../../api/plugins.js"
import {
  ApplicationInvalidRequest,
  ApplicationRateLimited,
  ApplicationServiceUnavailable
} from "../api/ApplicationServices.js"
import { CodePipelineReadClient } from "../plugins/codepipeline/CodePipelineReadClient.js"
import type { CodePipelineNamePage } from "../plugins/codepipeline/CodePipelineReadClient.js"
import type { CodePipelineProviderFailure } from "../plugins/codepipeline/CodePipelineReadProvider.js"

const MAXIMUM_RESOURCE_NAMES = 20
const MAXIMUM_PROVIDER_PAGES = 5
const OPERATION_TIMEOUT_MILLIS = 10_000

interface ResourceCollection {
  readonly names: ReadonlyArray<string>
  readonly truncated: boolean
}

class AwsResourcePaginationFailure extends Schema.TaggedErrorClass<AwsResourcePaginationFailure>()(
  "AwsResourcePaginationFailure",
  {}
) {}

type AwsIdentityDiscoveryError = ApplicationInvalidRequest | ApplicationRateLimited | ApplicationServiceUnavailable
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

const isAuthenticationCause = (cause: unknown): boolean =>
  hasAwsTag(cause, [
    "CredentialsProviderError",
    "ExpiredTokenException",
    "InvalidClientTokenId",
    "InvalidSignatureException",
    "UnrecognizedClientException"
  ])

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

const mapIdentityFailure = (failure: CodeCommit.CodeCommitReadError): AwsIdentityDiscoveryError => {
  if (Predicate.isTagged(failure, "AwsCredentialError")) return new ApplicationInvalidRequest()
  if (Predicate.isTagged(failure, "AwsThrottleError")) return new ApplicationRateLimited({ retryAt: null })
  if (Predicate.isTagged(failure, "AwsApiError")) {
    if (isAuthenticationCause(failure.cause) || isAuthorizationCause(failure.cause)) {
      return new ApplicationInvalidRequest()
    }
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
  if (Predicate.isTagged(failure, "AwsApiError")) {
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
    case "PluginAuthenticationFailure":
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
    const identity = yield* codeCommit.discoverAccount(account).pipe(Effect.mapError(mapIdentityFailure))
    const pipelineAccount = {
      profile: request.profile,
      region: request.region,
      operationTimeoutMillis: OPERATION_TIMEOUT_MILLIS
    }
    const services = yield* Effect.all(
      {
        codeCommit: collectCodeCommitRepositories(codeCommit, account).pipe(
          Effect.match({
            onFailure: (failure): AwsServiceResourceDiscovery => ({
              _tag: "failed",
              failureClass: codeCommitFailureClass(failure)
            }),
            onSuccess: available
          })
        ),
        codePipeline: collectCodePipelinePipelines(codePipeline, pipelineAccount).pipe(
          Effect.match({
            onFailure: (failure): AwsServiceResourceDiscovery => ({
              _tag: "failed",
              failureClass: codePipelineFailureClass(failure)
            }),
            onSuccess: available
          })
        )
      },
      { concurrency: "unbounded" }
    )
    return { accountId: identity.accountId, ...services }
  })
  return AwsResourceDiscovery.of({ discover })
})

const codeCommitDiscoveryClient = CodeCommit.CodeCommitReadClient.live.pipe(
  Layer.provide(AwsClientConfig.layer({ operationTimeout: "10 seconds", maxRetries: 0 }))
)
const discoveryClients = Layer.merge(codeCommitDiscoveryClient, CodePipelineReadClient.live)

/** Production AWS discovery layer with bounded provider timeouts. */
export const awsResourceDiscoveryLayer = Layer.effect(AwsResourceDiscovery, makeAwsResourceDiscovery()).pipe(
  Layer.provide(discoveryClients)
)
