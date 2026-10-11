import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Ref, Schema } from "effect"
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
import {
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable,
  PluginAdministration
} from "../../src/server/api/ApplicationServices.js"
import { pluginHandlersLayer } from "../../src/server/api/Handlers.js"
import {
  DEFAULT_REQUEST_LIMIT_POLICY,
  RequestLimitPolicy,
  requestRateLimiterLayer
} from "../../src/server/api/RequestLimits.js"
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
  it.effect("joins a running first sync without another provider attempt or spending manual tokens", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const resolved = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      const joining = yield* Ref.make(false)
      const joiningPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: () => Effect.succeed(createResponse(connectionId(1))),
        synchronization: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            if (yield* Ref.get(joining)) yield* Deferred.succeed(resolved, undefined)
            return { ...state(pluginConnectionId), result: (yield* Ref.get(calls)) === 0 ? "never" : "running" }
          }),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            const count = yield* Ref.updateAndGet(calls, (value) => value + 1)
            if (count > 1 && Option.isNone(yield* Deferred.poll(finish))) {
              return yield* new ApplicationServiceUnavailable({ retryAt: null })
            }
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
            return state(pluginConnectionId)
          })
      })
      const joiningHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, joiningPlugins),
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
        yield* Deferred.await(started)
        yield* Ref.set(joining, true)
        const joined = yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(resolved)
        assert.strictEqual(yield* Ref.get(calls), 1)
        yield* Deferred.succeed(finish, undefined)
        assert.strictEqual((yield* Fiber.join(joined)).result, "synchronized")
        for (let index = 0; index < 2; index++) {
          assert.strictEqual(
            (yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })).result,
            "synchronized"
          )
        }
        assert.strictEqual(yield* Ref.get(calls), 3)
        // Two manual owners above plus 58 more exhaust sixty global tokens; the joined call costs none.
        for (let index = 2; index <= 59; index++) {
          yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(index) } })
        }
        const global = yield* client.plugins.synchronizeConnection({
          params: { pluginConnectionId: connectionId(60) },
          responseMode: "response-only"
        })
        assert.strictEqual(global.status, 429)
        assert.deepInclude(yield* global.json, { budget: "global" })
      }).pipe(Effect.provide([joiningHandler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices]))
    }))

  it.effect("joins concurrent manual requests and charges only the attempt owner", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const resolved = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      const joining = yield* Ref.make(false)
      const joiningPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: () => Effect.succeed(createResponse(connectionId(1))),
        synchronization: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            if (yield* Ref.get(joining)) yield* Deferred.succeed(resolved, undefined)
            return { ...state(pluginConnectionId), result: (yield* Ref.get(calls)) === 0 ? "never" : "running" }
          }),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            const count = yield* Ref.updateAndGet(calls, (value) => value + 1)
            if (count > 1 && Option.isNone(yield* Deferred.poll(finish))) {
              return yield* new ApplicationServiceUnavailable({ retryAt: null })
            }
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
            return state(pluginConnectionId)
          })
      })
      const joiningHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, joiningPlugins),
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
        const owner = yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Ref.set(joining, true)
        const joined = yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(resolved)
        assert.strictEqual(yield* Ref.get(calls), 1)
        yield* Deferred.succeed(finish, undefined)
        assert.strictEqual((yield* Fiber.join(joined)).result, "synchronized")
        assert.strictEqual((yield* Fiber.join(owner)).result, "synchronized")
        assert.strictEqual(
          (yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })).result,
          "synchronized"
        )
        const exhausted = yield* client.plugins.synchronizeConnection({
          params: { pluginConnectionId: connectionId(1) },
          responseMode: "response-only"
        })
        assert.strictEqual(exhausted.status, 429)
        assert.deepInclude(yield* exhausted.json, { budget: "per-connection" })
        assert.strictEqual(yield* Ref.get(calls), 2)
      }).pipe(Effect.provide([joiningHandler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices]))
    }))

  it.effect("cancelling a joined request leaves its owner active until normal drain completes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const resolved = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      const joining = yield* Ref.make(false)
      const joiningPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: () => Effect.succeed(createResponse(connectionId(1))),
        synchronization: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            if (yield* Ref.get(joining)) yield* Deferred.succeed(resolved, undefined)
            return { ...state(pluginConnectionId), result: (yield* Ref.get(calls)) === 0 ? "never" : "running" }
          }),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            const count = yield* Ref.updateAndGet(calls, (value) => value + 1)
            if (count > 1 && Option.isNone(yield* Deferred.poll(finish))) {
              return yield* new ApplicationServiceUnavailable({ retryAt: null })
            }
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(finish)
            return state(pluginConnectionId)
          })
      })
      const lifecycleService = yield* ServerLifecycle.make
      const joiningHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, joiningPlugins),
        Layer.effect(ApiBindConfiguration, decodeBindConfig({})),
        RequestLimitPolicy.defaultLayer,
        requestRateLimiterLayer,
        Layer.succeed(ServerLifecycle, lifecycleService),
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
        yield* Deferred.await(started)
        yield* Ref.set(joining, true)
        const joined = yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(resolved)
        assert.strictEqual(yield* Ref.get(calls), 1)
        yield* Fiber.interrupt(joined)
        const lifecycle = yield* ServerLifecycle
        yield* lifecycle.beginDrain
        const drained = yield* Deferred.make<void>()
        const drain = yield* lifecycle.awaitWorkDrained.pipe(
          Effect.andThen(Deferred.succeed(drained, undefined)),
          Effect.forkChild({ startImmediately: true })
        )
        assert.isTrue(Option.isNone(yield* Deferred.poll(drained)))
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(drain)
        assert.strictEqual(yield* Ref.get(calls), 1)
      }).pipe(
        Effect.provide([
          joiningHandler,
          Layer.succeed(ServerLifecycle, lifecycleService),
          sessionLayer,
          mutationLayer,
          NodeHttpServer.layerHttpServices
        ])
      )
    }))

  it.effect("joins queued onboarding without taking over admission or spending manual tokens", () =>
    Effect.gen(function*() {
      const finished = new Set<PluginConnectionId>()
      const calls = yield* Ref.make(0)
      const resolved = yield* Deferred.make<void>()
      const joining = yield* Ref.make(false)
      const queuedPlugins = PluginAdministration.of({
        ...plugins,
        connectAndTest: ({ request }) => Effect.succeed(createResponse(request.pluginConnectionId)),
        synchronization: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            if ((yield* Ref.get(joining)) && pluginConnectionId === connectionId(1)) {
              yield* Deferred.succeed(resolved, undefined)
            }
            return finished.has(pluginConnectionId)
              ? state(pluginConnectionId)
              : { ...state(pluginConnectionId), result: "never", lastAttemptAt: null, lastSuccessAt: null }
          }),
        synchronizeConnection: ({ pluginConnectionId }) =>
          Effect.gen(function*() {
            finished.add(pluginConnectionId)
            if (pluginConnectionId === connectionId(1)) yield* Ref.update(calls, (value) => value + 1)
            return state(pluginConnectionId)
          })
      })
      const queuedHandler = pluginHandlersLayer.pipe(Layer.provide([
        Layer.succeed(PluginAdministration, queuedPlugins),
        Layer.effect(ApiBindConfiguration, decodeBindConfig({})),
        Layer.succeed(RequestLimitPolicy, {
          ...DEFAULT_REQUEST_LIMIT_POLICY,
          "sync-onboarding": { limit: 1, window: Duration.minutes(1) }
        }),
        requestRateLimiterLayer,
        ServerLifecycle.layer,
        Layer.succeed(ControlCenterBootstrap, { _tag: "disabled" }),
        sessionLayer,
        mutationLayer
      ]))
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["plugins"])
        for (const id of [connectionId(2), connectionId(1)]) {
          yield* client.plugins.createConnection({
            payload: {
              pluginConnectionId: id,
              providerId: "jira",
              displayName: "Fixture project",
              values: []
            }
          })
        }
        assert.strictEqual(
          (yield* client.plugins.synchronization({ params: { pluginConnectionId: connectionId(1) } })).result,
          "queued"
        )
        yield* Ref.set(joining, true)
        const joined = yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(resolved)
        assert.strictEqual(yield* Ref.get(calls), 0)
        yield* TestClock.adjust("1 minute")
        assert.strictEqual((yield* Fiber.join(joined)).result, "synchronized")
        assert.strictEqual(yield* Ref.get(calls), 1)
        for (let index = 0; index < 2; index++) {
          yield* client.plugins.synchronizeConnection({ params: { pluginConnectionId: connectionId(1) } })
        }
        assert.strictEqual(yield* Ref.get(calls), 3)
      }).pipe(Effect.provide([queuedHandler, sessionLayer, mutationLayer, NodeHttpServer.layerHttpServices]))
    }))

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
