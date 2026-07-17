/**
 * Direct AWS CodePipeline read boundary.
 *
 * The live implementation owns credential acquisition and distilled-aws
 * runtime provision. Every response remains `unknown` until the read client
 * applies repository-owned Schema contracts.
 *
 * @internal
 */
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import * as codepipeline from "distilled-aws/codepipeline"
import * as DistilledCredentials from "distilled-aws/Credentials"
import * as DistilledRegion from "distilled-aws/Region"
import * as sts from "distilled-aws/sts"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"

import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure
} from "../failures.js"

const RETRY_DELAY_SECONDS = 30

/** Secret-free AWS coordinates shared by every provider request. @internal */
export interface CodePipelineAwsAccount {
  readonly profile: string
  readonly region: string
  readonly operationTimeoutMillis: number
}

/** Request for a single configured pipeline. @internal */
export interface GetPipelineProviderRequest {
  readonly account: CodePipelineAwsAccount
  readonly pipelineName: string
}

/** Request for one bounded pipeline-execution page. @internal */
export interface ListPipelineExecutionsProviderRequest extends GetPipelineProviderRequest {
  readonly maximumResults: number
  readonly nextToken: string | null
}

/** Request for one pipeline execution. @internal */
export interface GetPipelineExecutionProviderRequest extends GetPipelineProviderRequest {
  readonly pipelineExecutionId: string
}

/** Request for one bounded action-execution page. @internal */
export interface ListActionExecutionsProviderRequest extends GetPipelineExecutionProviderRequest {
  readonly maximumResults: number
  readonly nextToken: string | null
}

/** A provider object requested by the adapter does not exist. @internal */
export class CodePipelineProviderNotFoundFailure extends Schema.TaggedErrorClass<CodePipelineProviderNotFoundFailure>()(
  "CodePipelineProviderNotFoundFailure",
  { operation: Schema.String }
) {}

/** Failures visible to the Schema-decoding read client. @internal */
export type CodePipelineProviderFailure = PluginFailure | CodePipelineProviderNotFoundFailure

