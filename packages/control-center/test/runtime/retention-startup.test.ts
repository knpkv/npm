import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Deferred, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistenceOperationError } from "../../src/server/persistence/errors.js"
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
            "reproducible-content",
            "sandbox-artifact"
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
      const secondSweepStarted = yield* Deferred.make<void>()
      const releaseSecondSweep = yield* Deferred.make<void>()
      const secondSweepCompleted = yield* Deferred.make<void>()
      const thirdSweepStarted = yield* Deferred.make<void>()
      const releaseThirdSweep = yield* Deferred.make<void>()
      const thirdSweepCompleted = yield* Deferred.make<void>()
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
                if (sweepCount === 2) {
                  return Deferred.succeed(secondSweepStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseSecondSweep)),
                    Effect.andThen(persistence.retention.sweepWorkspace(...args)),
                    Effect.tap(() => Deferred.succeed(secondSweepCompleted, undefined))
                  )
                }
                return Deferred.succeed(thirdSweepStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseThirdSweep)),
                  Effect.andThen(persistence.retention.sweepWorkspace(...args)),
                  Effect.tap(() => Deferred.succeed(thirdSweepCompleted, undefined))
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
          yield* Deferred.await(secondSweepStarted)
          yield* TestClock.adjust("1 hour")
          assert.strictEqual(sweepCount, 2)
          yield* Deferred.succeed(releaseSecondSweep, undefined)
          yield* Deferred.await(secondSweepCompleted)
          yield* TestClock.adjust("1 hour")
          yield* Deferred.await(thirdSweepStarted)
          assert.strictEqual(sweepCount, 3)
          yield* lifecycle.beginDrain
          yield* Effect.forkChild(
            Deferred.succeed(drainWaiterStarted, undefined).pipe(
              Effect.andThen(lifecycle.awaitWorkDrained),
              Effect.andThen(Deferred.succeed(drained, undefined))
            )
          )
          yield* Deferred.await(drainWaiterStarted)
          assert.isFalse(yield* Deferred.isDone(drained))
          assert.isFalse(yield* Deferred.isDone(thirdSweepCompleted))
          yield* Deferred.succeed(releaseThirdSweep, undefined)
          yield* Deferred.await(drained)
          yield* Deferred.await(thirdSweepCompleted)
          assert.strictEqual(sweepCount, 3)
        }).pipe(Effect.provide(startup))
      }).pipe(
        Effect.provide(persistenceLayer),
        Effect.scoped
      )
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("retries a transient sweep failure before the normal retention interval", () =>
    Effect.gen(function*() {
      const config = yield* makePersistenceTestConfig("control-center-retention-retry-")
      const database = databaseLayer(config)
      const persistenceLayer = persistenceLayerFromDatabase(config).pipe(
        Layer.provide(database)
      )
      const lifecycle = yield* ServerLifecycle.make
      const retryCompleted = yield* Deferred.make<void>()
      yield* TestClock.setTime(DateTime.toEpochMillis(FIXTURE_TIME))

      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        yield* persistence.workspaces.create(WORKSPACE_ID, {
          displayName: WorkspaceName.make("Retention retry fixture"),
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
                return sweepCount === 1
                  ? Effect.fail(
                    new PersistenceOperationError({
                      operation: "retention-test.transient-sweep"
                    })
                  )
                  : persistence.retention.sweepWorkspace(...args).pipe(
                    Effect.tap(() => Deferred.succeed(retryCompleted, undefined))
                  )
              })
          }
        })
        const startup = retentionStartupLayer({
          workspaceId: WORKSPACE_ID,
          interval: "1 hour",
          failureInterval: "1 minute"
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
          assert.strictEqual(sweepCount, 1)
          assert.isEmpty(yield* persistence.retention.listRuns(WORKSPACE_ID))
          yield* TestClock.adjust("59 seconds")
          assert.strictEqual(sweepCount, 1)
          yield* TestClock.adjust("1 second")
          yield* Deferred.await(retryCompleted)
          assert.strictEqual(sweepCount, 2)
          assert.deepStrictEqual(
            (yield* persistence.retention.listRuns(WORKSPACE_ID))
              .map(({ retentionClass }) => retentionClass)
              .sort(),
            [
              "agent-content",
              "audit-replay",
              "evidence",
              "reproducible-content",
              "sandbox-artifact"
            ]
          )
          yield* TestClock.adjust("59 minutes")
          assert.strictEqual(sweepCount, 2)
          yield* lifecycle.beginDrain
          yield* lifecycle.awaitWorkDrained
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
