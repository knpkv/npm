import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AwsClientConfig from "@knpkv/codecommit-core/AwsClientConfig.js"
import { expect, test } from "@playwright/test"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import { ReadPluginEntityRequestV1 } from "../../src/domain/plugins/events.js"
import { codeCommitPluginDefinition } from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import { CodePipelineReadClient } from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import { CodePipelineReadProvider } from "../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"
import { codeCommitClientsLayer } from "../../src/server/plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { buildPluginDefinitionLayer } from "../../src/server/plugins/PluginDefinition.js"
import { awsErrorResponse } from "./fakeProviders/awsErrors.js"
import { makeCodePipelineProvider } from "./fakeProviders/codepipeline.js"
import { makeFakeProviders } from "./fakeProviders/transport.js"

/** No browser or server: real CodeCommit XML/JSON decoding and both plugin classifiers must recognize AWS errors. */
test("AWS credential wire shapes classify as authentication for both providers", async () => {
  const providers = makeFakeProviders()
  const awsConfiguration = AwsClientConfig.layer({
    credentialProvider: () => Promise.resolve({ accessKeyId: "FIXTUREA", secretAccessKey: "fixture-invalid-secret" }),
    maxRetries: 0
  })
  const codeCommit = buildPluginDefinitionLayer(codeCommitPluginDefinition, {
    profile: "fixture-aws-a",
    region: "us-east-1",
    repositoryName: "fixture-checkout"
  }).pipe(
    Layer.provide(Layer.merge(codeCommitClientsLayer(providers.client, awsConfiguration), NodeServices.layer)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, providers.client))
  )
  const pipeline = CodePipelineReadClient.layer.pipe(
    Layer.provide(Layer.succeed(CodePipelineReadProvider, makeCodePipelineProvider(providers).service))
  )
  await Effect.runPromise(
    Effect.gen(function*() {
      const connection = yield* PluginConnection
      const pipelineClient = yield* CodePipelineReadClient
      for (
        const scenario of ["401", "expired-token", "invalid-signature"] satisfies ReadonlyArray<
          "401" | "expired-token" | "invalid-signature"
        >
      ) {
        const wire = awsErrorResponse(scenario)
        expect(wire?.status).toBe(scenario === "invalid-signature" ? 403 : 400)
        expect(wire?.headers["x-amzn-errortype"]).toBe(wire?.json.__type)
        providers.setScenario("codecommit", "FIXTUREA", scenario)
        providers.setScenario("codepipeline", "FIXTUREA", scenario)
        const health = yield* Effect.result(connection.health)
        const entity = yield* Effect.result(connection.readEntity(
          Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({ entityType: "pull-request", vendorImmutableId: "1" })
        ))
        const pipelineHealth = yield* Effect.result(pipelineClient.discoverAccount({
          profile: "fixture-aws-a",
          region: "us-east-1",
          operationTimeoutMillis: 5000
        }))
        for (const result of [health, entity, pipelineHealth]) {
          expect(result, scenario).toMatchObject({ _tag: "Failure", failure: { _tag: "PluginAuthenticationFailure" } })
        }
      }
      expect(providers.unhandled()).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(codeCommit, pipeline)))
  )
})