/** Raw provider surface used by the CodePipeline read client. @internal */
export interface CodePipelineReadProviderService {
  readonly getCallerIdentity: (
    account: CodePipelineAwsAccount
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly getPipeline: (
    request: GetPipelineProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly listPipelineExecutionsPage: (
    request: ListPipelineExecutionsProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly getPipelineExecution: (
    request: GetPipelineExecutionProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly listActionExecutionsPage: (
    request: ListActionExecutionsProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
}

/** Injectable raw CodePipeline provider. @internal */
export class CodePipelineReadProvider extends Context.Service<
  CodePipelineReadProvider,
  CodePipelineReadProviderService
>()("@knpkv/control-center/CodePipelineReadProvider") {}

const AwsCredentialIdentity = Schema.Struct({
  accessKeyId: Schema.String.check(Schema.isNonEmpty()),
  secretAccessKey: Schema.String.check(Schema.isNonEmpty()),
  sessionToken: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty()))
})

const hasTag = (cause: unknown, tags: ReadonlyArray<string>): boolean =>
  tags.some((tag) => Predicate.isTagged(cause, tag))

/** Map provider failures without exposing raw AWS causes. @internal */
export const mapCodePipelineAwsFailure = Effect.fn("CodePipelineReadProvider.mapAwsFailure")(function*(
  operation: string,
  cause: unknown
): Effect.fn.Return<never, CodePipelineProviderFailure> {
  if (hasTag(cause, ["PipelineNotFoundException", "PipelineExecutionNotFoundException"])) {
    return yield* new CodePipelineProviderNotFoundFailure({ operation })
  }
  if (
    hasTag(cause, [
      "CredentialsProviderError",
      "ExpiredTokenException",
      "InvalidClientTokenId",
      "InvalidSignatureException",
      "UnrecognizedClientException"
    ])
  ) {
    return yield* new PluginAuthenticationFailure({ operation })
  }
  if (hasTag(cause, ["AccessDeniedException", "UnauthorizedException"])) {
    return yield* new PluginAuthorizationFailure({ operation })
  }
  if (hasTag(cause, ["ThrottlingException", "TooManyRequestsException", "RequestLimitExceeded"])) {
    const retryAt = DateTime.add(yield* DateTime.now, { seconds: RETRY_DELAY_SECONDS })
    return yield* new PluginRateLimitFailure({ operation, retryAt })
  }
  if (hasTag(cause, ["TimeoutError", "RequestTimeoutException", "RequestExpired"])) {
    return yield* new PluginTimeoutFailure({ operation })
  }
  if (Schema.isSchemaError(cause)) {
    return yield* new PluginMalformedResponseFailure({
      operation,
      diagnosticCode: "codepipeline-distilled-response-invalid"
    })
  }
  return yield* new PluginOutageFailure({ operation })
})

/** Keep the configured shared profile explicit, including `default`. @internal */
export const codePipelineCredentialProviderOptions = (profile: string): { readonly profile: string } => ({ profile })

const acquireCredentials = Effect.fn("CodePipelineReadProvider.acquireCredentials")(function*(
  operation: string,
  account: CodePipelineAwsAccount
): Effect.fn.Return<
  typeof AwsCredentialIdentity.Type,
  PluginAuthenticationFailure | PluginTimeoutFailure
> {
  const raw = yield* Effect.tryPromise({
    try: () => fromNodeProviderChain(codePipelineCredentialProviderOptions(account.profile))(),
    catch: () => new PluginAuthenticationFailure({ operation })
  }).pipe(
    Effect.timeoutOrElse({
      duration: account.operationTimeoutMillis,
      orElse: () => Effect.fail(new PluginTimeoutFailure({ operation }))
    })
  )
  return yield* Schema.decodeUnknownEffect(AwsCredentialIdentity)(raw).pipe(
    Effect.mapError(() => new PluginAuthenticationFailure({ operation }))
  )
})

const callProvider = Effect.fn("CodePipelineReadProvider.callProvider")(function*<Value, Error>(
  operation: string,
  account: CodePipelineAwsAccount,
  effect: Effect.Effect<
    Value,
    Error,
    DistilledCredentials.Credentials | DistilledRegion.Region | HttpClient.HttpClient
  >
): Effect.fn.Return<Value, CodePipelineProviderFailure, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient
  const credentials = yield* acquireCredentials(operation, account)
  return yield* effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        DistilledCredentials.fromCredentials(credentials),
        Layer.succeed(DistilledRegion.Region, account.region),
        Layer.succeed(HttpClient.HttpClient, httpClient)
      )
    ),
    Effect.timeoutOrElse({
      duration: account.operationTimeoutMillis,
      orElse: () => Effect.fail(new PluginTimeoutFailure({ operation }))
    }),
    Effect.catch((cause): Effect.Effect<never, CodePipelineProviderFailure> =>
      Predicate.isTagged(cause, "PluginTimeoutFailure")
        ? Effect.fail(cause)
        : mapCodePipelineAwsFailure(operation, cause)
    )
  )
})

/** Live raw provider backed only by direct distilled-aws CodePipeline and STS operations. @internal */
export const CodePipelineReadProviderLive = Layer.effect(
  CodePipelineReadProvider,
  Effect.gen(function*() {
    const httpClient = yield* HttpClient.HttpClient
    const provideHttp = <Value, Error>(
      effect: Effect.Effect<Value, Error, HttpClient.HttpClient>
    ): Effect.Effect<Value, Error> => Effect.provideService(effect, HttpClient.HttpClient, httpClient)

    return {
      getCallerIdentity: (account) =>
        provideHttp(callProvider("codepipeline-discover-account", account, sts.getCallerIdentity({}))),
      getPipeline: (request) =>
        provideHttp(
          callProvider(
            "codepipeline-get-pipeline",
            request.account,
            codepipeline.getPipeline({ name: request.pipelineName })
          )
        ),
      listPipelineExecutionsPage: (request) =>
        provideHttp(
          callProvider(
            "codepipeline-list-executions",
            request.account,
            codepipeline.listPipelineExecutions({
              pipelineName: request.pipelineName,
              maxResults: request.maximumResults,
              ...(request.nextToken === null ? {} : { nextToken: request.nextToken })
            })
          )
        ),
      getPipelineExecution: (request) =>
        provideHttp(
          callProvider(
            "codepipeline-get-execution",
            request.account,
            codepipeline.getPipelineExecution({
              pipelineName: request.pipelineName,
              pipelineExecutionId: request.pipelineExecutionId
            })
          )
        ),
      listActionExecutionsPage: (request) =>
        provideHttp(
          callProvider(
            "codepipeline-list-actions",
            request.account,
            codepipeline.listActionExecutions({
              pipelineName: request.pipelineName,
              filter: { pipelineExecutionId: request.pipelineExecutionId },
              maxResults: request.maximumResults,
              ...(request.nextToken === null ? {} : { nextToken: request.nextToken })
            })
          )
        )
    } satisfies CodePipelineReadProviderService
  })
)
