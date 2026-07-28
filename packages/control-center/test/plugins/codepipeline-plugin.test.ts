import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import {
  AuthorizedPluginActionV1,
  PluginPipelineArtifactRangeRequestV1,
  PluginPipelineLogPageRequestV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1,
  ReadPluginEntityRequestV1
} from "../../src/domain/plugins/index.js"
import {
  CodePipelinePluginConfiguration,
  codePipelinePluginDefinition
} from "../../src/server/plugins/codepipeline/CodePipelinePluginDefinition.js"
import { CodePipelineReadClient } from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import {
  codePipelineCredentialProviderOptions,
  CodePipelineReadProvider,
  type CodePipelineReadProviderService,
  collectBoundedArtifactBody,
  mapCodePipelineAwsFailure
} from "../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"
import {
  PluginAuthenticationFailure,
  PluginConfigurationFailure,
  PluginConflictFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginTimeoutFailure,
  PluginUnknownOutcomeFailure
} from "../../src/server/plugins/failures.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { buildPluginDefinitionLayer } from "../../src/server/plugins/PluginDefinition.js"

const configuration = {
  profile: "production",
  region: "eu-west-1",
  pipelineName: "release",
  maximumExecutionPages: 2,
  actionPageSize: 1,
  maximumActionPages: 2,
  maximumActionsPerExecution: 2,
  maximumLogBytes: 32_768,
  operationTimeoutMillis: 10_000
}

const pipelineOutput = {
  pipeline: {
    name: "release",
    version: 7,
    pipelineType: "V2",
    executionMode: "SUPERSEDED",
    stages: [
      {
        name: "Source",
        actions: [
          {
            name: "Checkout",
            actionTypeId: {
              category: "Source",
              owner: "AWS",
              provider: "CodeCommit",
              version: "1"
            },
            outputArtifacts: [{ name: "Source" }]
          }
        ]
      },
      {
        name: "Build",
        actions: [
          {
            name: "Compile",
            actionTypeId: {
              category: "Build",
              owner: "AWS",
              provider: "CodeBuild",
              version: "1"
            },
            runOrder: 1,
            region: "eu-west-1",
            roleArn: "arn:aws:iam::123456789012:role/codepipeline-build",
            inputArtifacts: [{ name: "Source" }],
            outputArtifacts: [{ name: "BuildOutput" }]
          }
        ]
      }
    ]
  },
  metadata: {
    pipelineArn: "arn:aws:codepipeline:eu-west-1:123456789012:release",
    created: new Date("2026-07-15T08:00:00.000Z"),
    updated: new Date("2026-07-16T08:00:00.000Z")
  }
}

const executionSummary = (executionId: string, status: string) => ({
  pipelineExecutionId: executionId,
  status,
  statusSummary: `${status} summary`,
  startTime: new Date("2026-07-16T09:00:00.000Z"),
  lastUpdateTime: new Date("2026-07-16T09:05:00.000Z"),
  sourceRevisions: [{ actionName: "Source", revisionId: "commit-abc", revisionSummary: "main" }],
  trigger: { triggerType: "StartPipelineExecution", triggerDetail: "release-operator" },
  executionMode: "SUPERSEDED",
  executionType: "STANDARD"
})

const executionOutput = (executionId: string, status: string) => ({
  pipelineExecution: {
    pipelineName: "release",
    pipelineVersion: 7,
    pipelineExecutionId: executionId,
    status,
    statusSummary: `${status} summary`,
    lastUpdateTime: new Date("2026-07-16T09:05:00.000Z"),
    artifactRevisions: [{
      name: "Source",
      revisionId: "commit-abc",
      revisionSummary: "main",
      revisionUrl: "https://credential-bearing.example.invalid/source?token=secret",
      created: new Date("2026-07-16T08:59:00.000Z")
    }],
    trigger: { triggerType: "StartPipelineExecution", triggerDetail: "release-operator" },
    executionMode: "SUPERSEDED",
    executionType: "STANDARD"
  }
})

const actionOutput = (
  executionId: string,
  actionExecutionId: string,
  actionName: string,
  status: string,
  nextToken?: string
) => ({
  actionExecutionDetails: [{
    pipelineExecutionId: executionId,
    actionExecutionId,
    pipelineVersion: 7,
    stageName: "Build",
    actionName,
    startTime: new Date("2026-07-16T09:01:00.000Z"),
    lastUpdateTime: new Date("2026-07-16T09:04:00.000Z"),
    updatedBy: "arn:aws:sts::123456789012:assumed-role/Release/operator",
    status,
    input: {
      actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild", version: "1" },
      roleArn: "arn:aws:iam::123456789012:role/codepipeline-build",
      region: "eu-west-1",
      inputArtifacts: [{ name: "Source", s3location: { bucket: "artifacts", key: "source.zip" } }],
      resolvedConfiguration: { EnvironmentVariables: "SECRET=must-not-leak" }
    },
    output: {
      outputArtifacts: [{ name: "BuildOutput", s3location: { bucket: "artifacts", key: "build.zip" } }],
      executionResult: {
        externalExecutionId: `build-${actionExecutionId}`,
        externalExecutionSummary: "Build completed",
        externalExecutionUrl: "https://credential-bearing.example.invalid/build?token=secret",
        logStreamARN: "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/codebuild/release:log-stream:build"
      }
    }
  }],
  ...(nextToken === undefined ? {} : { nextToken })
})

