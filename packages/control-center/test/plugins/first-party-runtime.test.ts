import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import {
  PluginConnectionDisplayName,
  RecordRevision,
  WorkspaceName
} from "../../src/server/persistence/repositories/models.js"
import { StoredPluginConfiguration } from "../../src/server/persistence/repositories/pluginConfigurationModels.js"
import { clockifyReadPluginDescriptor } from "../../src/server/plugins/clockify/ClockifyReadPlugin.js"
import { confluencePagePluginDescriptor } from "../../src/server/plugins/confluence/ConfluencePagePluginDefinition.js"
import { jiraReadPluginDescriptor } from "../../src/server/plugins/jira/JiraReadPlugin.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { PluginConnectionMap } from "../../src/server/plugins/PluginConnectionMap.js"
import { firstPartyPluginConnectionMapLayer } from "../../src/server/runtime/FirstPartyPluginRuntime.js"
import { SecretRef } from "../../src/server/secrets/SecretRef.js"
import { SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000081")
const OTHER_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000082")
const CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000083")
const UNCONFIGURED_CONNECTION_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000084")
const CREATED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-18T10:00:00.000Z")

const fakeClockifyClient = (
  requests: Array<HttpClientRequest.HttpClientRequest>
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)
      const body = request.url.endsWith("/v1/user")
        ? { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", status: "ACTIVE" }
        : [{ id: "clockify-workspace", name: "Delivery" }]
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    })
  )

