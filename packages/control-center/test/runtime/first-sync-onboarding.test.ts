import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, it } from "@effect/vitest"
import { Context, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import * as DateTime from "effect/DateTime"
import * as RateLimiter from "effect/persistence/RateLimiter"
import * as TestClock from "effect/testing/TestClock"

import { CreatePluginConnectionResponse } from "../../src/api/plugins.js"
import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { PluginAdministration } from "../../src/server/api/ApplicationServices.js"
import { makeFirstSyncOnboarding } from "../../src/server/api/FirstSyncOnboarding.js"
import { consumeRequestToken, RequestLimitPolicy, requestRateLimiterLayer } from "../../src/server/api/RequestLimits.js"
import { makeManualPluginSynchronization } from "../../src/server/application/manualPluginSynchronization.js"
import { listPluginConnectionSummaries } from "../../src/server/application/pluginAdministration.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { jiraReadPluginDescriptor } from "../../src/server/plugins/jira/JiraReadPlugin.js"
import { negotiatePluginDescriptorV1 } from "../../src/server/plugins/negotiation.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { DomainEventWakeups } from "../../src/server/runtime/DomainEventWakeups.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const workspaceId = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000301")
const previousId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000302")
const queuedId = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000303")
const instant = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-14T12:00:00.000Z")
const bootstrap = Layer.succeed(ControlCenterBootstrap, { _tag: "already-initialized", workspaceId })

it.effect("recovers queued first sync after restart over the same persistence and excludes completed connections", () =>
  Effect.gen(function*() {
    yield* TestClock.setTime(DateTime.toEpochMillis(instant))
    const config = yield* makePersistenceTestConfig("control-center-onboarding-restart-")
    const database = databaseLayer(config)
    const persistenceLayer = persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database))
    yield* Effect.gen(function*() {
      const persistence = yield* Persistence
      yield* persistence.workspaces.create(workspaceId, {
        displayName: WorkspaceName.make("Fixture workspace"),
        createdAt: instant
      })
      const connection = PluginConnection.of({
        descriptor: yield* negotiatePluginDescriptorV1(jiraReadPluginDescriptor),
        discover: Effect.die("unused discovery"),
        health: Effect.succeed({ _tag: "healthy", checkedAt: instant }),
        sync: () =>
          Stream.succeed(
            Schema.decodeUnknownSync(PluginSyncPageV1)({ checkpointAfterPage: "complete", hasMore: false, events: [] })
          ),
        readEntity: () => Effect.die("unused entity read"),
        diff: Option.none(),
        proposeAction: () => Effect.die("unused action")
      })
      const manual = yield* makeManualPluginSynchronization({
        contextEffect: () => Effect.succeed(Context.make(PluginConnection, connection)),
        invalidate: () => Effect.void
      })
      const create = Effect.fn("FirstSyncRestartTest.create")(function*(pluginConnectionId: PluginConnectionId) {
        yield* persistence.pluginConnections.create(workspaceId, {
          pluginConnectionId,
          providerId: "jira",
          displayName: PluginConnectionDisplayName.make("Fixture project"),
          isEnabled: true,
          createdAt: instant
        })
        yield* persistence.pluginRuntime.acceptPluginDescriptor(
          workspaceId,
          pluginConnectionId,
          "jira",
          jiraReadPluginDescriptor,
          0,
          instant
        )
        const summaries = yield* listPluginConnectionSummaries(persistence, workspaceId)
        const summary = summaries.find((item) => item.pluginConnectionId === pluginConnectionId)
        if (summary === undefined) return yield* Effect.die("created fixture connection absent")
        return CreatePluginConnectionResponse.make({
          connection: summary,
          configuration: { pluginConnectionId, revision: 1, values: [], updatedAt: instant },
          test: {
            _tag: "healthy",
            pluginConnectionId,
            providerId: "jira",
            checkedAt: instant,
            latencyMilliseconds: 0,
            identity: {
              kind: "user",
              label: "Jira user",
              displayName: "Release Owner",
              providerImmutableId: "fixture-owner"
            }
          }
        })
      })
      const counts = yield* Ref.make<ReadonlyMap<PluginConnectionId, number>>(new Map())
      const completed = yield* Deferred.make<void>()
      const synchronize = Effect.fn("FirstSyncRestartTest.synchronize")(
        function*(input: { readonly workspaceId: WorkspaceId; readonly pluginConnectionId: PluginConnectionId }) {
          yield* Ref.update(
            counts,
            (current) =>
              new Map(current).set(input.pluginConnectionId, (current.get(input.pluginConnectionId) ?? 0) + 1)
          )
          const result = yield* manual.synchronize(input)
          if (input.pluginConnectionId === queuedId) {
            yield* Deferred.succeed(completed, undefined)
          }
          return result
        }
      )
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("unused configuration"),
        configurationMetadata: () => Effect.die("unused metadata"),
        patchConfiguration: () => Effect.die("unused patch"),
        health: () => Effect.die("unused health"),
        testConnection: () => Effect.die("unused health test"),
        list: (id) => listPluginConnectionSummaries(persistence, id),
        synchronization: manual.state,
        synchronizeConnection: synchronize
      })
      yield* create(previousId)
      yield* synchronize({ workspaceId, pluginConnectionId: previousId })
      const serverLayer = Layer.mergeAll(
        bootstrap,
        RequestLimitPolicy.defaultLayer,
        requestRateLimiterLayer,
        ServerLifecycle.layer
      )
      yield* Effect.scoped(Effect.gen(function*() {
        for (let index = 0; index < 60; index++) yield* consumeRequestToken("sync-onboarding", workspaceId)
        const onboarding = yield* makeFirstSyncOnboarding(plugins)
        yield* onboarding.enqueue(workspaceId, yield* create(queuedId))
        const state = yield* manual.state({ workspaceId, pluginConnectionId: queuedId })
        assert.strictEqual((yield* onboarding.present(workspaceId, state)).result, "queued")
        const lifecycle = yield* ServerLifecycle
        yield* lifecycle.beginDrain
        yield* lifecycle.awaitWorkDrained
      })).pipe(Effect.provide([serverLayer]))
      assert.strictEqual((yield* manual.state({ workspaceId, pluginConnectionId: queuedId })).result, "never")
      yield* Effect.scoped(Effect.gen(function*() {
        for (let index = 0; index < 60; index++) yield* consumeRequestToken("sync-onboarding", workspaceId)
        const admission = yield* Deferred.make<void>()
        const limiter = yield* RateLimiter.RateLimiter
        const observed = RateLimiter.RateLimiter.of({
          [RateLimiter.TypeId]: RateLimiter.TypeId,
          adaptiveConsume: limiter.adaptiveConsume,
          adaptiveFeedback: limiter.adaptiveFeedback,
          consume: (options) => limiter.consume(options).pipe(Effect.tap(() => Deferred.succeed(admission, undefined)))
        })
        const onboarding = yield* makeFirstSyncOnboarding(plugins).pipe(
          Effect.provideService(RateLimiter.RateLimiter, observed)
        )
        yield* Deferred.await(admission)
        const state = yield* manual.state({ workspaceId, pluginConnectionId: queuedId })
        assert.strictEqual((yield* onboarding.present(workspaceId, state)).result, "queued")
        yield* TestClock.adjust("1 second")
        yield* Deferred.await(completed)
        assert.strictEqual((yield* manual.state({ workspaceId, pluginConnectionId: queuedId })).result, "synchronized")
        assert.deepEqual(Array.from((yield* Ref.get(counts)).entries()), [[previousId, 1], [queuedId, 1]])
      })).pipe(Effect.provide([serverLayer]))
    }).pipe(Effect.provide([persistenceLayer, DomainEventWakeups.layer]))
  }).pipe(Effect.provide([NodeServices.layer]), Effect.scoped))
