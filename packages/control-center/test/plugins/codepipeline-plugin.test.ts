import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { PluginSyncRequestV1, ReadPluginEntityRequestV1 } from "../../src/domain/plugins/index.js"
import {
  CodePipelinePluginConfiguration,
  codePipelinePluginDefinition
} from "../../src/server/plugins/codepipeline/CodePipelinePluginDefinition.js"
import { CodePipelineReadClient } from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import {
  codePipelineCredentialProviderOptions,
  CodePipelineReadProvider,
  type CodePipelineReadProviderService,
  mapCodePipelineAwsFailure
} from "../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"
import {
  PluginAuthenticationFailure,
  PluginConfigurationFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginTimeoutFailure
} from "../../src/server/plugins/failures.js"
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
        logStreamARN: "arn:aws:logs:eu-west-1:123456789012:log-stream:build"
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
  ...overrides
})

const runWithProvider = <Value, Error>(
  provider: CodePipelineReadProviderService,
  effect: Effect.Effect<Value, Error, PluginConnection>,
  adapterConfiguration: unknown = configuration
) =>
  effect.pipe(
    Effect.provide(
      buildPluginDefinitionLayer(codePipelinePluginDefinition, adapterConfiguration).pipe(
        Layer.provide(
          CodePipelineReadClient.layer.pipe(
            Layer.provide(Layer.succeed(CodePipelineReadProvider, provider))
          )
        )
      )
    ),
    Effect.scoped
  )

describe("CodePipelinePlugin", () => {
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

  it("keeps default and named AWS profiles explicit for credential acquisition", () => {
    assert.deepStrictEqual(codePipelineCredentialProviderOptions("default"), { profile: "default" })
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

      assert.instanceOf(requestTimeout, PluginTimeoutFailure)
      assert.instanceOf(requestExpired, PluginTimeoutFailure)
      assert.instanceOf(outage, PluginOutageFailure)
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
