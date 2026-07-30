import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Deferred, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { RetentionRunning, RetentionStartup, retentionStartupLayer } from "../../src/server/runtime/RetentionStartup.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = fixtureWorkspaceIds.alpha
const FIXTURE_TIME = DateTime.makeUnsafe("2026-07-30T12:00:00.000Z")

describe("retention startup", () => {
  it.effect("runs one bounded pass and releases the interval loop during drain", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-retention-startup-")
      const database = databaseLayer(config)
      const persistence = persistenceLayerFromDatabase(config).pipe(
        Layer.provide(database)
      )
      yield* Effect.gen(function*() {
        const service = yield* Persistence
        yield* service.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Retention startup fixture"),
          createdAt: FIXTURE_TIME
        })
        yield* service.workspaceSettings.get(WORKSPACE_ID)
      }).pipe(Effect.provide(persistence), Effect.scoped)

      const lifecycle = yield* ServerLifecycle.make
      const startup = retentionStartupLayer({
        workspaceId: WORKSPACE_ID,
        interval: "1 hour"
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            persistence,
            Layer.succeed(ControlCenterBootstrap, {
              _tag: "already-initialized",
              workspaceId: WORKSPACE_ID
            }),
            Layer.succeed(ServerLifecycle, lifecycle)
          )
        )
      )
      yield* TestClock.setTime(DateTime.toEpochMillis(FIXTURE_TIME))

      yield* Effect.gen(function*() {
        const state = yield* RetentionStartup
        const service = yield* Persistence
        const runs = yield* service.retention.listRuns(WORKSPACE_ID)
        assert.instanceOf(state, RetentionRunning)
        assert.strictEqual(state.workspaceId, WORKSPACE_ID)
        assert.deepStrictEqual(
          runs.map(({ retentionClass }) => retentionClass).sort(),
          [
            "agent-content",
            "audit-replay",
            "evidence",
            "reproducible-content"
          ]
        )
        yield* lifecycle.beginDrain
        yield* lifecycle.awaitWorkDrained
      }).pipe(
        Effect.provide(Layer.merge(persistence, startup)),
        Effect.scoped
      )
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("preserves an admitted periodic sweep until it finishes during drain", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-retention-active-drain-")
      const database = databaseLayer(config)
      const persistenceLayer = persistenceLayerFromDatabase(config).pipe(
        Layer.provide(database)
      )
      const lifecycle = yield* ServerLifecycle.make
      const sweepStarted = yield* Deferred.make<void>()
      const releaseSweep = yield* Deferred.make<void>()
      const sweepCompleted = yield* Deferred.make<void>()
      const drainWaiterStarted = yield* Deferred.make<void>()
      const drained = yield* Deferred.make<void>()
      yield* TestClock.setTime(DateTime.toEpochMillis(FIXTURE_TIME))

      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Active retention drain fixture"),
          createdAt: FIXTURE_TIME
        })
        yield* persistence.workspaceSettings.get(WORKSPACE_ID)
        let sweepCount = 0
        const observedPersistence = Persistence.of({
          ...persistence,
          retention: {
            ...persistence.retention,
            sweepWorkspace: (...args) =>
              Effect.suspend(() => {
                sweepCount += 1
                if (sweepCount === 1) {
                  return persistence.retention.sweepWorkspace(...args)
                }
                return Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSweep)),
                  Effect.andThen(persistence.retention.sweepWorkspace(...args)),
                  Effect.tap(() => Deferred.succeed(sweepCompleted, undefined))
                )
              })
          }
        })
        const startup = retentionStartupLayer({
          workspaceId: WORKSPACE_ID,
          interval: "1 hour"
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Persistence, observedPersistence),
              Layer.succeed(ControlCenterBootstrap, {
                _tag: "already-initialized",
                workspaceId: WORKSPACE_ID
              }),
              Layer.succeed(ServerLifecycle, lifecycle)
            )
          )
        )

        yield* Effect.gen(function*() {
          yield* RetentionStartup
          yield* TestClock.adjust("1 hour")
          yield* Deferred.await(sweepStarted)
          yield* lifecycle.beginDrain
          yield* Effect.forkChild(
            Deferred.succeed(drainWaiterStarted, undefined).pipe(
              Effect.andThen(lifecycle.awaitWorkDrained),
              Effect.andThen(Deferred.succeed(drained, undefined))
            )
          )
          yield* Deferred.await(drainWaiterStarted)
          assert.isFalse(yield* Deferred.isDone(drained))
          assert.isFalse(yield* Deferred.isDone(sweepCompleted))
          yield* Deferred.succeed(releaseSweep, undefined)
          yield* Deferred.await(drained)
          yield* Deferred.await(sweepCompleted)
          assert.strictEqual(sweepCount, 2)
        }).pipe(Effect.provide(startup))
      }).pipe(
        Effect.provide(persistenceLayer),
        Effect.scoped
      )
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))
})
