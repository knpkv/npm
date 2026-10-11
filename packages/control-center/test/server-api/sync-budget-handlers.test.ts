import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import { HttpApiTest } from "effect/http-api"
import * as TestClock from "effect/testing/TestClock"

import { ControlCenterApi } from "../../src/api/controlCenterApi.js"
import {
  type CreatePluginConnectionBatchResult,
  CreatePluginConnectionResponse,
  PluginSynchronizationState
} from "../../src/api/plugins.js"
import { CurrentSession, SessionCookieAuth, SessionMutationAuth, SessionSummary } from "../../src/api/session.js"
import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { ApiBindConfiguration } from "../../src/server/api/ApiConfiguration.js"
import { ApplicationResourceNotFound, PluginAdministration } from "../../src/server/api/ApplicationServices.js"
import { pluginHandlersLayer } from "../../src/server/api/Handlers.js"
import { RequestLimitPolicy, requestRateLimiterLayer } from "../../src/server/api/RequestLimits.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"

const session = Schema.decodeUnknownSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000002",
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001",
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
  permission: "workspace-owner",
  createdAt: "2026-07-14T10:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  revokedAt: null
})
const connectionId = (index: number) =>
  PluginConnectionId.make(
    `01890f6f-6d6a-7cc0-98d2-${String(index).padStart(12, "0")}`
  )
const state = (pluginConnectionId: PluginConnectionId) =>
  Schema.decodeUnknownSync(PluginSynchronizationState)({
    pluginConnectionId,
    providerId: "jira",
    streamKey: "project-issues",
    lastAttemptAt: "2026-07-14T12:00:00.000Z",
    lastSuccessAt: "2026-07-14T12:00:00.000Z",
    result: "synchronized",
    pagesCommitted: 1
  })
const sessionLayer = Layer.succeed(SessionCookieAuth, {
  sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, session)
})
const mutationLayer = Layer.succeed(SessionMutationAuth, { csrfToken: (effect) => effect })
const ownedConnections = new Map<PluginConnectionId, WorkspaceId>(
  Array.from(
    { length: 70 },
    (_, index): [PluginConnectionId, WorkspaceId] => [connectionId(index + 1), session.workspaceId]
  )
)
ownedConnections.set(connectionId(100), WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000099"))
const plugins = PluginAdministration.of({
  configuration: () => Effect.die("unused configuration"),
  configurationMetadata: () => Effect.die("unused metadata"),
  patchConfiguration: () => Effect.die("unused patch"),
  health: () => Effect.die("unused health"),
  list: () => Effect.die("unused list"),
  testConnection: () => Effect.die("unused health test"),
  synchronization: ({ pluginConnectionId, workspaceId }) =>
    ownedConnections.get(pluginConnectionId) === workspaceId
      ? Effect.succeed(state(pluginConnectionId))
      : Effect.fail(new ApplicationResourceNotFound()),
  synchronizeConnection: ({ pluginConnectionId, workspaceId }) =>
    ownedConnections.get(pluginConnectionId) === workspaceId
      ? Effect.succeed(state(pluginConnectionId))
      : Effect.fail(new ApplicationResourceNotFound())
})
const handler = pluginHandlersLayer.pipe(Layer.provide([
  Layer.succeed(PluginAdministration, plugins),
  Layer.effect(ApiBindConfiguration, decodeBindConfig({})),
  RequestLimitPolicy.defaultLayer,
  requestRateLimiterLayer,
  ServerLifecycle.layer,
  Layer.succeed(ControlCenterBootstrap, { _tag: "disabled" }),
  sessionLayer,
  mutationLayer
]))

const createResponse = (id: PluginConnectionId) =>
  Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
    connection: {
      pluginConnectionId: id,
      providerId: "jira",
      displayName: "Fixture project",
      revision: 1,
      isEnabled: true,
      supportsSynchronization: true,
      health: null,
      updatedAt: "2026-07-14T12:00:00.000Z"
    },
    configuration: {
      pluginConnectionId: id,
      revision: 1,
      values: [],
      updatedAt: "2026-07-14T12:00:00.000Z"
    },
    test: {
      _tag: "healthy",
      pluginConnectionId: id,
      providerId: "jira",
      checkedAt: "2026-07-14T12:00:00.000Z",
      latencyMilliseconds: 0,
      identity: { kind: "user", label: "Jira user", displayName: "Release Owner", providerImmutableId: "fixture-owner" }
    }
  })

