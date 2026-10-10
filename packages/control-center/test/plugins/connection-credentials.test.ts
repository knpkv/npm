import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { ReadClient, ReviewClient } from "@knpkv/codecommit-core"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { Base64 } from "effect/encoding"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { PluginConnectionId } from "../../src/domain/identifiers.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfiguration } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { clockifyReadPluginDescriptor } from "../../src/server/plugins/clockify/ClockifyReadPlugin.js"
import { codeCommitPluginDescriptor } from "../../src/server/plugins/codecommit/CodeCommitPluginDefinition.js"
import { codePipelinePluginDescriptor } from "../../src/server/plugins/codepipeline/CodePipelinePluginDefinition.js"
import {
  CodePipelinePipeline,
  CodePipelineReadClient
} from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import { confluencePagePluginDescriptor } from "../../src/server/plugins/confluence/ConfluencePagePluginDefinition.js"
import { makeFirstPartyPluginRuntimeRegistry } from "../../src/server/plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { pluginRuntimeAuthoritySourceLayer } from "../../src/server/plugins/internal/PluginRuntimeAuthorityRepository.js"
import { jiraReadPluginDescriptor } from "../../src/server/plugins/jira/JiraReadPlugin.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { PluginConnectionMap } from "../../src/server/plugins/PluginConnectionMap.js"
import {
  firstPartyPluginConnectionMapLayer,
  firstPartyPluginRuntimeLayers
} from "../../src/server/runtime/FirstPartyPluginRuntime.js"
import { SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import { fixtureTimestamps, fixtureWorkspaceIds, makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = fixtureWorkspaceIds.alpha
const FIRST_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000091")
const SECOND_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000092")
const THIRD_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000093")
const CREATED_AT = fixtureTimestamps.created

describe("connection credentials", () => {
  it.layer(NodeServices.layer)((it) => {
    for (const providerId of ["codecommit", "codepipeline"] satisfies ReadonlyArray<"codecommit" | "codepipeline">) {
      it.effect(`${providerId} forwards each connection's AWS profile and region`, () =>
        Effect.gen(function*() {
          yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
          const config = yield* makePersistenceTestConfig("control-center-aws-connection-credentials-")
          const root = config.blobRoot.slice(0, -"/blobs".length)
          const observed: Array<{ readonly profile: string; readonly region: string }> = []
          const observe = (account: { readonly profile: string; readonly region: string }) =>
            Effect.sync(() => {
              observed.push({ profile: account.profile, region: account.region })
              return { accountId: "123456789012", arn: `arn:aws:iam::123456789012:role/${account.profile}` }
            })
          const clients = Layer.merge(
            Layer.mock(ReadClient.CodeCommitReadClient, {
              discoverAccount: (account) =>
                observe(account).pipe(Effect.map((identity) => new ReadClient.CodeCommitAccountIdentity(identity))),
              listPullRequestsPage: ({ account }) =>
                observe(account).pipe(
                  Effect.as(new ReadClient.CodeCommitPullRequestPage({ pullRequests: [], nextToken: null }))
                )
            }),
            Layer.mock(ReviewClient.CodeCommitReviewClient, {})
          )
          const pipelineContext = yield* Layer.build(Layer.mock(CodePipelineReadClient, {
            discoverAccount: observe,
            getPipeline: ({ account, pipelineName }) =>
              observe(account).pipe(Effect.as(
                Schema.decodeUnknownSync(CodePipelinePipeline)({
                  name: pipelineName,
                  version: 1,
                  pipelineType: "V1",
                  executionMode: "SUPERSEDED",
                  stages: [],
                  arn: `arn:aws:codepipeline:${account.region}:123456789012:${pipelineName}`,
                  createdAt: null,
                  updatedAt: null,
                  variables: []
                })
              ))
          }))
          const registry = makeFirstPartyPluginRuntimeRegistry(
            clients,
            Context.get(pipelineContext, CodePipelineReadClient)
          ).pipe(
            Layer.provide(pluginRuntimeAuthoritySourceLayer)
          )
          const runtime = firstPartyPluginRuntimeLayers(registry)
          const database = databaseLayer(config)
          const dependencies = Layer.mergeAll(
            persistenceLayerFromDatabase(config).pipe(Layer.provide(database)),
            QuarantineRepository.layer.pipe(Layer.provideMerge(database)),
            SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
            Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unexpected HTTP request")))
          )
          yield* Effect.gen(function*() {
            const persistence = yield* Persistence
            const connections = yield* PluginConnectionMap
            yield* persistence.workspaces.create(WORKSPACE_ID, {
              displayName: WorkspaceName.make("Fixture workspace"),
              createdAt: CREATED_AT
            })
            for (
              const [id, profile, region] of [
                [FIRST_ID, "first-profile", "eu-west-1"],
                [SECOND_ID, "second-profile", "us-east-1"]
              ] satisfies ReadonlyArray<readonly [PluginConnectionId, string, string]>
            ) {
              yield* persistence.pluginConnections.create(WORKSPACE_ID, {
                pluginConnectionId: id,
                providerId,
                displayName: PluginConnectionDisplayName.make("Fixture AWS connection"),
                isEnabled: true,
                createdAt: CREATED_AT
              })
              const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
                { _tag: "text", key: "profile", value: profile },
                { _tag: "text", key: "region", value: region },
                ...(providerId === "codecommit" ?
                  [
                    { _tag: "text", key: "repositoryName", value: "fixture-repository" }
                  ] :
                  [
                    { _tag: "integer", key: "actionPageSize", value: 20 },
                    { _tag: "integer", key: "maximumActionPages", value: 2 },
                    { _tag: "integer", key: "maximumActionsPerExecution", value: 20 },
                    { _tag: "integer", key: "maximumExecutionPages", value: 2 },
                    { _tag: "integer", key: "maximumLogBytes", value: 32768 },
                    { _tag: "integer", key: "operationTimeoutMillis", value: 5000 },
                    { _tag: "text", key: "pipelineName", value: "fixture-pipeline" }
                  ])
              ].sort((left, right) => left.key.localeCompare(right.key)))
              yield* persistence.pluginConfigurations.update(WORKSPACE_ID, id, configuration, 0, CREATED_AT)
              yield* persistence.pluginRuntime.acceptPluginDescriptor(
                WORKSPACE_ID,
                id,
                providerId,
                providerId === "codecommit" ? codeCommitPluginDescriptor : codePipelinePluginDescriptor,
                0,
                CREATED_AT
              )
              const start = observed.length
              const context = yield* connections.contextEffect({ workspaceId: WORKSPACE_ID, pluginConnectionId: id })
              yield* Context.get(context, PluginConnection).health
              assert.isAbove(observed.length, start)
              assert.deepStrictEqual(observed.slice(start), observed.slice(start).map(() => ({ profile, region })))
            }
          }).pipe(Effect.provideContext(yield* Layer.build(runtime.connections.pipe(Layer.provideMerge(dependencies)))))
        }).pipe(Effect.scoped))
    }

    const providers: ReadonlyArray<"jira" | "confluence" | "clockify"> = ["jira", "confluence", "clockify"]
    for (const providerId of providers) {
      it.effect(`${providerId} keeps each connection's credentials and rejects an invalid token`, () =>
        Effect.gen(function*() {
          yield* TestClock.setTime(DateTime.toEpochMillis(CREATED_AT))
          const config = yield* makePersistenceTestConfig("control-center-connection-credentials-")
          const root = config.blobRoot.slice(0, -"/blobs".length)
          const requests: Array<HttpClientRequest.HttpClientRequest> = []
          const header = providerId === "clockify" ? "x-api-key" : "authorization"
          const credential = (token: string) =>
            providerId === "clockify"
              ? token
              : `Basic ${Base64.encode(`owner@example.com:${token}`)}`
          // Only the transport is fake; registry, persistence, secrets, generated clients and cache are real.
          const transport = HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request)
              const rejected = request.headers[header] === credential("invalid-token")
              const body = rejected
                ? { message: "Unauthorized" }
                : providerId === "jira"
                ? { accountId: "account-1", displayName: "Fixture account", active: true }
                : providerId === "confluence"
                ? {
                  id: "page-1",
                  title: "Probe",
                  status: "current",
                  spaceId: "space-1",
                  createdAt: "2026-07-13T10:00:00.000Z",
                  version: { number: 1, createdAt: "2026-07-13T10:00:00.000Z", authorId: "account-1" },
                  body: { atlas_doc_format: { value: "{\"type\":\"doc\",\"version\":1,\"content\":[]}" } }
                }
                : request.url.endsWith("/v1/user")
                ? { id: "user-1", name: "Fixture account", email: "owner@example.com", status: "ACTIVE" }
                : [{ id: "workspace-1", name: "Fixture workspace" }]
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(body), {
                  status: rejected ? 401 : 200,
                  headers: { "content-type": "application/json" }
                })
              )
            })
          )
          const database = databaseLayer(config)
          const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
          const dependencies = Layer.mergeAll(
            persistenceLayerFromDatabase(config).pipe(Layer.provide(database)),
            foundation,
            SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
            Layer.succeed(HttpClient.HttpClient, transport)
          )
          yield* Effect.gen(function*() {
            const persistence = yield* Persistence
            const secrets = yield* SecretStore
            const connections = yield* PluginConnectionMap
            yield* persistence.workspaces.create(WORKSPACE_ID, {
              displayName: WorkspaceName.make("Fixture workspace"),
              createdAt: CREATED_AT
            })
            const cases = [
              { id: FIRST_ID, token: "first-token" },
              { id: SECOND_ID, token: "invalid-token" },
              { id: THIRD_ID, token: "second-token" }
            ]
            for (const { id, token } of cases) {
              const ref = yield* secrets.create(new TextEncoder().encode(token))
              yield* persistence.pluginConnections.create(WORKSPACE_ID, {
                pluginConnectionId: id,
                providerId,
                displayName: PluginConnectionDisplayName.make("Fixture connection"),
                isEnabled: true,
                createdAt: CREATED_AT
              })
              const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
                (providerId === "clockify"
                  ? [
                    { _tag: "secret-reference", key: "apiKey", ref },
                    { _tag: "integer", key: "maximumConcurrency", value: 1 },
                    { _tag: "integer", key: "maximumPages", value: 3 },
                    { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                    { _tag: "integer", key: "pageSize", value: 10 },
                    { _tag: "text", key: "userIds", value: "user-1" },
                    { _tag: "url", key: "webBaseUrl", value: "https://app.clockify.me/" },
                    { _tag: "text", key: "workspaceId", value: "workspace-1" }
                  ]
                  : [
                    { _tag: "secret-reference", key: "apiToken", ref },
                    { _tag: "text", key: "authMode", value: "api-token" },
                    { _tag: "text", key: "email", value: "owner@example.com" },
                    { _tag: "text", key: "siteId", value: "cloud-1" },
                    ...(providerId === "jira" ?
                      [
                        { _tag: "integer", key: "maximumPages", value: 3 },
                        { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                        { _tag: "integer", key: "pageSize", value: 10 },
                        { _tag: "text", key: "projectId", value: "project-1" },
                        { _tag: "url", key: "webBaseUrl", value: "https://fixture.atlassian.net/" }
                      ] :
                      [
                        { _tag: "text", key: "probePageId", value: "page-1" },
                        { _tag: "text", key: "spaceId", value: "space-1" },
                        { _tag: "url", key: "siteBaseUrl", value: "https://fixture.atlassian.net/" }
                      ])
                  ]).sort((left, right) => left.key.localeCompare(right.key))
              )
              yield* persistence.pluginConfigurations.update(WORKSPACE_ID, id, configuration, 0, CREATED_AT)
              yield* persistence.pluginRuntime.acceptPluginDescriptor(
                WORKSPACE_ID,
                id,
                providerId,
                providerId === "jira" ?
                  jiraReadPluginDescriptor
                  : providerId === "confluence"
                  ? confluencePagePluginDescriptor
                  : clockifyReadPluginDescriptor,
                0,
                CREATED_AT
              )
            }
            for (const { id, token } of cases) {
              const context = yield* connections.contextEffect({ workspaceId: WORKSPACE_ID, pluginConnectionId: id })
              const connection = Context.get(context, PluginConnection)
              const start = requests.length
              const outcome = yield* connection.health.pipe(Effect.result)
              assert.isAbove(requests.length, start)
              assert.deepStrictEqual(
                requests.slice(start).map((request) => request.headers[header]),
                requests.slice(start).map(() => credential(token)),
                `connection test returned ${outcome._tag}`
              )
              if (token === "invalid-token") {
                assert.strictEqual(outcome._tag, "Failure")
                if (outcome._tag === "Failure") assert.strictEqual(outcome.failure._tag, "PluginAuthenticationFailure")
              } else {
                assert.strictEqual(outcome._tag, "Success")
                if (outcome._tag === "Success") assert.strictEqual(outcome.success._tag, "healthy")
              }
              const cached = yield* connections.contextEffect({ workspaceId: WORKSPACE_ID, pluginConnectionId: id })
              assert.strictEqual(Context.get(cached, PluginConnection), connection)
            }
            const previous = yield* connections.contextEffect({
              workspaceId: WORKSPACE_ID,
              pluginConnectionId: FIRST_ID
            })
            const stored = yield* persistence.pluginConfigurations.get(WORKSPACE_ID, FIRST_ID)
            if (Option.isNone(stored)) return yield* Effect.die("fixture configuration missing")
            const rotatedRef = yield* secrets.create(new TextEncoder().encode("rotated-token"))
            const rotatedConfiguration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
              stored.value.values.map((value) =>
                value._tag === "secret-reference" ? { ...value, ref: rotatedRef } : value
              )
            )
            yield* persistence.pluginConfigurations.update(
              WORKSPACE_ID,
              FIRST_ID,
              rotatedConfiguration,
              stored.value.revision,
              CREATED_AT
            )
            yield* connections.invalidate({ workspaceId: WORKSPACE_ID, pluginConnectionId: FIRST_ID })
            const rebuilt = yield* connections.contextEffect({
              workspaceId: WORKSPACE_ID,
              pluginConnectionId: FIRST_ID
            })
            assert.notStrictEqual(Context.get(rebuilt, PluginConnection), Context.get(previous, PluginConnection))
            const start = requests.length
            yield* Context.get(rebuilt, PluginConnection).health
            assert.deepStrictEqual(
              requests.slice(start).map((request) => request.headers[header]),
              requests.slice(start).map(() => credential("rotated-token"))
            )
          }).pipe(
            Effect.provideContext(
              yield* Layer.build(firstPartyPluginConnectionMapLayer.pipe(Layer.provideMerge(dependencies)))
            )
          )
        }).pipe(Effect.scoped))
    }
  })
})