describe("first-party plugin runtime", () => {
  it.effect("rejects non-tenant Atlassian origins before credentials or HTTP are used", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-first-party-atlassian-origin-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        SecretStore.layer({ secretRoot: SecretRoot.make(`${root}/secrets`) }),
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        const cases: ReadonlyArray<{
          readonly providerId: "jira" | "confluence"
          readonly webBaseUrl: string
        }> = [
          { providerId: "jira", webBaseUrl: "http://acme.atlassian.net" },
          { providerId: "jira", webBaseUrl: "https://localhost" },
          { providerId: "jira", webBaseUrl: "https://collector.example" },
          { providerId: "confluence", webBaseUrl: "http://acme.atlassian.net" },
          { providerId: "confluence", webBaseUrl: "https://localhost" },
          { providerId: "confluence", webBaseUrl: "https://collector.example" }
        ]

        for (const [index, invalid] of cases.entries()) {
          const missingSecretRef = SecretRef.make(`secret_${index.toString(16).repeat(64)}`)
          const pluginConnectionId = PluginConnectionId.make(
            `01890f6f-6d6a-7cc0-98d2-${(100 + index).toString().padStart(12, "0")}`
          )
          yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
            pluginConnectionId,
            providerId: invalid.providerId,
            displayName: PluginConnectionDisplayName.make(`Invalid ${invalid.providerId} ${index}`),
            isEnabled: true,
            createdAt: CREATED_AT
          })
          const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)(
            invalid.providerId === "jira"
              ? [
                { _tag: "secret-reference", key: "apiToken", ref: missingSecretRef },
                { _tag: "text", key: "email", value: "owner@example.com" },
                { _tag: "integer", key: "maximumPages", value: 3 },
                { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
                { _tag: "integer", key: "pageSize", value: 10 },
                { _tag: "url", key: "webBaseUrl", value: invalid.webBaseUrl }
              ]
              : [
                { _tag: "secret-reference", key: "apiToken", ref: missingSecretRef },
                { _tag: "text", key: "email", value: "owner@example.com" },
                { _tag: "text", key: "probePageId", value: "page-1" },
                { _tag: "url", key: "siteBaseUrl", value: invalid.webBaseUrl },
                { _tag: "text", key: "siteId", value: "site-1" },
                { _tag: "text", key: "spaceId", value: "space-1" }
              ]
          )
          yield* persistenceService.pluginConfigurations.update(
            WORKSPACE_ID,
            pluginConnectionId,
            configuration,
            0,
            CREATED_AT
          )
          yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
            WORKSPACE_ID,
            pluginConnectionId,
            invalid.providerId,
            invalid.providerId === "jira" ? jiraReadPluginDescriptor : confluencePagePluginDescriptor,
            0,
            CREATED_AT
          )

          const connections = yield* PluginConnectionMap
          const outcome = yield* Effect.result(connections.contextEffect({
            workspaceId: WORKSPACE_ID,
            pluginConnectionId
          }))
          assert.strictEqual(outcome._tag, "Failure")
          if (outcome._tag === "Failure") {
            assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
            if (outcome.failure._tag === "PluginConfigurationFailure") {
              assert.strictEqual(outcome.failure.diagnosticCode, "plugin-configuration-schema-invalid")
            }
          }
        }
        assert.lengthOf(requests, 0)
      }).pipe(
        Effect.provide(firstPartyPluginConnectionMapLayer),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("loads persisted Clockify authority, reuses its cache, and discovers the exact identity", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-first-party-runtime-")
      const root = config.blobRoot.slice(0, -"/blobs".length)
      const secretRoot = SecretRoot.make(`${root}/secrets`)
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provide(database))
      const secrets = SecretStore.layer({ secretRoot })
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const dependencies = Layer.mergeAll(
        persistence,
        secrets,
        Layer.succeed(HttpClient.HttpClient, fakeClockifyClient(requests))
      )

      yield* Effect.gen(function*() {
        const persistenceService = yield* Persistence
        const secretStore = yield* SecretStore
        yield* persistenceService.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Delivery"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.workspaces.create(OTHER_WORKSPACE_ID, {
          displayName: WorkspaceName.make("Other"),
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: CONNECTION_ID,
          providerId: "clockify",
          displayName: PluginConnectionDisplayName.make("Delivery Clockify"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        yield* persistenceService.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: UNCONFIGURED_CONNECTION_ID,
          providerId: "clockify",
          displayName: PluginConnectionDisplayName.make("Unconfigured Clockify"),
          isEnabled: true,
          createdAt: CREATED_AT
        })
        const apiKeyRef = yield* secretStore.create(new TextEncoder().encode("clockify-secret"))
        const configuration = yield* Schema.decodeUnknownEffect(StoredPluginConfiguration)([
          { _tag: "secret-reference", key: "apiKey", ref: apiKeyRef },
          { _tag: "integer", key: "maximumConcurrency", value: 2 },
          { _tag: "integer", key: "maximumPages", value: 3 },
          { _tag: "integer", key: "operationTimeoutMillis", value: 5_000 },
          { _tag: "integer", key: "pageSize", value: 10 },
          { _tag: "text", key: "userIds", value: "user-1" },
          { _tag: "url", key: "webBaseUrl", value: "https://app.clockify.me" },
          { _tag: "text", key: "workspaceId", value: "clockify-workspace" }
        ])
        yield* persistenceService.pluginConfigurations.update(
          WORKSPACE_ID,
          CONNECTION_ID,
          configuration,
          0,
          CREATED_AT
        )
        yield* persistenceService.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          CONNECTION_ID,
          "clockify",
          clockifyReadPluginDescriptor,
          0,
          CREATED_AT
        )

        const connections = yield* PluginConnectionMap
        const scope = { workspaceId: WORKSPACE_ID, pluginConnectionId: CONNECTION_ID }
        const firstContext = yield* connections.contextEffect(scope)
        const secondContext = yield* connections.contextEffect(scope)
        const first = Context.get(firstContext, PluginConnection)
        const second = Context.get(secondContext, PluginConnection)
        assert.strictEqual(first, second)

        const discovery = yield* first.discover
        assert.deepStrictEqual(discovery.account, {
          providerImmutableId: "user-1",
          displayName: "Ada Lovelace"
        })
        assert.deepStrictEqual(discovery.workspace, {
          providerImmutableId: "clockify-workspace",
          displayName: "Delivery"
        })
        assert.strictEqual(requests.length, 2)
        assert.isTrue(requests.every(({ headers }) => headers["x-api-key"] === "clockify-secret"))

        const isolated = yield* Effect.result(connections.contextEffect({
          workspaceId: OTHER_WORKSPACE_ID,
          pluginConnectionId: CONNECTION_ID
        }))
        assert.strictEqual(isolated._tag, "Failure")
        assert.strictEqual(requests.length, 2)

        const missingConfiguration = yield* Effect.result(connections.contextEffect({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: UNCONFIGURED_CONNECTION_ID
        }))
        assert.strictEqual(missingConfiguration._tag, "Failure")
        if (missingConfiguration._tag === "Failure") {
          assert.strictEqual(missingConfiguration.failure._tag, "PluginConfigurationFailure")
          if (missingConfiguration.failure._tag === "PluginConfigurationFailure") {
            assert.strictEqual(missingConfiguration.failure.diagnosticCode, "plugin-configuration-missing")
          }
        }
        assert.strictEqual(requests.length, 2)

        yield* connections.invalidate(scope)
        const thirdContext = yield* connections.contextEffect(scope)
        assert.notStrictEqual(Context.get(thirdContext, PluginConnection), first)
        yield* persistenceService.pluginConnections.updateMetadata(WORKSPACE_ID, CONNECTION_ID, {
          displayName: PluginConnectionDisplayName.make("Delivery Clockify"),
          isEnabled: false,
          expectedRevision: RecordRevision.make(1),
          updatedAt: CREATED_AT
        })
        yield* connections.invalidate(scope)
        const disabled = yield* Effect.result(connections.contextEffect(scope))
        assert.strictEqual(disabled._tag, "Failure")
        if (disabled._tag === "Failure") {
          assert.strictEqual(disabled.failure._tag, "PluginConfigurationFailure")
          if (disabled.failure._tag === "PluginConfigurationFailure") {
            assert.strictEqual(disabled.failure.diagnosticCode, "plugin-connection-disabled")
          }
          assert.notInclude(String(disabled.failure), "clockify-secret")
        }
        assert.strictEqual(requests.length, 2)
      }).pipe(
        Effect.provide(firstPartyPluginConnectionMapLayer),
        Effect.provide(dependencies)
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
