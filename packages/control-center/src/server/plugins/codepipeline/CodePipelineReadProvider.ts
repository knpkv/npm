/**
 * Direct AWS CodePipeline read boundary.
 *
 * The live implementation owns credential acquisition and @distilled.cloud/aws
 * runtime provision. Every response remains `unknown` until the read client
 * applies repository-owned Schema contracts.
 *
 * @internal
 */
import { fromNodeProviderChain } from "@aws-sdk/credential-providers"
import * as cloudwatchLogs from "@distilled.cloud/aws/cloudwatch-logs"
import * as codepipeline from "@distilled.cloud/aws/codepipeline"
import * as DistilledCredentials from "@distilled.cloud/aws/Credentials"
import * as DistilledRegion from "@distilled.cloud/aws/Region"
import * as s3 from "@distilled.cloud/aws/s3"
import * as sts from "@distilled.cloud/aws/sts"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as HttpClient from "effect/unstable/http/HttpClient"

import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure
} from "../failures.js"

const RETRY_DELAY_SECONDS = 30

interface ArtifactBodyCollection {
  readonly chunks: Array<Uint8Array>
  readonly total: number
}

/** Plan a satisfiable S3 byte range or the canonical exhausted-range response. @internal */
export const planCodePipelineArtifactRange = (
  offset: number,
  length: number,
  totalBytes: number
):
  | { readonly _tag: "exhausted"; readonly contentRange: string }
  | { readonly _tag: "bounded"; readonly range: string } =>
  offset >= totalBytes
    ? { _tag: "exhausted", contentRange: `bytes */${totalBytes}` }
    : {
      _tag: "bounded",
      range: `bytes=${offset}-${Math.min(offset + length - 1, totalBytes - 1)}`
    }

/** Collect one provider body while stopping consumption at the authorized range bound. @internal */
export const collectBoundedArtifactBody = Effect.fn("CodePipelineReadProvider.collectBoundedArtifactBody")(
  function*<Error>(body: Stream.Stream<Uint8Array, Error>, maximumBytes: number): Effect.fn.Return<
    Uint8Array,
    Error | PluginMalformedResponseFailure
  > {
    const collected = yield* Stream.runFoldEffect(
      body,
      (): ArtifactBodyCollection => ({ chunks: [], total: 0 }),
      (state, chunk) => {
        const total = state.total + chunk.byteLength
        return total > maximumBytes
          ? Effect.fail(
            new PluginMalformedResponseFailure({
              operation: "codepipeline-get-artifact",
              diagnosticCode: "codepipeline-artifact-range-exceeded"
            })
          )
          : Effect.succeed({ chunks: [...state.chunks, chunk], total })
      }
    )
    const bytes = new Uint8Array(collected.total)
    let offset = 0
    for (const chunk of collected.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }
)

/** Bound both artifact body size and the time spent draining the provider stream. @internal */
export const collectBoundedArtifactBodyWithin = Effect.fn(
  "CodePipelineReadProvider.collectBoundedArtifactBodyWithin"
)(function*<Error>(
  body: Stream.Stream<Uint8Array, Error>,
  maximumBytes: number,
  timeoutMillis: number
): Effect.fn.Return<
  Uint8Array,
  Error | PluginMalformedResponseFailure | PluginTimeoutFailure
> {
  return yield* collectBoundedArtifactBody(body, maximumBytes).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () => Effect.fail(new PluginTimeoutFailure({ operation: "codepipeline-get-artifact" }))
    })
  )
})

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