const baseProvider = (
  overrides: Partial<CodePipelineReadProviderService> = {}
): CodePipelineReadProviderService => ({
  getCallerIdentity: () => Effect.succeed({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test" }),
  getPipeline: () => Effect.succeed(pipelineOutput),
  listPipelineExecutionsPage: (request) =>
    Effect.succeed({
      pipelineExecutionSummaries: [
        executionSummary(request.nextToken === null ? "execution-1842" : "execution-1843", "Succeeded")
      ],
      ...(request.nextToken === null ? { nextToken: "execution-page-2" } : {})
    }),
  listPipelinesPage: () => Effect.succeed({ pipelines: [] }),
  getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "Succeeded")),
  listActionExecutionsPage: (request) =>
    Effect.succeed(
      request.nextToken === null
        ? actionOutput(
          request.pipelineExecutionId,
          `${request.pipelineExecutionId}-action-1`,
          "Compile",
          "Succeeded",
          "action-page-2"
        )
        : actionOutput(request.pipelineExecutionId, `${request.pipelineExecutionId}-action-2`, "Package", "Succeeded")
    ),
  getPipelineState: () =>
    Effect.succeed({
      pipelineName: "release",
      pipelineVersion: 7,
      stageStates: []
    }),
  getLogEventsPage: () => Effect.succeed({ events: [] }),
  getArtifactRange: () =>
    Effect.succeed({
      bytes: new Uint8Array(),
      contentLength: 0,
      contentRange: "bytes 0-0/0"
    }),
  startPipelineExecution: () => Effect.succeed({ pipelineExecutionId: "execution-started" }),
  stopPipelineExecution: (request) => Effect.succeed({ pipelineExecutionId: request.pipelineExecutionId }),
  putApprovalResult: () => Effect.succeed({ approvedAt: new Date("2026-07-16T09:10:00.000Z") }),
  ...overrides
})

const runWithProvider = <Value, Error>(
  provider: CodePipelineReadProviderService,
  effect: Effect.Effect<Value, Error, PluginConnection | AuthorizedPluginExecutor>,
  adapterConfiguration: unknown = configuration
) =>
  effect.pipe(
    Effect.provide(
      buildPluginDefinitionLayer(codePipelinePluginDefinition, adapterConfiguration).pipe(
        Layer.provide(
          CodePipelineReadClient.layer.pipe(
            Layer.provide(Layer.succeed(CodePipelineReadProvider, provider))
          )
        ),
        Layer.provide(NodeCrypto.layer)
      )
    ),
    Effect.scoped
  )