describe("authenticated synchronization budgets", () => {
  it.effect("starts healthy onboarding on the server without a manual browser POST", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const response = createResponse(connectionId(1))
      const onboardingPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: () => Effect.succeed(response),
        synchronization: ({ pluginConnectionId }) =>
          Effect.succeed({ ...state(pluginConnectionId), result: "never", lastAttemptAt: null, lastSuccessAt: null }),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as(state(pluginConnectionId)),
            Effect.ensuring(Deferred.succeed(completed, undefined))
          )
      })
      const onboardingHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, onboardingPlugins),
        Layer.effect(ApiBindConfiguration, decodeBindConfig({})),
        RequestLimitPolicy.defaultLayer,
        requestRateLimiterLayer,
        ServerLifecycle.layer,
        Layer.succeed(ControlCenterBootstrap, { _tag: "disabled" }),
        sessionLayer,
        mutationLayer
      ]))
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        yield* client.plugins.createConnection({
          payload: {
            pluginConnectionId: connectionId(1),
            providerId: "jira",
            displayName: "Fixture project",
            values: []
          }
        })
        assert.isTrue(Option.isSome(yield* Deferred.poll(started)))
        yield* Deferred.succeed(finish, undefined)
        yield* Deferred.await(completed)
      }).pipe(Effect.provide([onboardingHandler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices]))
    }))

  it.effect("creates the 61st connection successfully, exposes queued state, then syncs when admitted", () =>
    Effect.gen(function*() {
      const finished = new Set<PluginConnectionId>()
      const admitted = yield* Deferred.make<void>()
      const onboardingPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: ({ request }) => Effect.succeed(createResponse(request.pluginConnectionId)),
        connectAndTestBatch: ({ requests }) =>
          Effect.succeed({
            results: requests.map((request): CreatePluginConnectionBatchResult => ({
              _tag: "succeeded",
              response: createResponse(request.pluginConnectionId)
            }))
          }),
        synchronization: ({ pluginConnectionId }) =>
          Effect.succeed(
            finished.has(pluginConnectionId)
              ? state(pluginConnectionId)
              : { ...state(pluginConnectionId), result: "never", lastAttemptAt: null, lastSuccessAt: null }
          ),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            finished.add(pluginConnectionId)
            if (pluginConnectionId === connectionId(61)) yield* Deferred.succeed(admitted, undefined)
            return state(pluginConnectionId)
          })
      })
      const onboardingHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, onboardingPlugins),
        Layer.effect(ApiBindConfiguration, decodeBindConfig({})),
        RequestLimitPolicy.defaultLayer,
        requestRateLimiterLayer,
        ServerLifecycle.layer,
        Layer.succeed(ControlCenterBootstrap, { _tag: "disabled" }),
        sessionLayer,
        mutationLayer
      ]))
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        // Batch setup reaches sixty onboarding jobs using two mutations, within the separate ingress budget.
        for (const start of [1, 31]) {
          const response = yield* client.plugins.createConnections({
            payload: {
              connections: Array.from({ length: 30 }, (_, offset) => ({
                pluginConnectionId: connectionId(start + offset),
                providerId: "jira",
                displayName: "Fixture project",
                values: []
              }))
            },
            responseMode: "response-only"
          })
          assert.isAtLeast(response.status, 200)
          assert.isBelow(response.status, 300)
        }
        const created = yield* client.plugins.createConnection({
          payload: {
            pluginConnectionId: connectionId(61),
            providerId: "jira",
            displayName: "Fixture project",
            values: []
          },
          responseMode: "response-only"
        })
        assert.isAtLeast(created.status, 200)
        assert.isBelow(created.status, 300)
        const queued = yield* client.plugins.synchronization({ params: { pluginConnectionId: connectionId(61) } })
        assert.strictEqual(queued.result, "queued")
        assert.isNull(queued.lastAttemptAt)
        assert.strictEqual(finished.size, 60)
        yield* TestClock.adjust("1 second")
        yield* Deferred.await(admitted)
        const synced = yield* client.plugins.synchronization({ params: { pluginConnectionId: connectionId(61) } })
        assert.strictEqual(synced.result, "synchronized")
        assert.strictEqual(finished.size, 61)
      }).pipe(Effect.provide([onboardingHandler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices]))
    }))

  it.effect("drain interrupts queued onboarding without running its provider sync", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      let attempts = 0
      const onboardingPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: ({ request }) => Effect.succeed(createResponse(request.pluginConnectionId)),
        synchronization: ({ pluginConnectionId }) =>
          Effect.succeed({ ...state(pluginConnectionId), result: "never", lastAttemptAt: null, lastSuccessAt: null }),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Effect.sync(() => {
            attempts++
            return state(pluginConnectionId)
          })
      })
      const onboardingHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, onboardingPlugins),
        Layer.effect(ApiBindConfiguration, decodeBindConfig({})),
        RequestLimitPolicy.defaultLayer,
        requestRateLimiterLayer,
        Layer.succeed(ServerLifecycle, lifecycle),
        Layer.succeed(ControlCenterBootstrap, { _tag: "disabled" }),
        sessionLayer,
        mutationLayer
      ]))
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        for (let index = 1; index <= 61; index++) {
          yield* client.plugins.createConnection({
            payload: {
              pluginConnectionId: connectionId(index),
              providerId: "jira",
              displayName: "Fixture project",
              values: []
            }
          })
        }
        assert.strictEqual(attempts, 60)
        yield* lifecycle.beginDrain
        yield* lifecycle.awaitWorkDrained
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(attempts, 60)
      }).pipe(Effect.provide([onboardingHandler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices]))
    }))

  it.effect("does not enqueue onboarding when creation reports rejected credentials", () =>
    Effect.gen(function*() {
      let attempts = 0
      const onboardingPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: ({ request }) =>
          Effect.succeed({
            ...createResponse(request.pluginConnectionId),
            test: {
              _tag: "failed",
              pluginConnectionId: request.pluginConnectionId,
              providerId: "jira",
              checkedAt: createResponse(request.pluginConnectionId).test.checkedAt,
              latencyMilliseconds: 0,
              failureClass: "authentication",
              safeMessage: "Credentials rejected.",
              retryAt: null
            }
          }),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Effect.sync(() => {
            attempts++
            return state(pluginConnectionId)
          })
      })
      const onboardingHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, onboardingPlugins),
        Layer.effect(ApiBindConfiguration, decodeBindConfig({})),
        RequestLimitPolicy.defaultLayer,
        requestRateLimiterLayer,
        ServerLifecycle.layer,
        Layer.succeed(ControlCenterBootstrap, { _tag: "disabled" }),
        sessionLayer,
        mutationLayer
      ]))
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        const created = yield* client.plugins.createConnection({
          payload: {
            pluginConnectionId: connectionId(1),
            providerId: "jira",
            displayName: "Fixture project",
            values: []
          }
        })
        assert.strictEqual(created.test._tag, "failed")
        assert.strictEqual(attempts, 0)
      }).pipe(Effect.provide([onboardingHandler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices]))
    }))

  it.effect("allows ten connections and rejects a third manual attempt with the named budget and HTTP delay", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
      for (let index = 1; index <= 10; index++) {
        yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(index) } })
      }
      yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })
      const response = yield* client.plugins.synchronizeConnection({
        params: { pluginConnectionId: connectionId(1) },
        responseMode: "response-only"
      })
      assert.strictEqual(response.status, 429)
      assert.strictEqual(response.headers["retry-after"], "30")
      assert.deepInclude(yield* response.json, {
        _tag: "RateLimitedApiError",
        budget: "per-connection",
        retryAfterSeconds: 30
      })
    }).pipe(Effect.provide([handler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices])))

  it.effect("unknown and unowned connection identities cannot create or drain manual buckets", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
      for (let index = 100; index <= 170; index++) {
        const response = yield* client.plugins.synchronizeConnection({
          params: { pluginConnectionId: connectionId(index) },
          responseMode: "response-only"
        })
        assert.strictEqual(response.status, 404)
      }
      for (let index = 1; index <= 60; index++) {
        yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(index) } })
      }
      const exhausted = yield* client.plugins.synchronizeConnection({
        params: { pluginConnectionId: connectionId(61) },
        responseMode: "response-only"
      })
      assert.strictEqual(exhausted.status, 429)
      assert.deepInclude(yield* exhausted.json, { budget: "global", retryAfterSeconds: 1 })
    }).pipe(Effect.provide([handler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices])))
})