/** Request for one bounded page of pipelines in an account and region. @internal */
export interface ListPipelinesProviderRequest {
  readonly account: CodePipelineAwsAccount
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

/** Request for current stage and action state. @internal */
export interface GetPipelineStateProviderRequest extends GetPipelineProviderRequest {}

/** Request for one bounded CloudWatch log page. Provider coordinates never leave this boundary. @internal */
export interface GetPipelineLogEventsProviderRequest {
  readonly account: CodePipelineAwsAccount
  readonly logGroupName: string
  readonly logStreamName: string
  readonly nextToken: string | null
  readonly limit: number
}

/** Request for one bounded S3 artifact range. Provider coordinates never leave this boundary. @internal */
export interface GetPipelineArtifactRangeProviderRequest {
  readonly account: CodePipelineAwsAccount
  readonly bucket: string
  readonly key: string
  readonly offset: number
  readonly length: number
}

/** Explicit source revision for a new, independently tracked execution. @internal */
export interface CodePipelineSourceRevisionOverride {
  readonly actionName: string
  readonly revisionType: "COMMIT_ID" | "IMAGE_DIGEST" | "S3_OBJECT_VERSION_ID" | "S3_OBJECT_KEY"
  readonly revisionValue: string
}

/** Idempotent request to start a distinct pipeline execution. @internal */
export interface StartPipelineExecutionProviderRequest extends GetPipelineProviderRequest {
  readonly clientRequestToken: string
  readonly sourceRevisions: ReadonlyArray<CodePipelineSourceRevisionOverride>
}

/** Request to stop one exact pipeline execution. @internal */
export interface StopPipelineExecutionProviderRequest extends GetPipelineExecutionProviderRequest {
  readonly abandon: boolean
  readonly reason: string
}

/** Request to resolve one exact pending manual approval. @internal */
export interface PutPipelineApprovalProviderRequest extends GetPipelineProviderRequest {
  readonly stageName: string
  readonly actionName: string
  readonly token: string
  readonly status: "Approved" | "Rejected"
  readonly summary: string
}

/** A provider object requested by the adapter does not exist. @internal */
export class CodePipelineProviderNotFoundFailure extends Schema.TaggedErrorClass<CodePipelineProviderNotFoundFailure>()(
  "CodePipelineProviderNotFoundFailure",
  { operation: Schema.String }
) {}

/** Credential acquisition timed out before a mutation could reach AWS. @internal */
export class CodePipelinePreDispatchTimeoutFailure
  extends Schema.TaggedErrorClass<CodePipelinePreDispatchTimeoutFailure>()(
    "CodePipelinePreDispatchTimeoutFailure",
    { operation: Schema.String }
  )
{}

/** Failures visible to the Schema-decoding read client. @internal */
export type CodePipelineProviderFailure =
  | PluginFailure
  | CodePipelineProviderNotFoundFailure

/** Failures visible only while invoking a provider mutation. @internal */
export type CodePipelineMutationProviderFailure =
  | CodePipelineProviderFailure
  | CodePipelinePreDispatchTimeoutFailure

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
  readonly listPipelinesPage: (
    request: ListPipelinesProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly getPipelineExecution: (
    request: GetPipelineExecutionProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly listActionExecutionsPage: (
    request: ListActionExecutionsProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly getPipelineState: (
    request: GetPipelineStateProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly getLogEventsPage: (
    request: GetPipelineLogEventsProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly getArtifactRange: (
    request: GetPipelineArtifactRangeProviderRequest
  ) => Effect.Effect<unknown, CodePipelineProviderFailure>
  readonly startPipelineExecution: (
    request: StartPipelineExecutionProviderRequest
  ) => Effect.Effect<unknown, CodePipelineMutationProviderFailure>
  readonly stopPipelineExecution: (
    request: StopPipelineExecutionProviderRequest
  ) => Effect.Effect<unknown, CodePipelineMutationProviderFailure>
  readonly putApprovalResult: (
    request: PutPipelineApprovalProviderRequest
  ) => Effect.Effect<unknown, CodePipelineMutationProviderFailure>
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

const deterministicMutationRejectionTags: Readonly<Record<string, ReadonlyArray<string>>> = {
  "codepipeline-start-execution": ["ValidationException"],
  "codepipeline-stop-execution": ["PipelineExecutionNotStoppableException", "ValidationException"],
  "codepipeline-put-approval": ["ValidationException"]
}

/** Map provider failures without exposing raw AWS causes. @internal */
export const mapCodePipelineAwsFailure = Effect.fn("CodePipelineReadProvider.mapAwsFailure")(function*(
  operation: string,
  cause: unknown
): Effect.fn.Return<never, CodePipelineProviderFailure> {
  if (
    hasTag(cause, [
      "PipelineNotFoundException",
      "PipelineExecutionNotFoundException",
      "ResourceNotFoundException",
      "NoSuchKey",
      "NotFound"
    ])
  ) {
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
  if (hasTag(cause, ["AccessDenied", "AccessDeniedException", "UnauthorizedException"])) {
    return yield* new PluginAuthorizationFailure({ operation })
  }
  if (
    hasTag(cause, [
      "ActionNotFoundException",
      "ApprovalAlreadyCompletedException",
      "ConcurrentPipelineExecutionsLimitExceededException",
      "ConflictException",
      "InvalidApprovalTokenException",
      "StageNotFoundException"
    ]) ||
    hasTag(cause, deterministicMutationRejectionTags[operation] ?? [])
  ) {
    return yield* new PluginConflictFailure({
      operation,
      diagnosticCode: "codepipeline-provider-state-conflict"
    })
  }
  if (hasTag(cause, ["SlowDown", "ThrottlingException", "TooManyRequestsException", "RequestLimitExceeded"])) {
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

/** Use the standard AWS provider chain for `default`; select named shared profiles explicitly. @internal */
export const codePipelineCredentialProviderOptions = (
  profile: string
): { readonly profile?: string } => profile === "default" ? {} : { profile }

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
        Layer.succeed(DistilledRegion.Region, Effect.succeed(account.region)),
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

const callMutationProvider = Effect.fn("CodePipelineReadProvider.callMutationProvider")(function*<Value, Error>(
  operation: string,
  account: CodePipelineAwsAccount,
  effect: Effect.Effect<
    Value,
    Error,
    DistilledCredentials.Credentials | DistilledRegion.Region | HttpClient.HttpClient
  >
): Effect.fn.Return<Value, CodePipelineMutationProviderFailure, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient
  const credentials = yield* acquireCredentials(operation, account).pipe(
    Effect.catchTag(
      "PluginTimeoutFailure",
      () => Effect.fail(new CodePipelinePreDispatchTimeoutFailure({ operation }))
    )
  )
  return yield* effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        DistilledCredentials.fromCredentials(credentials),
        Layer.succeed(DistilledRegion.Region, Effect.succeed(account.region)),
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

/** Live raw provider backed only by direct @distilled.cloud/aws CodePipeline and STS operations. @internal */
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
      listPipelinesPage: (request) =>
        provideHttp(
          callProvider(
            "codepipeline-list-pipelines",
            request.account,
            codepipeline.listPipelines({
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
        ),
      getPipelineState: (request) =>
        provideHttp(
          callProvider(
            "codepipeline-get-state",
            request.account,
            codepipeline.getPipelineState({ name: request.pipelineName })
          )
        ),
      getLogEventsPage: (request) =>
        provideHttp(
          callProvider(
            "codepipeline-get-logs",
            request.account,
            cloudwatchLogs.getLogEvents({
              logGroupName: request.logGroupName,
              logStreamName: request.logStreamName,
              limit: request.limit,
              startFromHead: true,
              unmask: false,
              ...(request.nextToken === null ? {} : { nextToken: request.nextToken })
            })
          )
        ),
      getArtifactRange: (request) =>
        provideHttp(Effect.gen(function*() {
          const metadata = yield* callProvider(
            "codepipeline-head-artifact",
            request.account,
            s3.headObject({
              Bucket: request.bucket,
              Key: request.key
            })
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({
              ContentLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
            }))),
            Effect.mapError((failure) =>
              Schema.isSchemaError(failure)
                ? new PluginMalformedResponseFailure({
                  operation: "codepipeline-head-artifact",
                  diagnosticCode: "codepipeline-artifact-size-invalid"
                })
                : failure
            )
          )
          const plan = planCodePipelineArtifactRange(
            request.offset,
            request.length,
            metadata.ContentLength
          )
          if (plan._tag === "exhausted") {
            return {
              bytes: new Uint8Array(),
              contentLength: 0,
              contentRange: plan.contentRange
            }
          }
          const response = yield* callProvider(
            "codepipeline-get-artifact",
            request.account,
            s3.getObject({
              Bucket: request.bucket,
              Key: request.key,
              Range: plan.range
            })
          )
          return yield* response.Body === undefined
            ? Effect.succeed({
              bytes: new Uint8Array(),
              contentLength: response.ContentLength,
              contentRange: response.ContentRange
            })
            : collectBoundedArtifactBodyWithin(
              response.Body.pipe(
                Stream.mapError(() => new PluginOutageFailure({ operation: "codepipeline-get-artifact" }))
              ),
              request.length,
              request.account.operationTimeoutMillis
            ).pipe(
              Effect.map((bytes) => ({
                bytes,
                contentLength: response.ContentLength,
                contentRange: response.ContentRange
              }))
            )
        })),
      startPipelineExecution: (request) =>
        provideHttp(
          callMutationProvider(
            "codepipeline-start-execution",
            request.account,
            codepipeline.startPipelineExecution({
              name: request.pipelineName,
              clientRequestToken: request.clientRequestToken,
              sourceRevisions: [...request.sourceRevisions]
            })
          )
        ),
      stopPipelineExecution: (request) =>
        provideHttp(
          callMutationProvider(
            "codepipeline-stop-execution",
            request.account,
            codepipeline.stopPipelineExecution({
              pipelineName: request.pipelineName,
              pipelineExecutionId: request.pipelineExecutionId,
              abandon: request.abandon,
              reason: request.reason
            })
          )
        ),
      putApprovalResult: (request) =>
        provideHttp(
          callMutationProvider(
            "codepipeline-put-approval",
            request.account,
            codepipeline.putApprovalResult({
              pipelineName: request.pipelineName,
              stageName: request.stageName,
              actionName: request.actionName,
              token: request.token,
              result: { status: request.status, summary: request.summary }
            })
          )
        )
    } satisfies CodePipelineReadProviderService
  })
)