describe("CodePipelinePlugin", () => {
  it.effect("stops consuming an artifact body as soon as the authorized byte bound is exceeded", () =>
    Effect.gen(function*() {
      const consumed = yield* Ref.make(0)
      const chunk = (bytes: ReadonlyArray<number>) =>
        Ref.update(consumed, (count) => count + 1).pipe(
          Effect.as(Uint8Array.from(bytes)),
          Stream.fromEffect
        )
      const oversized = Stream.concat(
        chunk([1, 2]),
        Stream.concat(chunk([3]), chunk([4]))
      )
      const rejected = yield* collectBoundedArtifactBody(oversized, 2).pipe(Effect.result)

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.instanceOf(rejected.failure, PluginMalformedResponseFailure)
      }
      assert.strictEqual(yield* Ref.get(consumed), 2)

      const accepted = yield* collectBoundedArtifactBody(
        Stream.concat(chunk([5]), chunk([6])),
        2
      )
      assert.deepStrictEqual(Array.from(accepted), [5, 6])
    }))

  it.effect("rejects an S3 response whose Content-Range does not match the requested offset", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const request = {
        account: {
          profile: configuration.profile,
          region: configuration.region,
          operationTimeoutMillis: configuration.operationTimeoutMillis
        },
        pipelineName: configuration.pipelineName,
        bucket: "private-artifacts",
        key: "release.zip",
        offset: 5,
        length: 3
      }
      const rejected = yield* client.getArtifactRange(request).pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.instanceOf(rejected.failure, PluginMalformedResponseFailure)
      }
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(Layer.succeed(
            CodePipelineReadProvider,
            baseProvider({
              getArtifactRange: () =>
                Effect.succeed({
                  bytes: Uint8Array.from([1, 2, 3]),
                  contentLength: 3,
                  contentRange: "bytes 0-2/9"
                })
            })
          ))
        )
      )
    ))

  it.effect("decodes a bounded pipeline discovery page", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const page = yield* client.listPipelinesPage({
        account: { profile: "production", region: "eu-west-1", operationTimeoutMillis: 10_000 },
        nextToken: null
      })
      assert.deepStrictEqual(page.pipelineNames, ["payments-production", "risk-production"])
      assert.strictEqual(page.nextToken, "pipelines-page-2")
      assert.strictEqual(page.providerPageLimit, 100)
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(Layer.succeed(
            CodePipelineReadProvider,
            baseProvider({
              listPipelinesPage: () =>
                Effect.succeed({
                  pipelines: [{ name: "payments-production" }, { name: "risk-production" }],
                  nextToken: "pipelines-page-2"
                })
            })
          ))
        )
      )
    ))

  it.effect("accepts a full-length pipeline discovery cursor", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const page = yield* client.listPipelinesPage({
        account: { profile: "production", region: "eu-west-1", operationTimeoutMillis: 10_000 },
        nextToken: null
      })
      assert.strictEqual(page.nextToken, "x".repeat(2_048))
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              CodePipelineReadProvider,
              baseProvider({
                listPipelinesPage: () =>
                  Effect.succeed({ pipelines: [{ name: "payments-production" }], nextToken: "x".repeat(2_048) })
              })
            )
          )
        )
      )
    ))

  it.effect("rejects malformed pipeline discovery output", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const result = yield* client.listPipelinesPage({
        account: { profile: "production", region: "eu-west-1", operationTimeoutMillis: 10_000 },
        nextToken: null
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginMalformedResponseFailure)
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(Layer.succeed(
            CodePipelineReadProvider,
            baseProvider({
              listPipelinesPage: () => Effect.succeed({ pipelines: [{ name: "" }] })
            })
          ))
        )
      )
    ))

  it.effect("rejects overlong pipeline names at the provider boundary", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const result = yield* client.listPipelinesPage({
        account: { profile: "production", region: "eu-west-1", operationTimeoutMillis: 10_000 },
        nextToken: null
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "PluginMalformedResponseFailure")
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              CodePipelineReadProvider,
              baseProvider({
                listPipelinesPage: () => Effect.succeed({ pipelines: [{ name: "p".repeat(101) }] })
              })
            )
          )
        )
      )
    ))

  it.effect("discovers one AWS account and identifies the configured pipeline as its resource", () =>
    Effect.gen(function*() {
      const discovery = yield* runWithProvider(
        baseProvider(),
        Effect.flatMap(PluginConnection, (connection) => connection.discover)
      )

      assert.strictEqual(discovery.account?.providerImmutableId, "123456789012")
      assert.isNull(discovery.workspace)
      assert.strictEqual(
        discovery.resource?.providerImmutableId,
        "arn:aws:codepipeline:eu-west-1:123456789012:release"
      )
      assert.strictEqual(discovery.resource?.displayName, "release")
    }))

  it.effect("normalizes bounded pipeline, execution, stage, and action reads with stable provenance", () =>
    Effect.gen(function*() {
      const executionRequests = yield* Ref.make<
        ReadonlyArray<{ readonly maximumResults: number; readonly token: string | null }>
      >([])
      const actionRequests = yield* Ref.make<
        ReadonlyArray<{ readonly maximumResults: number; readonly token: string | null }>
      >([])
      const provider = baseProvider({
        listPipelineExecutionsPage: (request) =>
          Ref.update(executionRequests, (requests) => [...requests, {
            maximumResults: request.maximumResults,
            token: request.nextToken
          }]).pipe(
            Effect.as({
              pipelineExecutionSummaries: [
                executionSummary(request.nextToken === null ? "execution-1842" : "execution-1843", "Succeeded")
              ],
              ...(request.nextToken === null ? { nextToken: "execution-page-2" } : {})
            })
          ),
        listActionExecutionsPage: (request) =>
          Ref.update(actionRequests, (requests) => [...requests, {
            maximumResults: request.maximumResults,
            token: request.nextToken
          }]).pipe(
            Effect.as(
              request.nextToken === null
                ? actionOutput(
                  request.pipelineExecutionId,
                  `${request.pipelineExecutionId}-action-1`,
                  "Compile",
                  "Succeeded",
                  "action-page-2"
                )
                : actionOutput(
                  request.pipelineExecutionId,
                  `${request.pipelineExecutionId}-action-2`,
                  "Package",
                  "Succeeded"
                )
            )
          )
      })
      const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "executions", checkpoint: null })
      const runSync = runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.sync(request).pipe(Stream.runCollect)
        })
      )
      const first = yield* runSync
      const replay = yield* runSync

      assert.strictEqual(first.length, 2)
      assert.strictEqual(first[0]?.checkpointAfterPage, "next:execution-page-2")
      assert.isTrue(first[0]?.hasMore)
      assert.strictEqual(first[1]?.checkpointAfterPage, "complete")
      assert.deepStrictEqual(
        first.flatMap(({ events }) => events.map(({ eventId }) => eventId)),
        replay.flatMap(({ events }) => events.map(({ eventId }) => eventId))
      )
      assert.deepStrictEqual(
        (yield* Ref.get(executionRequests)).map(({ maximumResults, token }) => [maximumResults, token]),
        [[1, null], [1, "execution-page-2"], [1, null], [1, "execution-page-2"]]
      )
      assert.isTrue((yield* Ref.get(actionRequests)).every(({ maximumResults }) => maximumResults === 1))

      const firstEvents = first[0]?.events ?? []
      assert.deepStrictEqual(
        firstEvents.map((event) => event._tag === "UpsertEntity" ? event.entityType : event._tag),
        [
          "aws.codepipeline.pipeline",
          "aws.codepipeline.execution",
          "aws.codepipeline.stage",
          "aws.codepipeline.action",
          "aws.codepipeline.action"
        ]
      )
      const action = firstEvents.find((event) =>
        event._tag === "UpsertEntity" && event.entityType === "aws.codepipeline.action"
      )
      assert.strictEqual(action?._tag, "UpsertEntity")
      if (action?._tag === "UpsertEntity") {
        const serialized = JSON.stringify(action.attributes)
        assert.include(serialized, "\"access\":\"proxy-required\"")
        assert.notInclude(serialized, "token=secret")
        assert.notInclude(serialized, "SECRET=must-not-leak")
        assert.notInclude(serialized, "externalExecutionUrl")
      }

      const stageRequest = Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
        entityType: "aws.codepipeline.stage",
        vendorImmutableId: "execution-1842#Build"
      })
      const stage = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.readEntity(stageRequest)
        })
      )
      assert.strictEqual(stage._tag, "found")
      if (stage._tag === "found" && stage.event._tag === "UpsertEntity") {
        assert.strictEqual(stage.event.entityType, "aws.codepipeline.stage")
        assert.strictEqual(stage.event.attributes.status, "Succeeded")
      }
    }))

  it.effect("ends bounded execution runs terminally and resumes from the persisted provider cursor", () =>
    Effect.gen(function*() {
      const requestedTokens = yield* Ref.make<ReadonlyArray<string | null>>([])
      const provider = baseProvider({
        listPipelineExecutionsPage: (request) =>
          Ref.update(requestedTokens, (tokens) => [...tokens, request.nextToken]).pipe(
            Effect.as({
              pipelineExecutionSummaries: [executionSummary(
                request.nextToken === null ? "execution-1842" : "execution-1843",
                "Succeeded"
              )],
              nextToken: request.nextToken === null ? "execution-page-2" : "execution-page-3"
            })
          )
      })
      const boundedConfiguration = { ...configuration, maximumExecutionPages: 1 }
      const synchronize = (checkpoint: string | null) =>
        runWithProvider(
          provider,
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "executions", checkpoint })
            return yield* connection.sync(request).pipe(Stream.runCollect)
          }),
          boundedConfiguration
        )

      const first = yield* synchronize(null)
      const resumed = yield* synchronize(first[0]?.checkpointAfterPage ?? null)

      assert.strictEqual(first.length, 1)
      assert.isFalse(first[0]?.hasMore)
      assert.strictEqual(first[0]?.checkpointAfterPage, "next:execution-page-2")
      assert.strictEqual(resumed.length, 1)
      assert.isFalse(resumed[0]?.hasMore)
      assert.strictEqual(resumed[0]?.checkpointAfterPage, "next:execution-page-3")
      assert.deepStrictEqual(yield* Ref.get(requestedTokens), [null, "execution-page-2"])
    }))

  it.effect("reserves checkpoint prefix space when decoding provider cursors", () =>
    Effect.gen(function*() {
      const synchronize = (nextToken: string) =>
        runWithProvider(
          baseProvider({
            listPipelineExecutionsPage: () =>
              Effect.succeed({
                pipelineExecutionSummaries: [executionSummary("execution-1842", "Succeeded")],
                nextToken
              })
          }),
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "executions", checkpoint: null })
            return yield* connection.sync(request).pipe(Stream.runCollect)
          }),
          { ...configuration, maximumExecutionPages: 1 }
        )

      const invalid = yield* synchronize("x".repeat(2_044)).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalid))
      if (Result.isFailure(invalid)) assert.instanceOf(invalid.failure, PluginMalformedResponseFailure)

      const valid = yield* synchronize("x".repeat(2_043))
      assert.strictEqual(valid.length, 1)
      assert.isFalse(valid[0]?.hasMore)
      assert.strictEqual(valid[0]?.checkpointAfterPage.length, 2_048)
    }))

  it("uses the default provider chain while keeping named AWS profiles explicit", () => {
    assert.deepStrictEqual(codePipelineCredentialProviderOptions("default"), {})
    assert.deepStrictEqual(codePipelineCredentialProviderOptions("production"), { profile: "production" })
  })

  it.effect("maps AWS request-timeout tags separately from provider outages", () =>
    Effect.gen(function*() {
      const requestTimeout = yield* mapCodePipelineAwsFailure(
        "codepipeline-get-pipeline",
        { _tag: "RequestTimeoutException" }
      ).pipe(Effect.flip)
      const requestExpired = yield* mapCodePipelineAwsFailure(
        "codepipeline-get-pipeline",
        { _tag: "RequestExpired" }
      ).pipe(Effect.flip)
      const outage = yield* mapCodePipelineAwsFailure(
        "codepipeline-get-pipeline",
        { _tag: "ServiceUnavailable" }
      ).pipe(Effect.flip)
      const conflict = yield* mapCodePipelineAwsFailure(
        "codepipeline-put-approval",
        { _tag: "InvalidApprovalTokenException" }
      ).pipe(Effect.flip)

      assert.instanceOf(requestTimeout, PluginTimeoutFailure)
      assert.instanceOf(requestExpired, PluginTimeoutFailure)
      assert.instanceOf(outage, PluginOutageFailure)
      assert.instanceOf(conflict, PluginConflictFailure)
    }))

  it.effect("Schema-rejects malformed AWS output before normalization", () =>
    Effect.gen(function*() {
      const provider = baseProvider({ getPipeline: () => Effect.succeed({ pipeline: { name: "release" } }) })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.health
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginMalformedResponseFailure)
    }))

  it.effect("propagates typed authentication failures without raw provider causes", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getPipeline: () => Effect.fail(new PluginAuthenticationFailure({ operation: "codepipeline-get-pipeline" }))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.health
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginAuthenticationFailure)
    }))

  it.effect("stops action pagination at configured bounds and reports truncation", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const provider = baseProvider({
        listActionExecutionsPage: (request) =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.as(actionOutput(
              request.pipelineExecutionId,
              `${request.pipelineExecutionId}-bounded-action`,
              "Compile",
              "Succeeded",
              "still-more-actions"
            ))
          )
      })
      const boundedConfiguration = { ...configuration, maximumExecutionPages: 1, maximumActionPages: 1 }
      const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "executions", checkpoint: null })
      const pages = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.sync(request).pipe(Stream.runCollect)
        }),
        boundedConfiguration
      )

      assert.strictEqual(yield* Ref.get(calls), 1)
      const execution = pages[0]?.events.find((event) =>
        event._tag === "UpsertEntity" && event.entityType === "aws.codepipeline.execution"
      )
      assert.strictEqual(execution?._tag, "UpsertEntity")
      if (execution?._tag === "UpsertEntity") assert.strictEqual(execution.attributes.actionsTruncated, true)
    }))

  it.effect("caps execution snapshot fan-out at two provider calls", () =>
    Effect.gen(function*() {
      const active = yield* Ref.make(0)
      const maximumActive = yield* Ref.make(0)
      const bothStarted = yield* Deferred.make<void>()
      const tracked = <Value>(value: Value): Effect.Effect<Value> =>
        Effect.gen(function*() {
          const count = yield* Ref.updateAndGet(active, (current) => current + 1)
          yield* Ref.update(maximumActive, (current) => Math.max(current, count))
          if (count === 2) yield* Deferred.succeed(bothStarted, undefined)
          yield* Deferred.await(bothStarted)
          return value
        }).pipe(Effect.ensuring(Ref.update(active, (current) => current - 1)))
      const provider = baseProvider({
        getPipelineExecution: (request) => tracked(executionOutput(request.pipelineExecutionId, "Succeeded")),
        listActionExecutionsPage: (request) =>
          tracked(actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-action`,
            "Compile",
            "Succeeded"
          ))
      })
      const snapshot = yield* Effect.gen(function*() {
        const client = yield* CodePipelineReadClient
        return yield* client.getExecutionSnapshot({
          account: {
            profile: configuration.profile,
            region: configuration.region,
            operationTimeoutMillis: configuration.operationTimeoutMillis
          },
          pipelineName: configuration.pipelineName,
          pipelineExecutionId: "execution-1842",
          actionBounds: { pageSize: 1, maximumPages: 1, maximumActions: 1 },
          summary: null
        })
      }).pipe(
        Effect.provide(
          CodePipelineReadClient.layer.pipe(
            Layer.provide(Layer.succeed(CodePipelineReadProvider, provider))
          )
        )
      )

      assert.strictEqual(yield* Ref.get(maximumActive), 2)
      assert.strictEqual(snapshot.actionCollection.actions.length, 1)
    }))

  it.effect("fails closed when the execution provider repeats a cursor", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        listPipelineExecutionsPage: (request) =>
          Effect.succeed({
            pipelineExecutionSummaries: [executionSummary(
              request.nextToken === null ? "execution-1842" : "execution-1843",
              "Succeeded"
            )],
            nextToken: "repeated-execution-cursor"
          })
      })
      const request = Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "executions", checkpoint: null })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.sync(request).pipe(Stream.runCollect)
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMalformedResponseFailure)
        if (Predicate.isTagged(result.failure, "PluginMalformedResponseFailure")) {
          assert.strictEqual(result.failure.diagnosticCode, "codepipeline-execution-cursor-repeated")
        }
      }
    }))

  it.effect("starts an explicitly pinned execution exactly once for a repeated idempotency key", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<
        ReadonlyArray<{ readonly token: string; readonly revisions: ReadonlyArray<unknown> }>
      >([])
      const provider = baseProvider({
        startPipelineExecution: (request) =>
          Ref.update(calls, (current) => [...current, {
            token: request.clientRequestToken,
            revisions: request.sourceRevisions
          }]).pipe(Effect.as({ pipelineExecutionId: "execution-governed-1" }))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.start",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:Succeeded:2026-07-16T09:05:00.000Z",
              payload: {
                sourceRevisions: [{
                  actionName: "Checkout",
                  revisionType: "COMMIT_ID",
                  revisionValue: "commit-abc"
                }]
              },
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "start-release-1",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-1",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const preflight = yield* executor.preflight(authorized)
          const first = yield* executor.executeAuthorizedAction(authorized)
          const replay = yield* executor.executeAuthorizedAction(authorized)
          return { authorized, first, preflight, proposal, replay }
        })
      )

      assert.strictEqual(result.preflight._tag, "ready")
      assert.deepStrictEqual(result.first, result.replay)
      assert.strictEqual(result.first._tag, "confirmed")
      if (result.first._tag === "confirmed") {
        assert.strictEqual(result.first.receipt.status, "accepted")
      }
      const observed = yield* Ref.get(calls)
      assert.strictEqual(observed.length, 1)
      assert.match(observed[0]?.token ?? "", /^cc-[0-9a-f]{64}$/u)
      assert.deepStrictEqual(observed[0]?.revisions, [{
        actionName: "Checkout",
        revisionType: "COMMIT_ID",
        revisionValue: "commit-abc"
      }])
      const serialized = JSON.stringify(result)
      assert.notInclude(serialized, "accessKeyId")
      assert.notInclude(serialized, "secretAccessKey")
      assert.notInclude(serialized, "sessionToken")
    }))

  it.effect("rejects a start that omits one configured source action revision", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getPipeline: () =>
          Effect.succeed({
            ...pipelineOutput,
            pipeline: {
              ...pipelineOutput.pipeline,
              stages: [
                ...pipelineOutput.pipeline.stages,
                {
                  name: "ImageSource",
                  actions: [{
                    name: "ContainerImage",
                    actionTypeId: {
                      category: "Source",
                      owner: "AWS",
                      provider: "ECR",
                      version: "1"
                    },
                    outputArtifacts: [{ name: "ImageOutput" }]
                  }]
                }
              ]
            }
          }),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "must-not-start" })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.start",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:Succeeded:2026-07-16T09:05:00.000Z",
              payload: {
                sourceRevisions: [{
                  actionName: "Checkout",
                  revisionType: "COMMIT_ID",
                  revisionValue: "commit-abc"
                }]
              },
              evidenceIds: []
            })
          )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("reconciles an ambiguous start by reusing the exact client token", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>([])
      const provider = baseProvider({
        startPipelineExecution: (request) =>
          Effect.gen(function*() {
            const current = yield* Ref.get(tokens)
            yield* Ref.set(tokens, [...current, request.clientRequestToken])
            return current.length === 0
              ? yield* new PluginTimeoutFailure({ operation: "codepipeline-start-execution" })
              : { pipelineExecutionId: "execution-reconciled-1" }
          })
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.start",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:Succeeded:2026-07-16T09:05:00.000Z",
              payload: {
                sourceRevisions: [{
                  actionName: "Checkout",
                  revisionType: "COMMIT_ID",
                  revisionValue: "commit-abc"
                }]
              },
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "start-release-ambiguous-1",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-ambiguous-1",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (Result.isSuccess(dispatched)) return yield* Effect.die("expected an ambiguous dispatch")
          assert.instanceOf(dispatched.failure, PluginUnknownOutcomeFailure)
          if (!Predicate.isTagged(dispatched.failure, "PluginUnknownOutcomeFailure")) {
            return yield* Effect.die("expected a reconcilable unknown outcome")
          }
          const reconciled = yield* executor.reconcile({
            reconciliationKey: dispatched.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })
          return { reconciled }
        })
      )

      assert.strictEqual(result.reconciled._tag, "succeeded")
      const observedTokens = yield* Ref.get(tokens)
      assert.strictEqual(observedTokens.length, 2)
      assert.strictEqual(observedTokens[0], observedTokens[1])
    }))

  it.effect("keeps the one-time approval token private while dispatching it exactly once", () =>
    Effect.gen(function*() {
      const approvalTokens = yield* Ref.make<ReadonlyArray<string>>([])
      const provider = baseProvider({
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "InProgress")),
        listActionExecutionsPage: (request) => {
          const output = actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-approval-1`,
            "ReleaseApproval",
            "InProgress"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((detail) => ({
              ...detail,
              input: {
                ...detail.input,
                actionTypeId: {
                  category: "Approval",
                  owner: "AWS",
                  provider: "Manual",
                  version: "1"
                }
              }
            }))
          })
        },
        getPipelineState: () =>
          Effect.succeed({
            pipelineName: "release",
            pipelineVersion: 7,
            stageStates: [{
              stageName: "Build",
              actionStates: [{
                actionName: "ReleaseApproval",
                latestExecution: {
                  actionExecutionId: "execution-1842-approval-1",
                  status: "InProgress",
                  token: "approval-token-must-remain-private",
                  lastStatusChange: new Date("2026-07-16T09:04:00.000Z")
                }
              }]
            }]
          }),
        putApprovalResult: (request) =>
          Ref.update(approvalTokens, (tokens) => [...tokens, request.token]).pipe(
            Effect.as({ approvedAt: new Date("2026-07-16T09:10:00.000Z") })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.approve",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:InProgress:2026-07-16T09:05:00.000Z",
              payload: {
                stageName: "Build",
                actionName: "ReleaseApproval",
                actionExecutionId: "execution-1842-approval-1",
                summary: "Release approved by the governed workflow"
              },
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "approve-release-1",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-approval-1",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const receipt = yield* executor.executeAuthorizedAction(authorized)
          return { proposal, receipt }
        })
      )

      assert.deepStrictEqual(yield* Ref.get(approvalTokens), ["approval-token-must-remain-private"])
      const serialized = JSON.stringify(result)
      assert.notInclude(serialized, "approval-token-must-remain-private")
      assert.notInclude(serialized, "\"token\"")
    }))

  it.effect("blocks approval when the one-time provider token changes after proposal", () =>
    Effect.gen(function*() {
      const token = yield* Ref.make("approval-token-a")
      const approvalCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "InProgress")),
        listActionExecutionsPage: (request) => {
          const output = actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-approval-1`,
            "ReleaseApproval",
            "InProgress"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((detail) => ({
              ...detail,
              input: {
                ...detail.input,
                actionTypeId: {
                  category: "Approval",
                  owner: "AWS",
                  provider: "Manual",
                  version: "1"
                }
              }
            }))
          })
        },
        getPipelineState: () =>
          Ref.get(token).pipe(
            Effect.map((currentToken) => ({
              pipelineName: "release",
              pipelineVersion: 7,
              stageStates: [{
                stageName: "Build",
                actionStates: [{
                  actionName: "ReleaseApproval",
                  latestExecution: {
                    actionExecutionId: "execution-1842-approval-1",
                    status: "InProgress",
                    token: currentToken
                  }
                }]
              }]
            }))
          ),
        putApprovalResult: () => Ref.update(approvalCalls, (count) => count + 1).pipe(Effect.as({}))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.approve",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:InProgress:2026-07-16T09:05:00.000Z",
              payload: {
                stageName: "Build",
                actionName: "ReleaseApproval",
                actionExecutionId: "execution-1842-approval-1",
                summary: "Approve release"
              },
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "approve-release-token-rotation",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-approval-token-rotation",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          yield* Ref.set(token, "approval-token-b")
          return {
            preflight: yield* executor.preflight(authorized),
            serializedProposal: JSON.stringify(proposal)
          }
        })
      )

      assert.strictEqual(result.preflight._tag, "blocked")
      assert.strictEqual(yield* Ref.get(approvalCalls), 0)
      assert.notInclude(result.serializedProposal, "approval-token-a")
      assert.notInclude(result.serializedProposal, "approval-token-b")
    }))

  it.effect("starts one distinct retry execution and preserves retry lineage in the receipt", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const revisions = yield* Ref.make<ReadonlyArray<unknown>>([])
      const provider = baseProvider({
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "Failed")),
        startPipelineExecution: (request) =>
          Effect.all([
            Ref.update(calls, (count) => count + 1),
            Ref.set(revisions, request.sourceRevisions)
          ]).pipe(Effect.as({ pipelineExecutionId: "execution-retry-1" }))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.retry",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:Failed:2026-07-16T09:05:00.000Z",
              payload: {},
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "retry-release-1",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-retry-1",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const first = yield* executor.executeAuthorizedAction(authorized)
          const replay = yield* executor.executeAuthorizedAction(authorized)
          return { first, proposal, replay }
        })
      )

      assert.strictEqual(yield* Ref.get(calls), 1)
      assert.deepStrictEqual(yield* Ref.get(revisions), [{
        actionName: "Checkout",
        revisionType: "COMMIT_ID",
        revisionValue: "commit-abc"
      }])
      assert.deepStrictEqual(result.first, result.replay)
      assert.include(JSON.stringify(result.proposal.request.payload), "\"retryOf\":\"execution-1842\"")
      assert.strictEqual(result.first._tag, "confirmed")
      if (result.first._tag === "confirmed") {
        assert.strictEqual(result.first.receipt.status, "accepted")
        assert.strictEqual(result.first.receipt.providerOperationId, "execution-retry-1")
        assert.include(result.first.receipt.safeSummary, "execution-1842")
      }
    }))

  it.effect("rejects retry when any configured source revision is missing or the pipeline revision changes", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const pipelineVersion = yield* Ref.make(7)
      const provider = baseProvider({
        getPipeline: () =>
          Ref.get(pipelineVersion).pipe(
            Effect.map((version) => ({
              ...pipelineOutput,
              pipeline: {
                ...pipelineOutput.pipeline,
                version,
                stages: version === 7
                  ? pipelineOutput.pipeline.stages
                  : [
                    ...pipelineOutput.pipeline.stages,
                    {
                      name: "ImageSource",
                      actions: [{
                        name: "ContainerImage",
                        actionTypeId: {
                          category: "Source",
                          owner: "AWS",
                          provider: "ECR",
                          version: "1"
                        },
                        outputArtifacts: [{ name: "ImageOutput" }]
                      }]
                    }
                  ]
              }
            }))
          ),
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "Failed")),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "must-not-start" })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.retry",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:Failed:2026-07-16T09:05:00.000Z",
              payload: {},
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "retry-release-pipeline-change",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-retry-pipeline-change",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          yield* Ref.set(pipelineVersion, 8)
          return yield* executor.preflight(authorized)
        })
      )

      assert.strictEqual(result._tag, "blocked")
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("rejects retry proposal when one configured source has no reviewed artifact revision", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getPipeline: () =>
          Effect.succeed({
            ...pipelineOutput,
            pipeline: {
              ...pipelineOutput.pipeline,
              stages: [
                ...pipelineOutput.pipeline.stages,
                {
                  name: "ImageSource",
                  actions: [{
                    name: "ContainerImage",
                    actionTypeId: {
                      category: "Source",
                      owner: "AWS",
                      provider: "ECR",
                      version: "1"
                    },
                    outputArtifacts: [{ name: "ImageOutput" }]
                  }]
                }
              ]
            }
          }),
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "Failed")),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "must-not-start" })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.retry",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:Failed:2026-07-16T09:05:00.000Z",
              payload: {},
              evidenceIds: []
            })
          )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginConfigurationFailure)
        if (Predicate.isTagged(result.failure, "PluginConfigurationFailure")) {
          assert.strictEqual(result.failure.diagnosticCode, "codepipeline-retry-source-revision-incomplete")
        }
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("rejects a non-running stop target without invoking the mutation provider", () =>
    Effect.gen(function*() {
      const stopCalls = yield* Ref.make(0)
      const provider = baseProvider({
        stopPipelineExecution: (request) =>
          Ref.update(stopCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: request.pipelineExecutionId })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.stop",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:Succeeded:2026-07-16T09:05:00.000Z",
              payload: { mode: "wait", reason: "Operator requested stop" },
              evidenceIds: []
            })
          )
        })
      ).pipe(Effect.result)

      assert.strictEqual(result._tag, "Failure")
      assert.strictEqual(yield* Ref.get(stopCalls), 0)
    }))

  it.effect("does not reconcile a stop as successful from an unrelated terminal execution status", () =>
    Effect.gen(function*() {
      const executionStatus = yield* Ref.make("InProgress")
      const provider = baseProvider({
        getPipelineExecution: (request) =>
          Ref.get(executionStatus).pipe(
            Effect.map((status) => executionOutput(request.pipelineExecutionId, status))
          ),
        stopPipelineExecution: () => Effect.fail(new PluginTimeoutFailure({ operation: "codepipeline-stop-execution" }))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.stop",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:InProgress:2026-07-16T09:05:00.000Z",
              payload: { mode: "wait", reason: "Stop the release" },
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "stop-release-ambiguous",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-stop-ambiguous",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (
            Result.isSuccess(dispatched) ||
            !Predicate.isTagged(dispatched.failure, "PluginUnknownOutcomeFailure")
          ) {
            return yield* Effect.die("expected ambiguous stop")
          }
          const reconciliation = {
            reconciliationKey: dispatched.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          }
          yield* Ref.set(executionStatus, "Succeeded")
          const unrelatedTerminal = yield* executor.reconcile(reconciliation)
          yield* Ref.set(executionStatus, "Stopped")
          const stopped = yield* executor.reconcile(reconciliation)
          return { stopped, unrelatedTerminal }
        })
      )

      assert.strictEqual(result.unrelatedTerminal._tag, "failed")
      assert.strictEqual(result.stopped._tag, "succeeded")
    }))

  it.effect("keeps ambiguous approval pending when its action disappears and succeeds only on the requested result", () =>
    Effect.gen(function*() {
      const approvalState = yield* Ref.make<"pending" | "missing" | "approved">("pending")
      const provider = baseProvider({
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "InProgress")),
        listActionExecutionsPage: (request) => {
          const output = actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-approval-1`,
            "ReleaseApproval",
            "InProgress"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((detail) => ({
              ...detail,
              input: {
                ...detail.input,
                actionTypeId: {
                  category: "Approval",
                  owner: "AWS",
                  provider: "Manual",
                  version: "1"
                }
              }
            }))
          })
        },
        getPipelineState: () =>
          Ref.get(approvalState).pipe(
            Effect.map((state) => ({
              pipelineName: "release",
              pipelineVersion: 7,
              stageStates: state === "missing"
                ? []
                : [{
                  stageName: "Build",
                  actionStates: [{
                    actionName: "ReleaseApproval",
                    latestExecution: {
                      actionExecutionId: "execution-1842-approval-1",
                      status: state === "approved" ? "Succeeded" : "InProgress",
                      ...(state === "pending" ? { token: "approval-token-a" } : {})
                    }
                  }]
                }]
            }))
          ),
        putApprovalResult: () => Effect.fail(new PluginTimeoutFailure({ operation: "codepipeline-put-approval" }))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.approve",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:InProgress:2026-07-16T09:05:00.000Z",
              payload: {
                stageName: "Build",
                actionName: "ReleaseApproval",
                actionExecutionId: "execution-1842-approval-1",
                summary: "Approve release"
              },
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "approve-release-ambiguous",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-approve-ambiguous",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (
            Result.isSuccess(dispatched) ||
            !Predicate.isTagged(dispatched.failure, "PluginUnknownOutcomeFailure")
          ) {
            return yield* Effect.die("expected ambiguous approval")
          }
          const reconciliation = {
            reconciliationKey: dispatched.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          }
          yield* Ref.set(approvalState, "missing")
          const missing = yield* executor.reconcile(reconciliation)
          yield* Ref.set(approvalState, "approved")
          const approved = yield* executor.reconcile(reconciliation)
          return { approved, missing }
        })
      )

      assert.strictEqual(result.missing._tag, "pending")
      assert.strictEqual(result.approved._tag, "succeeded")
    }))

  it.effect("revalidates action identity before bounded logs and artifact bytes leave the plugin", () =>
    Effect.gen(function*() {
      const logCoordinates = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([])
      const artifactCoordinates = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([])
      const provider = baseProvider({
        getLogEventsPage: (request) =>
          Ref.update(logCoordinates, (current) => {
            const coordinates: readonly [string, string] = [request.logGroupName, request.logStreamName]
            return [...current, coordinates]
          }).pipe(
            Effect.as({
              events: [{
                timestamp: Date.parse("2026-07-16T09:02:00.000Z"),
                ingestionTime: Date.parse("2026-07-16T09:02:01.000Z"),
                message: "build completed"
              }],
              nextForwardToken: "opaque-log-cursor"
            })
          ),
        getArtifactRange: (request) =>
          Ref.update(artifactCoordinates, (current) => {
            const coordinates: readonly [string, string] = [request.bucket, request.key]
            return [...current, coordinates]
          }).pipe(
            Effect.as({
              bytes: Uint8Array.from([1, 2, 3]),
              contentLength: 3,
              contentRange: "bytes 0-2/9"
            })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const pipeline = connection.pipeline
          assert.isDefined(pipeline)
          if (pipeline === undefined || Option.isNone(pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          const action = {
            entity: {
              entityType: "aws.codepipeline.action",
              vendorImmutableId: "execution-1842#execution-1842-action-1"
            },
            executionId: "execution-1842",
            actionExecutionId: "execution-1842-action-1",
            expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
          }
          const logs = yield* pipeline.value.readLogPage(
            Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
              action,
              cursor: null,
              limit: 10
            })
          )
          const artifact = yield* pipeline.value.readArtifactRange(
            Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
              action,
              direction: "output",
              artifactName: "BuildOutput",
              offset: 0,
              length: 3
            })
          )
          return { artifact, logs }
        })
      )

      assert.deepStrictEqual(yield* Ref.get(logCoordinates), [
        ["/aws/codebuild/release", "build"]
      ])
      assert.deepStrictEqual(yield* Ref.get(artifactCoordinates), [
        ["artifacts", "build.zip"]
      ])
      assert.strictEqual(result.logs.events[0]?.message, "build completed")
      assert.strictEqual(result.artifact.bytesBase64, "AQID")
      assert.strictEqual(result.artifact.totalBytes, 9)
      const serialized = JSON.stringify(result)
      assert.notInclude(serialized, "artifacts")
      assert.notInclude(serialized, "build.zip")
      assert.notInclude(serialized, "arn:aws")
      assert.notInclude(serialized, "https://")
    }))

  it.effect("scopes opaque log cursors to one exact action and log stream", () =>
    Effect.gen(function*() {
      const logCursors = yield* Ref.make<ReadonlyArray<string | null>>([])
      const provider = baseProvider({
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "Succeeded")),
        listActionExecutionsPage: (request) => {
          const output = actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-action-1`,
            "Compile",
            "Succeeded"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((detail) => ({
              ...detail,
              output: {
                ...detail.output,
                executionResult: {
                  ...detail.output.executionResult,
                  logStreamARN:
                    `arn:aws:logs:eu-west-1:123456789012:log-group:/aws/codebuild/release:log-stream:${request.pipelineExecutionId}`
                }
              }
            }))
          })
        },
        getLogEventsPage: (request) =>
          Ref.update(logCursors, (current) => [...current, request.nextToken]).pipe(
            Effect.as(
              request.nextToken === null
                ? {
                  events: [{ timestamp: 1, message: "first" }],
                  nextForwardToken: "provider-cursor-a"
                }
                : { events: [{ timestamp: 2, message: "second" }] }
            )
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const pipeline = connection.pipeline
          if (pipeline === undefined || Option.isNone(pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          const requestFor = (executionId: string, cursor: string | null) =>
            Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
              action: {
                entity: {
                  entityType: "aws.codepipeline.action",
                  vendorImmutableId: `${executionId}#${executionId}-action-1`
                },
                executionId,
                actionExecutionId: `${executionId}-action-1`,
                expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
              },
              cursor,
              limit: 10
            })
          const first = yield* pipeline.value.readLogPage(requestFor("execution-a", null))
          if (first.nextCursor === null) return yield* Effect.die("expected cursor")
          const replay = yield* pipeline.value.readLogPage(
            requestFor("execution-a", first.nextCursor)
          )
          const crossAction = yield* pipeline.value.readLogPage(
            requestFor("execution-b", first.nextCursor)
          ).pipe(Effect.result)
          return { crossAction, first, replay }
        })
      )

      assert.deepStrictEqual(yield* Ref.get(logCursors), [null, "provider-cursor-a"])
      assert.strictEqual(result.replay.nextCursor, null)
      assert.isTrue(Result.isFailure(result.crossAction))
      if (Result.isFailure(result.crossAction)) {
        assert.instanceOf(result.crossAction.failure, PluginConflictFailure)
      }
    }))

  it.effect("enforces the configured aggregate UTF-8 log byte bound", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getLogEventsPage: () =>
          Effect.succeed({
            events: [{ timestamp: 1, message: "éé" }]
          })
      })
      const read = Effect.gen(function*() {
        const connection = yield* PluginConnection
        const pipeline = connection.pipeline
        if (pipeline === undefined || Option.isNone(pipeline)) {
          return yield* Effect.die("pipeline reader missing")
        }
        return yield* pipeline.value.readLogPage(
          Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
            action: {
              entity: {
                entityType: "aws.codepipeline.action",
                vendorImmutableId: "execution-1842#execution-1842-action-1"
              },
              executionId: "execution-1842",
              actionExecutionId: "execution-1842-action-1",
              expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
            },
            cursor: null,
            limit: 10
          })
        )
      })
      const rejected = yield* runWithProvider(
        provider,
        read,
        { ...configuration, maximumLogBytes: 3 }
      ).pipe(Effect.result)
      const accepted = yield* runWithProvider(
        provider,
        read,
        { ...configuration, maximumLogBytes: 4 }
      )

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.instanceOf(rejected.failure, PluginMalformedResponseFailure)
      }
      assert.strictEqual(accepted.events[0]?.message, "éé")
    }))

  it.effect("rejects out-of-range bounds before any provider call", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const provider = baseProvider({
        getPipeline: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(pipelineOutput))
      })
      const invalid = { ...configuration, maximumActionsPerExecution: 201 }
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.health
        }),
        invalid
      ).pipe(Effect.result)

      assert.strictEqual(yield* Ref.get(calls), 0)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, PluginConfigurationFailure)
      assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(CodePipelinePluginConfiguration)(invalid)))
    }))
})
