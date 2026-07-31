import * as DistilledCredentials from "@distilled.cloud/aws/Credentials"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClient from "effect/unstable/http/HttpClient"

import {
  AuthorizedPluginActionV1,
  PluginActionReconciliationKey,
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
  callPinnedCodePipelineMutationProvider,
  codePipelineCredentialProviderOptions,
  CodePipelineCredentialResolver,
  CodePipelinePreDispatchFailure,
  CodePipelinePreDispatchTimeoutFailure,
  CodePipelineReadProvider,
  type CodePipelineReadProviderService,
  collectBoundedArtifactBody,
  collectBoundedArtifactBodyWithin,
  mapCodePipelineAwsFailure,
  planCodePipelineArtifactObjectIdentity,
  planCodePipelineArtifactRange
} from "../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"
import { decodeCodePipelineStateProviderOutput } from "../../src/server/plugins/codepipeline/CodePipelineStateDecoder.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConfigurationFailure,
  PluginConflictFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
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
  it.effect("accepts live action revisions that omit optional revision metadata", () =>
    Effect.gen(function*() {
      const decoded = yield* decodeCodePipelineStateProviderOutput({
        pipelineName: "release",
        pipelineVersion: 7,
        stageStates: [{
          stageName: "Source",
          actionStates: [{
            actionName: "Checkout",
            currentRevision: {
              revisionId: "fixture-commit"
            }
          }]
        }]
      })
      assert.strictEqual(
        decoded.stageStates?.[0]?.actionStates?.[0]?.currentRevision?.revisionId,
        "fixture-commit"
      )

      const invalid = yield* decodeCodePipelineStateProviderOutput({
        pipelineName: "release",
        pipelineVersion: 7,
        stageStates: [{
          stageName: "Source",
          actionStates: [{
            actionName: "Checkout",
            currentRevision: {
              revisionChangeId: "fixture-change"
            }
          }]
        }]
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalid))
    }))

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

  it.effect("times out while draining a stalled artifact body", () =>
    Effect.gen(function*() {
      const stalledBody: Stream.Stream<Uint8Array> = Stream.fromEffect(Effect.never)
      const draining = yield* collectBoundedArtifactBodyWithin(
        stalledBody,
        3,
        1_000
      ).pipe(Effect.result, Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust("1 second")
      const result = yield* Fiber.join(draining)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginTimeoutFailure)
        if (Predicate.isTagged(result.failure, "PluginTimeoutFailure")) {
          assert.strictEqual(result.failure.operation, "codepipeline-get-artifact")
        }
      }
    }))

  it.effect("plans exhausted and satisfiable S3 artifact ranges without issuing an invalid range", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        planCodePipelineArtifactRange(9, 3, 9),
        { _tag: "exhausted", contentRange: "bytes */9" }
      )
      assert.deepStrictEqual(
        planCodePipelineArtifactRange(3, 3, 9),
        { _tag: "bounded", range: "bytes=3-5" }
      )
      assert.deepStrictEqual(
        planCodePipelineArtifactObjectIdentity({ VersionId: "version-1", ETag: "\"etag-1\"" }),
        { VersionId: "version-1" }
      )
      assert.deepStrictEqual(
        planCodePipelineArtifactObjectIdentity({ ETag: "\"etag-1\"" }),
        { IfMatch: "\"etag-1\"" }
      )
      assert.isNull(planCodePipelineArtifactObjectIdentity({}))
    }))

  it.effect("decodes an exhausted artifact range as an empty successful page", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const range = yield* client.getArtifactRange({
        account: {
          profile: configuration.profile,
          region: configuration.region,
          operationTimeoutMillis: configuration.operationTimeoutMillis
        },
        bucket: "private-artifacts",
        key: "release.zip",
        offset: 9,
        length: 3
      })
      assert.deepStrictEqual(range, {
        bytesBase64: "",
        totalBytes: 9
      })
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(Layer.succeed(
            CodePipelineReadProvider,
            baseProvider({
              getArtifactRange: () =>
                Effect.succeed({
                  bytes: new Uint8Array(),
                  contentLength: 0,
                  contentRange: "bytes */9"
                })
            })
          ))
        )
      )
    ))

  it.effect("preserves an offset beyond EOF as an empty exhausted range through the plugin boundary", () =>
    Effect.gen(function*() {
      const result = yield* runWithProvider(
        baseProvider({
          getArtifactRange: () =>
            Effect.succeed({
              bytes: new Uint8Array(),
              contentLength: 0,
              contentRange: "bytes */9"
            })
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          if (connection.pipeline === undefined || Option.isNone(connection.pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          return yield* connection.pipeline.value.readArtifactRange(
            Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
              action: {
                entity: {
                  entityType: "aws.codepipeline.action",
                  vendorImmutableId: "execution-1842#execution-1842-action-1"
                },
                executionId: "execution-1842",
                actionExecutionId: "execution-1842-action-1",
                expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
              },
              direction: "output",
              artifactName: "BuildOutput",
              offset: 10,
              length: 3
            })
          )
        })
      )

      assert.deepStrictEqual(result, {
        bytesBase64: "",
        contentType: "application/octet-stream",
        filename: "BuildOutput.zip",
        totalBytes: 9
      })
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

  it.effect("rejects a provider-truncated artifact range before returning plugin bytes", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        getArtifactRange: () =>
          Effect.succeed({
            bytes: Uint8Array.from([1, 2]),
            contentLength: 2,
            contentRange: "bytes 0-1/9"
          })
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          if (connection.pipeline === undefined || Option.isNone(connection.pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          return yield* connection.pipeline.value.readArtifactRange(
            Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
              action: {
                entity: {
                  entityType: "aws.codepipeline.action",
                  vendorImmutableId: "execution-1842#execution-1842-action-1"
                },
                executionId: "execution-1842",
                actionExecutionId: "execution-1842-action-1",
                expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
              },
              direction: "output",
              artifactName: "BuildOutput",
              offset: 0,
              length: 3
            })
          )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMalformedResponseFailure)
        if (Predicate.isTagged(result.failure, "PluginMalformedResponseFailure")) {
          assert.strictEqual(result.failure.diagnosticCode, "plugin-pipeline-artifact-range-invalid")
        }
      }
    }))

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

  it.effect("decodes the safe CodeCommit source coordinates for private attestation", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const pipeline = yield* client.getPipeline({
        account: { profile: "production", region: "eu-west-1", operationTimeoutMillis: 10_000 },
        pipelineName: "release"
      })
      assert.deepStrictEqual(pipeline.stages[0]?.actions[0]?.codeCommitSource, {
        repositoryName: "fixture-repository",
        branchName: "main",
        pollForSourceChanges: false
      })
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              CodePipelineReadProvider,
              baseProvider({
                getPipeline: () =>
                  Effect.succeed({
                    ...pipelineOutput,
                    pipeline: {
                      ...pipelineOutput.pipeline,
                      stages: pipelineOutput.pipeline.stages.map((stage) =>
                        stage.name !== "Source"
                          ? stage
                          : {
                            ...stage,
                            actions: stage.actions.map((action) => ({
                              ...action,
                              configuration: {
                                RepositoryName: "fixture-repository",
                                BranchName: "main",
                                PollForSourceChanges: "false"
                              }
                            }))
                          }
                      )
                    }
                  })
              })
            )
          )
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
      const serializedEvents = JSON.stringify(first.flatMap(({ events }) => events))
      assert.notInclude(serializedEvents, "\"bucket\"")
      assert.notInclude(serializedEvents, "\"key\"")
      assert.notInclude(serializedEvents, "source.zip")
      assert.notInclude(serializedEvents, "build.zip")
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
      const synchronizedExecution = firstEvents.find((event) =>
        event._tag === "UpsertEntity" &&
        event.entityType === "aws.codepipeline.execution" &&
        event.vendorImmutableId === "execution-1842"
      )
      assert.strictEqual(action?._tag, "UpsertEntity")
      if (action?._tag === "UpsertEntity") {
        const serialized = JSON.stringify(action.attributes)
        assert.include(serialized, "\"access\":\"proxy-required\"")
        assert.notInclude(serialized, "\"bucket\"")
        assert.notInclude(serialized, "\"key\"")
        assert.notInclude(serialized, "source.zip")
        assert.notInclude(serialized, "build.zip")
        assert.notInclude(serialized, "token=secret")
        assert.notInclude(serialized, "SECRET=must-not-leak")
        assert.notInclude(serialized, "externalExecutionUrl")
        assert.notInclude(serialized, "\"logStreamArn\"")
        assert.notInclude(
          serialized,
          "arn:aws:logs:eu-west-1:123456789012:log-group:/aws/codebuild/release:log-stream:build"
        )
        assert.include(serialized, "arn:aws:codepipeline:eu-west-1:123456789012:release")
      }

      const directExecution = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.readEntity(
            Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
              entityType: "aws.codepipeline.execution",
              vendorImmutableId: "execution-1842"
            })
          )
        })
      )
      assert.strictEqual(directExecution._tag, "found")
      assert.strictEqual(synchronizedExecution?._tag, "UpsertEntity")
      if (
        directExecution._tag === "found" &&
        directExecution.event._tag === "UpsertEntity" &&
        synchronizedExecution?._tag === "UpsertEntity"
      ) {
        assert.strictEqual(directExecution.event.revision, synchronizedExecution.revision)
        assert.strictEqual(directExecution.event.revision, "7:Succeeded:2026-07-16T09:05:00.000Z")
        assert.strictEqual(directExecution.event.attributes.updatedAt, "2026-07-16T09:05:00.000Z")
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

  it.effect("uses the execution detail timestamp as the canonical action revision input", () =>
    Effect.gen(function*() {
      const provider = baseProvider({
        listPipelineExecutionsPage: () =>
          Effect.succeed({
            pipelineExecutionSummaries: [executionSummary("execution-1842", "Failed")]
          }),
        getPipelineExecution: (request) => {
          const output = executionOutput(request.pipelineExecutionId, "Failed")
          const { lastUpdateTime: _lastUpdateTime, ...pipelineExecution } = output.pipelineExecution
          return Effect.succeed({
            ...output,
            pipelineExecution
          })
        }
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const pages = yield* connection.sync(
            Schema.decodeUnknownSync(PluginSyncRequestV1)({ streamKey: "executions", checkpoint: null })
          ).pipe(Stream.runCollect)
          const synchronized = pages[0]?.events.find((event) =>
            event._tag === "UpsertEntity" &&
            event.entityType === "aws.codepipeline.execution" &&
            event.vendorImmutableId === "execution-1842"
          )
          const direct = yield* connection.readEntity(
            Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
              entityType: "aws.codepipeline.execution",
              vendorImmutableId: "execution-1842"
            })
          )
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.retry",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: synchronized?.revision ?? "missing",
              payload: {},
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "retry-undated-detail",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-undated-detail",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const preflight = yield* executor.preflight(authorized)
          return { direct, preflight, synchronized }
        })
      )

      assert.strictEqual(result.synchronized?._tag, "UpsertEntity")
      assert.strictEqual(result.direct._tag, "found")
      if (
        result.synchronized?._tag === "UpsertEntity" &&
        result.direct._tag === "found" &&
        result.direct.event._tag === "UpsertEntity"
      ) {
        assert.strictEqual(result.synchronized.revision, "7:Failed:undated")
        assert.strictEqual(result.direct.event.revision, result.synchronized.revision)
        assert.isNull(result.direct.event.attributes.updatedAt)
      }
      assert.strictEqual(result.preflight._tag, "ready")
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

  it.effect("pins identity verification and mutation to one acquired credential snapshot", () =>
    Effect.gen(function*() {
      const runScenario = (identityEffect: Effect.Effect<unknown, unknown>) =>
        Effect.gen(function*() {
          const resolutionCalls = yield* Ref.make(0)
          const mutationCalls = yield* Ref.make(0)
          const mutationAccessKeys = yield* Ref.make<Array<string>>([])
          const resolver = Layer.succeed(CodePipelineCredentialResolver, {
            resolve: () =>
              Ref.update(resolutionCalls, (count) => count + 1).pipe(
                Effect.as({
                  accessKeyId: "mutation-access-key",
                  secretAccessKey: "mutation-secret",
                  sessionToken: "mutation-session-token"
                })
              )
          })
          const resolvedAccessKey = Effect.gen(function*() {
            const credentials = yield* DistilledCredentials.Credentials
            const resolved = yield* credentials
            return Redacted.value(resolved.accessKeyId)
          })
          const result = yield* callPinnedCodePipelineMutationProvider(
            "codepipeline-start-execution",
            {
              profile: "production",
              region: "eu-west-1",
              operationTimeoutMillis: 10_000
            },
            {
              accountId: "123456789012",
              arn: "arn:aws:sts::123456789012:assumed-role/control-center/preflight-session"
            },
            resolvedAccessKey.pipe(Effect.andThen(identityEffect)),
            Effect.gen(function*() {
              const accessKeyId = yield* resolvedAccessKey
              yield* Ref.update(mutationCalls, (count) => count + 1)
              yield* Ref.update(mutationAccessKeys, (keys) => [...keys, accessKeyId])
              return "execution-started"
            })
          ).pipe(
            Effect.result,
            Effect.provide(resolver),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("unused HTTP client"))
            )
          )
          return {
            mutationAccessKeys: yield* Ref.get(mutationAccessKeys),
            mutationCalls: yield* Ref.get(mutationCalls),
            resolutionCalls: yield* Ref.get(resolutionCalls),
            result
          }
        })

      const rotated = yield* runScenario(
        Effect.succeed({
          Account: "210987654321",
          Arn: "arn:aws:iam::210987654321:role/rotated-control-center"
        })
      )
      assert.strictEqual(rotated.result._tag, "Failure")
      if (rotated.result._tag === "Failure") {
        assert.instanceOf(rotated.result.failure, PluginConflictFailure)
      }
      assert.strictEqual(rotated.resolutionCalls, 1)
      assert.strictEqual(rotated.mutationCalls, 0)
      assert.deepStrictEqual(rotated.mutationAccessKeys, [])

      const identityOutage = yield* runScenario(Effect.fail({ _tag: "ServiceUnavailable" }))
      assert.strictEqual(identityOutage.result._tag, "Failure")
      if (identityOutage.result._tag === "Failure") {
        assert.instanceOf(identityOutage.result.failure, CodePipelinePreDispatchFailure)
      }
      assert.strictEqual(identityOutage.mutationCalls, 0)

      const malformedIdentity = yield* runScenario(
        Effect.succeed({ Account: "123456789012" })
      )
      assert.strictEqual(malformedIdentity.result._tag, "Failure")
      if (malformedIdentity.result._tag === "Failure") {
        assert.instanceOf(malformedIdentity.result.failure, CodePipelinePreDispatchFailure)
      }
      assert.strictEqual(malformedIdentity.mutationCalls, 0)

      const sameRole = yield* runScenario(
        Effect.succeed({
          Account: "123456789012",
          Arn: "arn:aws:sts::123456789012:assumed-role/control-center/mutation-session"
        })
      )
      assert.strictEqual(sameRole.result._tag, "Success")
      assert.strictEqual(sameRole.resolutionCalls, 1)
      assert.strictEqual(sameRole.mutationCalls, 1)
      assert.deepStrictEqual(sameRole.mutationAccessKeys, ["mutation-access-key"])
    }))

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
      const invalidMutation = yield* mapCodePipelineAwsFailure(
        "codepipeline-start-execution",
        { _tag: "ValidationException" }
      ).pipe(Effect.flip)
      const unstoppability = yield* mapCodePipelineAwsFailure(
        "codepipeline-stop-execution",
        { _tag: "PipelineExecutionNotStoppableException" }
      ).pipe(Effect.flip)
      const readValidation = yield* mapCodePipelineAwsFailure(
        "codepipeline-get-pipeline",
        { _tag: "ValidationException" }
      ).pipe(Effect.flip)
      const missingArtifact = yield* mapCodePipelineAwsFailure(
        "codepipeline-head-artifact",
        { _tag: "NotFound" }
      ).pipe(Effect.flip)
      const deniedArtifact = yield* mapCodePipelineAwsFailure(
        "codepipeline-head-artifact",
        { _tag: "AccessDenied" }
      ).pipe(Effect.flip)
      const slowedHead = yield* mapCodePipelineAwsFailure(
        "codepipeline-head-artifact",
        { _tag: "SlowDown" }
      ).pipe(Effect.flip)
      const slowedGet = yield* mapCodePipelineAwsFailure(
        "codepipeline-get-artifact",
        { _tag: "SlowDown" }
      ).pipe(Effect.flip)
      const requestLimited = yield* mapCodePipelineAwsFailure(
        "codepipeline-get-artifact",
        { _tag: "RequestLimitExceeded" }
      ).pipe(Effect.flip)

      assert.instanceOf(requestTimeout, PluginTimeoutFailure)
      assert.instanceOf(requestExpired, PluginTimeoutFailure)
      assert.instanceOf(outage, PluginOutageFailure)
      assert.instanceOf(conflict, PluginConflictFailure)
      assert.instanceOf(invalidMutation, PluginConflictFailure)
      assert.instanceOf(unstoppability, PluginConflictFailure)
      assert.instanceOf(readValidation, PluginOutageFailure)
      assert.strictEqual(missingArtifact._tag, "CodePipelineProviderNotFoundFailure")
      assert.instanceOf(deniedArtifact, PluginAuthorizationFailure)
      assert.instanceOf(slowedHead, PluginRateLimitFailure)
      assert.instanceOf(slowedGet, PluginRateLimitFailure)
      assert.instanceOf(requestLimited, PluginRateLimitFailure)
    }))

  it.effect("structurally redacts decoded approval tokens in private pipeline state", () =>
    Effect.gen(function*() {
      const client = yield* CodePipelineReadClient
      const state = yield* client.getPipelineState({
        account: {
          profile: configuration.profile,
          region: configuration.region,
          operationTimeoutMillis: configuration.operationTimeoutMillis
        },
        pipelineName: configuration.pipelineName
      })
      const token = state.actions[0]?.token

      assert.isNotNull(token)
      if (token !== undefined && token !== null) {
        assert.strictEqual(Redacted.value(token), "approval-token-private")
      }
      assert.notInclude(JSON.stringify(state), "approval-token-private")
      assert.notInclude(String(token), "approval-token-private")
    }).pipe(
      Effect.provide(
        CodePipelineReadClient.layer.pipe(
          Layer.provide(Layer.succeed(
            CodePipelineReadProvider,
            baseProvider({
              getPipelineState: () =>
                Effect.succeed({
                  pipelineName: "release",
                  pipelineVersion: 7,
                  stageStates: [{
                    stageName: "Build",
                    actionStates: [{
                      actionName: "ReleaseApproval",
                      latestExecution: {
                        actionExecutionId: "approval-action",
                        status: "InProgress",
                        token: "approval-token-private"
                      }
                    }]
                  }]
                })
            })
          ))
        )
      )
    ))

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

  it.effect("reuses one start token per idempotency key and separates distinct action identities", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<
        ReadonlyArray<{
          readonly token: string
          readonly revisions: ReadonlyArray<unknown>
          readonly variables: ReadonlyArray<unknown>
        }>
      >([])
      const provider = baseProvider({
        getPipelineExecution: () => Effect.die("pipeline start must not load an existing execution"),
        startPipelineExecution: (request) =>
          Ref.update(calls, (current) => [...current, {
            token: request.clientRequestToken,
            revisions: request.sourceRevisions,
            variables: request.variables
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
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
          const distinctAuthorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            ...authorized,
            idempotencyKey: "start-release-2",
            authorizationId: "authorization-2"
          })
          const distinct = yield* executor.executeAuthorizedAction(distinctAuthorized)
          return { authorized, distinct, first, preflight, proposal, replay }
        })
      )

      assert.strictEqual(result.preflight._tag, "ready")
      assert.deepStrictEqual(result.first, result.replay)
      assert.strictEqual(result.first._tag, "confirmed")
      if (result.first._tag === "confirmed") {
        assert.strictEqual(result.first.receipt.status, "accepted")
      }
      const observed = yield* Ref.get(calls)
      assert.strictEqual(observed.length, 2)
      assert.match(observed[0]?.token ?? "", /^cc-[0-9a-f]{64}$/u)
      assert.match(observed[1]?.token ?? "", /^cc-[0-9a-f]{64}$/u)
      assert.notStrictEqual(observed[0]?.token, observed[1]?.token)
      assert.deepStrictEqual(observed[0]?.revisions, [{
        actionName: "Checkout",
        revisionType: "COMMIT_ID",
        revisionValue: "commit-abc"
      }])
      assert.deepStrictEqual(observed[0]?.variables, [])
      const serialized = JSON.stringify(result)
      assert.notInclude(serialized, "accessKeyId")
      assert.notInclude(serialized, "secretAccessKey")
      assert.notInclude(serialized, "sessionToken")
    }))

  it.effect("scopes AWS start tokens to the authorized action across runtime instances", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>([])
      const provider = baseProvider({
        getPipelineExecution: () => Effect.die("pipeline start must not load an existing execution"),
        startPipelineExecution: (request) =>
          Ref.update(tokens, (current) => [...current, request.clientRequestToken]).pipe(
            Effect.as({ pipelineExecutionId: `execution-${request.clientRequestToken}` })
          )
      })
      const execute = (authorizationId: string) =>
        runWithProvider(
          provider,
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const executor = yield* AuthorizedPluginExecutor
            const proposal = yield* connection.proposeAction(
              Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
                actionKind: "pipeline.start",
                target: {
                  entityType: "pipeline",
                  vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
                },
                expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
              idempotencyKey: "shared-semantic-key",
              payloadDigest: proposal.payloadDigest,
              authorizationId,
              authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
              expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
            })
            const first = yield* executor.executeAuthorizedAction(authorized)
            const replay = yield* executor.executeAuthorizedAction(authorized)
            assert.deepStrictEqual(replay, first)
          })
        )

      yield* execute("workspace-a-authorization")
      yield* execute("workspace-b-authorization")

      const observed = yield* Ref.get(tokens)
      assert.strictEqual(observed.length, 2)
      assert.notStrictEqual(observed[0], observed[1])
    }))

  it.effect("orders canonical source revisions by code unit across reconstruction", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getPipeline: () =>
          Effect.succeed({
            ...pipelineOutput,
            pipeline: {
              ...pipelineOutput.pipeline,
              stages: [{
                name: "Source",
                actions: ["ä-source", "z-source"].map((name) => ({
                  name,
                  actionTypeId: {
                    category: "Source",
                    owner: "AWS",
                    provider: "CodeCommit",
                    version: "1"
                  },
                  outputArtifacts: [{ name: `${name}-output` }]
                }))
              }]
            }
          }),
        getPipelineExecution: () => Effect.die("pipeline start must not load an existing execution"),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "execution-code-unit-order" })
          )
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
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
              payload: {
                sourceRevisions: [{
                  actionName: "ä-source",
                  revisionType: "COMMIT_ID",
                  revisionValue: "commit-umlaut"
                }, {
                  actionName: "z-source",
                  revisionType: "COMMIT_ID",
                  revisionValue: "commit-z"
                }]
              },
              evidenceIds: []
            })
          )
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "start-code-unit-order",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-code-unit-order",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          return {
            dispatched: yield* executor.executeAuthorizedAction(authorized),
            payload: proposal.request.payload,
            preflight: yield* executor.preflight(authorized)
          }
        })
      )

      assert.strictEqual(result.preflight._tag, "ready")
      assert.strictEqual(result.dispatched._tag, "confirmed")
      assert.deepStrictEqual(result.payload, {
        pipelineRevision: "7:2026-07-16T08:00:00.000Z",
        sourceRevisions: [{
          actionName: "z-source",
          revisionType: "COMMIT_ID",
          revisionValue: "commit-z"
        }, {
          actionName: "ä-source",
          revisionType: "COMMIT_ID",
          revisionValue: "commit-umlaut"
        }],
        variables: []
      })
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
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
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginConflictFailure)
        if (Predicate.isTagged(result.failure, "PluginConflictFailure")) {
          assert.strictEqual(result.failure.diagnosticCode, "codepipeline-start-source-set-invalid")
        }
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("rejects provider-incompatible start revisions before mutation and accepts exact source types", () =>
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
        getPipelineExecution: () => Effect.die("pipeline start must not load an existing execution"),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "execution-source-types" })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const propose = (revisionType: "COMMIT_ID" | "IMAGE_DIGEST") =>
            connection.proposeAction(
              Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
                actionKind: "pipeline.start",
                target: {
                  entityType: "pipeline",
                  vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
                },
                expectedRevision: "7:2026-07-16T08:00:00.000Z",
                payload: {
                  sourceRevisions: [{
                    actionName: "Checkout",
                    revisionType: "COMMIT_ID",
                    revisionValue: "commit-abc"
                  }, {
                    actionName: "ContainerImage",
                    revisionType,
                    revisionValue: "sha256:image"
                  }]
                },
                evidenceIds: []
              })
            )
          const invalid = yield* propose("COMMIT_ID").pipe(Effect.result)
          const proposal = yield* propose("IMAGE_DIGEST")
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "start-source-types",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-source-types",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const dispatched = yield* executor.executeAuthorizedAction(authorized)
          return { dispatched, invalid }
        })
      )

      assert.isTrue(Result.isFailure(result.invalid))
      if (Result.isFailure(result.invalid)) {
        assert.strictEqual(result.invalid.failure._tag, "PluginConflictFailure")
      }
      assert.strictEqual(result.dispatched._tag, "confirmed")
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
    }))

  it.effect("gates S3 key overrides by action configuration and rejects unknown source providers", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const attempt = (
        providerName: "S3" | "CustomSource",
        allowS3ObjectKeyOverride: boolean,
        revisionType: "COMMIT_ID" | "S3_OBJECT_KEY" | "S3_OBJECT_VERSION_ID",
        identity: string,
        revisionValue = revisionType === "S3_OBJECT_KEY" ? "releases/v2.zip" : "revision-abc"
      ) =>
        runWithProvider(
          baseProvider({
            getPipeline: () =>
              Effect.succeed({
                ...pipelineOutput,
                pipeline: {
                  ...pipelineOutput.pipeline,
                  stages: pipelineOutput.pipeline.stages.map((stage) =>
                    stage.name !== "Source"
                      ? stage
                      : {
                        ...stage,
                        actions: stage.actions.map((action) => ({
                          ...action,
                          actionTypeId: {
                            ...action.actionTypeId,
                            provider: providerName
                          },
                          ...(providerName === "S3"
                            ? {
                              configuration: {
                                AllowOverrideForS3ObjectKey: allowS3ObjectKeyOverride ? "true" : "false"
                              }
                            }
                            : {})
                        }))
                      }
                  )
                }
              }),
            getPipelineExecution: () => Effect.die("pipeline start must not load an existing execution"),
            startPipelineExecution: () =>
              Ref.update(mutationCalls, (count) => count + 1).pipe(
                Effect.as({ pipelineExecutionId: `execution-${identity}` })
              )
          }),
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const executor = yield* AuthorizedPluginExecutor
            const proposal = yield* connection.proposeAction(
              Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
                actionKind: "pipeline.start",
                target: {
                  entityType: "pipeline",
                  vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
                },
                expectedRevision: "7:2026-07-16T08:00:00.000Z",
                payload: {
                  sourceRevisions: [{
                    actionName: "Checkout",
                    revisionType,
                    revisionValue
                  }]
                },
                evidenceIds: []
              })
            )
            return yield* executor.executeAuthorizedAction(
              Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
                proposal,
                idempotencyKey: `start-${identity}`,
                payloadDigest: proposal.payloadDigest,
                authorizationId: `authorization-${identity}`,
                authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
                expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
              })
            )
          })
        ).pipe(Effect.result)

      const rejectedKey = yield* attempt("S3", false, "S3_OBJECT_KEY", "s3-key-disabled")
      const acceptedVersion = yield* attempt("S3", false, "S3_OBJECT_VERSION_ID", "s3-version")
      const acceptedFullVersion = yield* attempt(
        "S3",
        false,
        "S3_OBJECT_VERSION_ID",
        "s3-version-full",
        "v".repeat(1_024)
      )
      const rejectedOversizedVersion = yield* attempt(
        "S3",
        false,
        "S3_OBJECT_VERSION_ID",
        "s3-version-oversized",
        "v".repeat(1_025)
      )
      const acceptedKey = yield* attempt("S3", true, "S3_OBJECT_KEY", "s3-key-enabled")
      const acceptedFullKey = yield* attempt("S3", true, "S3_OBJECT_KEY", "s3-key-full", "a".repeat(1_024))
      const rejectedOversizedKey = yield* attempt("S3", true, "S3_OBJECT_KEY", "s3-key-oversized", "a".repeat(1_025))
      const acceptedUtf8Key = yield* attempt("S3", true, "S3_OBJECT_KEY", "s3-key-utf8", "é".repeat(512))
      const rejectedOversizedUtf8Key = yield* attempt(
        "S3",
        true,
        "S3_OBJECT_KEY",
        "s3-key-utf8-oversized",
        "é".repeat(513)
      )
      const rejectedUnknown = yield* attempt("CustomSource", false, "COMMIT_ID", "custom")

      assert.isTrue(Result.isFailure(rejectedKey))
      assert.isTrue(Result.isSuccess(acceptedVersion))
      assert.isTrue(Result.isSuccess(acceptedFullVersion))
      assert.isTrue(Result.isFailure(rejectedOversizedVersion))
      assert.isTrue(Result.isSuccess(acceptedKey))
      assert.isTrue(Result.isSuccess(acceptedFullKey))
      assert.isTrue(Result.isFailure(rejectedOversizedKey))
      assert.isTrue(Result.isSuccess(acceptedUtf8Key))
      assert.isTrue(Result.isFailure(rejectedOversizedUtf8Key))
      assert.isTrue(Result.isFailure(rejectedUnknown))
      assert.strictEqual(yield* Ref.get(mutationCalls), 5)
    }))

  it.effect("binds declared pipeline variables into the reviewed start payload", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const dispatchedVariables = yield* Ref.make<ReadonlyArray<unknown>>([])
      const provider = baseProvider({
        getPipeline: () =>
          Effect.succeed({
            ...pipelineOutput,
            pipeline: {
              ...pipelineOutput.pipeline,
              variables: [{
                name: "Environment",
                defaultValue: "staging",
                description: "Deployment environment"
              }, {
                name: "Target",
                description: "Required release target"
              }]
            }
          }),
        getPipelineExecution: () => Effect.die("pipeline start must not load an existing execution"),
        startPipelineExecution: (request) =>
          Effect.all([
            Ref.update(mutationCalls, (count) => count + 1),
            Ref.set(dispatchedVariables, request.variables)
          ]).pipe(Effect.as({ pipelineExecutionId: "execution-variable-start" }))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const propose = (variables?: ReadonlyArray<{ readonly name: string; readonly value: string }>) =>
            connection.proposeAction(
              Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
                actionKind: "pipeline.start",
                target: {
                  entityType: "pipeline",
                  vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
                },
                expectedRevision: "7:2026-07-16T08:00:00.000Z",
                payload: {
                  sourceRevisions: [{
                    actionName: "Checkout",
                    revisionType: "COMMIT_ID",
                    revisionValue: "commit-abc"
                  }],
                  ...(variables === undefined ? {} : { variables })
                },
                evidenceIds: []
              })
            )
          const missingRequired = yield* propose().pipe(Effect.result)
          const proposal = yield* propose([{ name: "Target", value: "production" }])
          const authorized = Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
            proposal,
            idempotencyKey: "start-with-variables",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-start-with-variables",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          return {
            dispatched: yield* executor.executeAuthorizedAction(authorized),
            missingRequired,
            proposal
          }
        })
      )

      assert.isTrue(Result.isFailure(result.missingRequired))
      if (Result.isFailure(result.missingRequired)) {
        assert.instanceOf(result.missingRequired.failure, PluginConflictFailure)
        if (Predicate.isTagged(result.missingRequired.failure, "PluginConflictFailure")) {
          assert.strictEqual(
            result.missingRequired.failure.diagnosticCode,
            "codepipeline-start-variable-set-invalid"
          )
        }
      }
      const expectedVariables = [
        { name: "Environment", value: "staging" },
        { name: "Target", value: "production" }
      ]
      assert.deepInclude(result.proposal.request.payload, { variables: expectedVariables })
      assert.deepStrictEqual(yield* Ref.get(dispatchedVariables), expectedVariables)
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
      assert.strictEqual(result.dispatched._tag, "confirmed")
    }))

  it.effect("rejects a start target outside the configured pipeline before mutation", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const result = yield* runWithProvider(
        baseProvider({
          getPipelineExecution: () => Effect.die("invalid pipeline target must not load an execution"),
          startPipelineExecution: () =>
            Ref.update(mutationCalls, (count) => count + 1).pipe(
              Effect.as({ pipelineExecutionId: "must-not-start" })
            )
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          return yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.start",
              target: {
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:other"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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

  it.effect("classifies a malformed start response as an unknown mutation outcome", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const provider = baseProvider({
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({})
          )
      })
      const dispatched = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.start",
              target: {
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
            idempotencyKey: "start-release-malformed-response",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-malformed-response",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          return yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(dispatched))
      if (Result.isFailure(dispatched)) {
        assert.instanceOf(dispatched.failure, PluginUnknownOutcomeFailure)
        if (Predicate.isTagged(dispatched.failure, "PluginUnknownOutcomeFailure")) {
          assert.match(dispatched.failure.reconciliationKey ?? "", /^codepipeline:start:/u)
        }
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
    }))

  it.effect("confirms deterministic mutation rejection as a failed no-write receipt", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const rejection = yield* mapCodePipelineAwsFailure(
        "codepipeline-start-execution",
        { _tag: "ValidationException" }
      ).pipe(Effect.flip)
      const provider = baseProvider({
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.andThen(Effect.fail(rejection))
          )
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
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
            idempotencyKey: "start-release-deterministic-rejection",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-deterministic-rejection",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const first = yield* executor.executeAuthorizedAction(authorized)
          const replay = yield* executor.executeAuthorizedAction(authorized)
          return { first, replay }
        })
      )

      assert.deepStrictEqual(result.first, result.replay)
      assert.strictEqual(result.first._tag, "confirmed")
      if (result.first._tag === "confirmed") {
        assert.strictEqual(result.first.receipt.status, "failed")
        assert.include(result.first.receipt.safeSummary, "without applying")
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
    }))

  it.effect("binds non-null reconciliation locators before provider access and permits null started intents", () =>
    Effect.gen(function*() {
      const identityCalls = yield* Ref.make(0)
      const mutationCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getCallerIdentity: () =>
          Ref.update(identityCalls, (count) => count + 1).pipe(
            Effect.as({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test" })
          ),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "execution-reconciled-null-locator" })
          )
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
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
            idempotencyKey: "start-reconciliation-locator",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-reconciliation-locator",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const baselineIdentityCalls = yield* Ref.get(identityCalls)
          const request = {
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          }
          const wrongKind = yield* executor.reconcile({
            ...request,
            reconciliationKey: PluginActionReconciliationKey.make(
              `codepipeline:retry:${authorized.payloadDigest}`
            )
          }).pipe(Effect.result)
          const wrongDigest = yield* executor.reconcile({
            ...request,
            reconciliationKey: PluginActionReconciliationKey.make(
              `codepipeline:start:${"0".repeat(64)}`
            )
          }).pipe(Effect.result)
          const identityCallsAfterInvalid = yield* Ref.get(identityCalls)
          const nullLocator = yield* executor.reconcile({
            ...request,
            reconciliationKey: null
          })
          return {
            baselineIdentityCalls,
            identityCallsAfterInvalid,
            nullLocator,
            wrongDigest,
            wrongKind
          }
        })
      )

      assert.isTrue(Result.isFailure(result.wrongKind))
      assert.isTrue(Result.isFailure(result.wrongDigest))
      assert.strictEqual(result.identityCallsAfterInvalid, result.baselineIdentityCalls)
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
      assert.strictEqual(result.nullLocator._tag, "succeeded")
    }))

  it.effect("rejects ambiguous start reconciliation after the authorized pipeline revision moves", () =>
    Effect.gen(function*() {
      const pipelineVersion = yield* Ref.make(7)
      const mutationCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getPipeline: () =>
          Ref.get(pipelineVersion).pipe(
            Effect.map((version) => ({
              ...pipelineOutput,
              pipeline: { ...pipelineOutput.pipeline, version }
            }))
          ),
        startPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.fail(new PluginTimeoutFailure({ operation: "codepipeline-start-execution" }))
            )
          )
      })
      const reconciliation = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const proposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.start",
              target: {
                entityType: "pipeline",
                vendorImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:release"
              },
              expectedRevision: "7:2026-07-16T08:00:00.000Z",
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
            idempotencyKey: "start-release-stale-reconciliation",
            payloadDigest: proposal.payloadDigest,
            authorizationId: "authorization-stale-reconciliation",
            authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
          })
          const dispatched = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          if (
            Result.isSuccess(dispatched) ||
            !Predicate.isTagged(dispatched.failure, "PluginUnknownOutcomeFailure")
          ) {
            return yield* Effect.die("expected an ambiguous start")
          }
          yield* Ref.set(pipelineVersion, 8)
          return yield* executor.reconcile({
            reconciliationKey: dispatched.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          }).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(reconciliation))
      if (Result.isFailure(reconciliation)) {
        assert.instanceOf(reconciliation.failure, PluginConflictFailure)
        if (Predicate.isTagged(reconciliation.failure, "PluginConflictFailure")) {
          assert.strictEqual(reconciliation.failure.diagnosticCode, "codepipeline-start-target-changed")
        }
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 1)
    }))

  it.effect("enforces exact CodePipeline text limits before authorizing stop and approval actions", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
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
                  token: "approval-token"
                }
              }]
            }]
          }),
        stopPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "execution-1842" })
          ),
        putApprovalResult: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ approvedAt: new Date("2026-07-16T09:10:00.000Z") })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const stopRequest = (reason: string) =>
            connection.proposeAction(
              Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
                actionKind: "pipeline.stop",
                target: {
                  entityType: "pipeline-execution",
                  vendorImmutableId: "execution-1842"
                },
                expectedRevision: "7:InProgress:2026-07-16T09:05:00.000Z",
                payload: { mode: "wait", reason },
                evidenceIds: []
              })
            )
          const approvalRequest = (summary: string) =>
            connection.proposeAction(
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
                  summary
                },
                evidenceIds: []
              })
            )
          return {
            invalidApproval: yield* approvalRequest("a".repeat(513)).pipe(Effect.result),
            invalidStop: yield* stopRequest("s".repeat(201)).pipe(Effect.result),
            validApproval: yield* approvalRequest("a".repeat(512)),
            validStop: yield* stopRequest("s".repeat(200))
          }
        })
      )

      assert.isTrue(Result.isFailure(result.invalidStop))
      assert.isTrue(Result.isFailure(result.invalidApproval))
      assert.include(JSON.stringify(result.validStop.request.payload), "s".repeat(200))
      assert.include(JSON.stringify(result.validApproval.request.payload), "a".repeat(512))
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
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

  it.effect("blocks stop and approval when the authorized pipeline revision advances", () =>
    Effect.gen(function*() {
      const pipelineVersion = yield* Ref.make(7)
      const mutationCalls = yield* Ref.make(0)
      const provider = baseProvider({
        getPipeline: () =>
          Ref.get(pipelineVersion).pipe(
            Effect.map((version) => ({
              ...pipelineOutput,
              pipeline: { ...pipelineOutput.pipeline, version }
            }))
          ),
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
                  token: "approval-token-stable"
                }
              }]
            }]
          }),
        stopPipelineExecution: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ pipelineExecutionId: "execution-1842" })
          ),
        putApprovalResult: () =>
          Ref.update(mutationCalls, (count) => count + 1).pipe(
            Effect.as({ approvedAt: new Date("2026-07-16T09:10:00.000Z") })
          )
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const stopProposal = yield* connection.proposeAction(
            Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
              actionKind: "pipeline.stop",
              target: {
                entityType: "pipeline-execution",
                vendorImmutableId: "execution-1842"
              },
              expectedRevision: "7:InProgress:2026-07-16T09:05:00.000Z",
              payload: { mode: "wait", reason: "Stop after review" },
              evidenceIds: []
            })
          )
          const approvalProposal = yield* connection.proposeAction(
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
                summary: "Approve after review"
              },
              evidenceIds: []
            })
          )
          const authorize = (
            proposal: typeof stopProposal,
            idempotencyKey: string,
            authorizationId: string
          ) =>
            Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
              proposal,
              idempotencyKey,
              payloadDigest: proposal.payloadDigest,
              authorizationId,
              authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
              expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
            })
          const stop = authorize(stopProposal, "stop-pipeline-revision", "authorization-stop-pipeline-revision")
          const approval = authorize(
            approvalProposal,
            "approval-pipeline-revision",
            "authorization-approval-pipeline-revision"
          )
          const unchangedStop = yield* executor.preflight(stop)
          const unchangedApproval = yield* executor.preflight(approval)
          yield* Ref.set(pipelineVersion, 8)
          return {
            advancedApproval: yield* executor.preflight(approval),
            advancedStop: yield* executor.preflight(stop),
            unchangedApproval,
            unchangedStop
          }
        })
      )

      assert.strictEqual(result.unchangedStop._tag, "ready")
      assert.strictEqual(result.unchangedApproval._tag, "ready")
      assert.strictEqual(result.advancedStop._tag, "blocked")
      assert.strictEqual(result.advancedApproval._tag, "blocked")
      assert.strictEqual(yield* Ref.get(mutationCalls), 0)
    }))

  it.effect("starts one distinct retry execution and preserves retry lineage in the receipt", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const revisions = yield* Ref.make<ReadonlyArray<unknown>>([])
      const variables = yield* Ref.make<ReadonlyArray<unknown>>([])
      const provider = baseProvider({
        getPipeline: () =>
          Effect.succeed({
            ...pipelineOutput,
            pipeline: {
              ...pipelineOutput.pipeline,
              variables: [{ name: "Target", description: "Required release target" }]
            }
          }),
        getPipelineExecution: (request) => {
          const output = executionOutput(request.pipelineExecutionId, "Failed")
          return Effect.succeed({
            pipelineExecution: {
              ...output.pipelineExecution,
              variables: [{ name: "Target", resolvedValue: "production" }]
            }
          })
        },
        startPipelineExecution: (request) =>
          Effect.all([
            Ref.update(calls, (count) => count + 1),
            Ref.set(revisions, request.sourceRevisions),
            Ref.set(variables, request.variables)
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
      assert.deepStrictEqual(yield* Ref.get(variables), [{
        name: "Target",
        value: "production"
      }])
      assert.deepInclude(result.proposal.request.payload, {
        variables: [{ name: "Target", value: "production" }]
      })
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

  it.effect("distinguishes pre-dispatch identity failures from ambiguous on-wire failures", () =>
    Effect.gen(function*() {
      const mutationCalls = yield* Ref.make(0)
      const attempt = (
        identity: string,
        failure:
          | CodePipelinePreDispatchFailure
          | CodePipelinePreDispatchTimeoutFailure
          | PluginOutageFailure
          | PluginTimeoutFailure,
        mutationStarted: boolean
      ) =>
        runWithProvider(
          baseProvider({
            getPipelineExecution: (request) =>
              Effect.succeed(executionOutput(request.pipelineExecutionId, "InProgress")),
            stopPipelineExecution: () =>
              (mutationStarted
                ? Ref.update(mutationCalls, (count) => count + 1)
                : Effect.void).pipe(Effect.andThen(Effect.fail(failure)))
          }),
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
            return yield* executor.executeAuthorizedAction(
              Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
                proposal,
                idempotencyKey: `stop-${identity}`,
                payloadDigest: proposal.payloadDigest,
                authorizationId: `authorization-${identity}`,
                authorizedAt: DateTime.makeUnsafe("2026-07-16T09:00:00.000Z"),
                expiresAt: DateTime.makeUnsafe("2026-07-16T10:00:00.000Z")
              })
            ).pipe(Effect.result)
          })
        )

      const beforeDispatch = yield* attempt(
        "credential-timeout",
        new CodePipelinePreDispatchTimeoutFailure({ operation: "codepipeline-stop-execution" }),
        false
      )
      const onWire = yield* attempt(
        "on-wire-timeout",
        new PluginTimeoutFailure({ operation: "codepipeline-stop-execution" }),
        true
      )
      const identityOutage = yield* attempt(
        "identity-outage",
        new CodePipelinePreDispatchFailure({
          operation: "codepipeline-stop-execution",
          diagnosticCode: "codepipeline-runtime-identity-unavailable"
        }),
        false
      )
      const malformedIdentity = yield* attempt(
        "malformed-identity",
        new CodePipelinePreDispatchFailure({
          operation: "codepipeline-stop-execution",
          diagnosticCode: "codepipeline-runtime-identity-invalid"
        }),
        false
      )
      const onWireOutage = yield* attempt(
        "on-wire-outage",
        new PluginOutageFailure({ operation: "codepipeline-stop-execution" }),
        true
      )

      for (const knownNotDispatched of [beforeDispatch, identityOutage, malformedIdentity]) {
        assert.isTrue(Result.isSuccess(knownNotDispatched))
        if (Result.isSuccess(knownNotDispatched)) {
          assert.strictEqual(knownNotDispatched.success._tag, "confirmed")
          if (knownNotDispatched.success._tag === "confirmed") {
            assert.strictEqual(knownNotDispatched.success.receipt.status, "failed")
            assert.match(knownNotDispatched.success.receipt.providerOperationId, /^not-dispatched:stop:/u)
          }
        }
      }
      for (const ambiguous of [onWire, onWireOutage]) {
        assert.isTrue(Result.isFailure(ambiguous))
        if (Result.isFailure(ambiguous)) {
          assert.instanceOf(ambiguous.failure, PluginUnknownOutcomeFailure)
          if (Predicate.isTagged(ambiguous.failure, "PluginUnknownOutcomeFailure")) {
            assert.match(ambiguous.failure.reconciliationKey, /^codepipeline:stop:/u)
          }
        }
      }
      assert.strictEqual(yield* Ref.get(mutationCalls), 2)
    }))

  it.effect("reconciles an ambiguous approval from its exact execution history", () =>
    Effect.gen(function*() {
      const currentState = yield* Ref.make<"pending" | "missing">("pending")
      const historicalState = yield* Ref.make<"InProgress" | "PagedSucceeded">("InProgress")
      const historyCursors = yield* Ref.make<ReadonlyArray<string | null>>([])
      const provider = baseProvider({
        getPipelineExecution: (request) => Effect.succeed(executionOutput(request.pipelineExecutionId, "InProgress")),
        listActionExecutionsPage: (request) =>
          Effect.all([
            Ref.update(historyCursors, (current) => [...current, request.nextToken]),
            Ref.get(historicalState)
          ]).pipe(
            Effect.map(([, status]) => {
              if (status === "PagedSucceeded" && request.nextToken === null) {
                const output = actionOutput(
                  request.pipelineExecutionId,
                  `${request.pipelineExecutionId}-newer-action`,
                  "AfterApproval",
                  "Succeeded"
                )
                return {
                  ...output,
                  nextToken: "approval-history-page-2"
                }
              }
              const output = actionOutput(
                request.pipelineExecutionId,
                `${request.pipelineExecutionId}-approval-1`,
                "ReleaseApproval",
                status === "PagedSucceeded" ? "Succeeded" : status
              )
              return {
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
              }
            })
          ),
        getPipelineState: () =>
          Ref.get(currentState).pipe(
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
                      status: "InProgress",
                      token: "approval-token-a"
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
          const pending = yield* executor.reconcile(reconciliation)
          yield* Ref.set(currentState, "missing")
          yield* Ref.set(historicalState, "PagedSucceeded")
          const succeededFromHistory = yield* executor.reconcile(reconciliation)
          return { pending, succeededFromHistory }
        }),
        { ...configuration, maximumActionsPerExecution: 1 }
      )

      assert.strictEqual(result.pending._tag, "pending")
      assert.strictEqual(result.succeededFromHistory._tag, "succeeded")
      assert.include(yield* Ref.get(historyCursors), "approval-history-page-2")
    }))

  it.effect("revalidates action identity before bounded logs and artifact bytes leave the plugin", () =>
    Effect.gen(function*() {
      const identityArn = yield* Ref.make(
        "arn:aws:sts::123456789012:assumed-role/control-center/connection-session"
      )
      const logCoordinates = yield* Ref.make<ReadonlyArray<readonly [string, string, string]>>([])
      const artifactCoordinates = yield* Ref.make<ReadonlyArray<readonly [string, string, string]>>([])
      const provider = baseProvider({
        getCallerIdentity: () =>
          Ref.get(identityArn).pipe(
            Effect.map((Arn) => ({ Account: "123456789012", Arn }))
          ),
        getLogEventsPage: (request) =>
          Ref.update(logCoordinates, (current) => {
            const coordinates: readonly [string, string, string] = [
              request.account.region,
              request.logGroupName,
              request.logStreamName
            ]
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
            const coordinates: readonly [string, string, string] = [
              request.account.region,
              request.bucket,
              request.key
            ]
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
          yield* Ref.set(
            identityArn,
            "arn:aws:sts::123456789012:assumed-role/control-center/evidence-session"
          )
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
          yield* Ref.set(
            identityArn,
            "arn:aws:sts::123456789012:assumed-role/rotated-control-center/evidence-session"
          )
          const blockedLogs = yield* pipeline.value.readLogPage(
            Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
              action,
              cursor: null,
              limit: 10
            })
          ).pipe(Effect.result)
          const blockedArtifact = yield* pipeline.value.readArtifactRange(
            Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
              action,
              direction: "output",
              artifactName: "BuildOutput",
              offset: 0,
              length: 3
            })
          ).pipe(Effect.result)
          return { artifact, blockedArtifact, blockedLogs, logs }
        })
      )

      assert.deepStrictEqual(yield* Ref.get(logCoordinates), [
        ["eu-west-1", "/aws/codebuild/release", "build"]
      ])
      assert.deepStrictEqual(yield* Ref.get(artifactCoordinates), [
        ["eu-west-1", "artifacts", "build.zip"]
      ])
      assert.strictEqual(result.logs.events[0]?.message, "build completed")
      assert.strictEqual(result.artifact.bytesBase64, "AQID")
      assert.strictEqual(result.artifact.totalBytes, 9)
      assert.isTrue(Result.isFailure(result.blockedLogs))
      assert.isTrue(Result.isFailure(result.blockedArtifact))
      if (Result.isFailure(result.blockedLogs)) {
        assert.instanceOf(result.blockedLogs.failure, PluginConflictFailure)
      }
      if (Result.isFailure(result.blockedArtifact)) {
        assert.instanceOf(result.blockedArtifact.failure, PluginConflictFailure)
      }
      const serialized = JSON.stringify({
        artifact: result.artifact,
        logs: result.logs
      })
      assert.notInclude(serialized, "artifacts")
      assert.notInclude(serialized, "build.zip")
      assert.notInclude(serialized, "arn:aws")
      assert.notInclude(serialized, "https://")
    }))

  it.effect("routes action artifacts through the validated action region", () =>
    Effect.gen(function*() {
      const regions = yield* Ref.make<ReadonlyArray<string>>([])
      const provider = baseProvider({
        listActionExecutionsPage: (request) => {
          const output = actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-action-1`,
            "Compile",
            "Succeeded"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((action) => ({
              ...action,
              input: {
                ...action.input,
                region: "us-west-2"
              }
            }))
          })
        },
        getArtifactRange: (request) =>
          Ref.update(regions, (current) => [...current, request.account.region]).pipe(
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
          if (pipeline === undefined || Option.isNone(pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          return yield* pipeline.value.readArtifactRange(
            Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
              action: {
                entity: {
                  entityType: "aws.codepipeline.action",
                  vendorImmutableId: "execution-1842#execution-1842-action-1"
                },
                executionId: "execution-1842",
                actionExecutionId: "execution-1842-action-1",
                expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
              },
              direction: "output",
              artifactName: "BuildOutput",
              offset: 0,
              length: 3
            })
          )
        })
      )

      assert.strictEqual(result.bytesBase64, "AQID")
      assert.deepStrictEqual(yield* Ref.get(regions), ["us-west-2"])
    }))

  it.effect("rejects ambiguous artifact names before reading provider bytes", () =>
    Effect.gen(function*() {
      const artifactCalls = yield* Ref.make(0)
      const provider = baseProvider({
        listActionExecutionsPage: (request) => {
          const output = actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-action-1`,
            "Compile",
            "Succeeded"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((action) => ({
              ...action,
              output: {
                ...action.output,
                outputArtifacts: [
                  { name: "BuildOutput", s3location: { bucket: "artifacts", key: "build-a.zip" } },
                  { name: "BuildOutput", s3location: { bucket: "artifacts", key: "build-b.zip" } }
                ]
              }
            }))
          })
        },
        getArtifactRange: () =>
          Ref.update(artifactCalls, (count) => count + 1).pipe(
            Effect.as({
              bytes: Uint8Array.from([1, 2, 3]),
              contentLength: 3,
              contentRange: "bytes 0-2/3"
            })
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
          return yield* pipeline.value.readArtifactRange(
            Schema.decodeUnknownSync(PluginPipelineArtifactRangeRequestV1)({
              action: {
                entity: {
                  entityType: "aws.codepipeline.action",
                  vendorImmutableId: "execution-1842#execution-1842-action-1"
                },
                executionId: "execution-1842",
                actionExecutionId: "execution-1842-action-1",
                expectedRevision: "Succeeded:2026-07-16T09:04:00.000Z"
              },
              direction: "output",
              artifactName: "BuildOutput",
              offset: 0,
              length: 3
            })
          )
        })
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginMalformedResponseFailure)
        if (Predicate.isTagged(result.failure, "PluginMalformedResponseFailure")) {
          assert.strictEqual(result.failure.diagnosticCode, "codepipeline-artifact-name-ambiguous")
        }
      }
      assert.strictEqual(yield* Ref.get(artifactCalls), 0)
    }))

  it.effect("routes action logs to the validated action ARN region", () =>
    Effect.gen(function*() {
      const regions = yield* Ref.make<ReadonlyArray<string>>([])
      const provider = baseProvider({
        listActionExecutionsPage: (request) => {
          const output = actionOutput(
            request.pipelineExecutionId,
            `${request.pipelineExecutionId}-action-1`,
            "Compile",
            "Succeeded"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((action) => ({
              ...action,
              input: {
                ...action.input,
                region: "us-east-1"
              },
              output: {
                ...action.output,
                executionResult: {
                  ...action.output.executionResult,
                  logStreamARN: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/codebuild/release:log-stream:build"
                }
              }
            }))
          })
        },
        getLogEventsPage: (request) =>
          Ref.update(regions, (current) => [...current, request.account.region]).pipe(
            Effect.as({ events: [] })
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
      )

      assert.deepStrictEqual(result.events, [])
      assert.deepStrictEqual(yield* Ref.get(regions), ["us-east-1"])
    }))

  it.effect("rejects a log ARN that disagrees with the action region before provider access", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0)
      const provider = baseProvider({
        listActionExecutionsPage: (providerRequest) => {
          const output = actionOutput(
            providerRequest.pipelineExecutionId,
            `${providerRequest.pipelineExecutionId}-action-1`,
            "Compile",
            "Succeeded"
          )
          return Effect.succeed({
            ...output,
            actionExecutionDetails: output.actionExecutionDetails.map((action) => ({
              ...action,
              output: {
                ...action.output,
                executionResult: {
                  ...action.output.executionResult,
                  logStreamARN: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/codebuild/release:log-stream:build"
                }
              }
            }))
          })
        },
        getLogEventsPage: () => Ref.update(providerCalls, (count) => count + 1).pipe(Effect.as({ events: [] }))
      })
      const result = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const pipeline = connection.pipeline
          if (pipeline === undefined || Option.isNone(pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          const request = Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
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
          return yield* pipeline.value.readLogPage(request).pipe(Effect.result)
        })
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, PluginConflictFailure)
        if (Predicate.isTagged(result.failure, "PluginConflictFailure")) {
          assert.strictEqual(result.failure.diagnosticCode, "codepipeline-log-stream-unavailable")
        }
      }
      assert.strictEqual(yield* Ref.get(providerCalls), 0)
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

  it.effect("paginates an oversized provider log page without dropping events", () =>
    Effect.gen(function*() {
      const providerCursors = yield* Ref.make<ReadonlyArray<string | null>>([])
      const providerLimits = yield* Ref.make<ReadonlyArray<number>>([])
      const provider = baseProvider({
        getLogEventsPage: (request) =>
          Effect.all([
            Ref.update(providerCursors, (current) => [...current, request.nextToken]),
            Ref.update(providerLimits, (current) => [...current, request.limit])
          ]).pipe(
            Effect.as({
              events: [
                { timestamp: 1, message: "éé" },
                { timestamp: 2, message: "öö" }
              ].slice(0, request.limit)
            })
          )
      })
      const request = Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
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
        limit: 2
      })
      const paginated = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const pipeline = connection.pipeline
          if (pipeline === undefined || Option.isNone(pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          const first = yield* pipeline.value.readLogPage(request)
          if (first.nextCursor === null) return yield* Effect.die("expected an intra-page cursor")
          const second = yield* pipeline.value.readLogPage({
            ...request,
            cursor: first.nextCursor,
            limit: 1
          })
          return { first, second }
        }),
        { ...configuration, maximumLogBytes: 4 }
      )
      const exact = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const pipeline = connection.pipeline
          if (pipeline === undefined || Option.isNone(pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          return yield* pipeline.value.readLogPage(request)
        }),
        { ...configuration, maximumLogBytes: 8 }
      )
      const oversizedSingle = yield* runWithProvider(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const pipeline = connection.pipeline
          if (pipeline === undefined || Option.isNone(pipeline)) {
            return yield* Effect.die("pipeline reader missing")
          }
          return yield* pipeline.value.readLogPage(request)
        }),
        { ...configuration, maximumLogBytes: 3 }
      ).pipe(Effect.result)

      assert.deepStrictEqual(paginated.first.events.map(({ message }) => message), ["éé"])
      assert.deepStrictEqual(paginated.second.events.map(({ message }) => message), ["öö"])
      assert.strictEqual(paginated.second.nextCursor, null)
      assert.deepStrictEqual(exact.events.map(({ message }) => message), ["éé", "öö"])
      assert.strictEqual(exact.nextCursor, null)
      assert.isTrue(Result.isFailure(oversizedSingle))
      if (Result.isFailure(oversizedSingle)) {
        assert.instanceOf(oversizedSingle.failure, PluginMalformedResponseFailure)
      }
      assert.deepStrictEqual(yield* Ref.get(providerCursors), [null, null, null, null])
      assert.deepStrictEqual(yield* Ref.get(providerLimits), [100, 100, 100, 100])
    }))

  it.effect("accepts UTF-8 log events up to the configured and absolute byte ceilings", () =>
    Effect.gen(function*() {
      const request = Schema.decodeUnknownSync(PluginPipelineLogPageRequestV1)({
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
        limit: 1
      })
      const read = (message: string, maximumLogBytes: number) =>
        runWithProvider(
          baseProvider({
            getLogEventsPage: () => Effect.succeed({ events: [{ timestamp: 1, message }] })
          }),
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const pipeline = connection.pipeline
            if (pipeline === undefined || Option.isNone(pipeline)) {
              return yield* Effect.die("pipeline reader missing")
            }
            return yield* pipeline.value.readLogPage(request)
          }),
          { ...configuration, maximumLogBytes }
        )

      const previousBoundary = "x".repeat(16_384)
      const largeAscii = "x".repeat(20 * 1024)
      const largeMultibyte = "é".repeat(10 * 1024)
      const valid = yield* Effect.all([
        read(previousBoundary, 32 * 1024),
        read(largeAscii, 32 * 1024),
        read(largeMultibyte, 32 * 1024)
      ])
      const aboveConfigured = yield* read("x".repeat(32 * 1024 + 1), 32 * 1024).pipe(Effect.result)
      const aboveProvider = yield* read("x".repeat(1024 * 1024 + 1), 1024 * 1024).pipe(Effect.result)

      assert.deepStrictEqual(valid.map(({ events }) => events[0]?.message.length), [
        previousBoundary.length,
        largeAscii.length,
        largeMultibyte.length
      ])
      assert.isTrue(Result.isFailure(aboveConfigured))
      if (Result.isFailure(aboveConfigured)) {
        assert.instanceOf(aboveConfigured.failure, PluginMalformedResponseFailure)
        assert.strictEqual(
          aboveConfigured.failure.diagnosticCode,
          "codepipeline-log-event-byte-bound-exceeded"
        )
      }
      assert.isTrue(Result.isFailure(aboveProvider))
      if (Result.isFailure(aboveProvider)) {
        assert.instanceOf(aboveProvider.failure, PluginMalformedResponseFailure)
      }
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
