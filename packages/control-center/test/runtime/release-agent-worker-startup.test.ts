import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Ref } from "effect"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { AgentJobWorker, type AgentJobWorkerRunResult } from "../../src/server/agent/AgentJobWorker.js"
import {
  ReleaseAgentWorkerRunning,
  ReleaseAgentWorkerStartup,
  releaseAgentWorkerStartupLayer
} from "../../src/server/runtime/ReleaseAgentWorkerStartup.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000022")

describe("release agent worker startup", () => {
  it.effect("attaches the durable worker to the drain barrier", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const started = yield* Deferred.make<void>()
      let runCount = 0
      let observedWorkspaceId: WorkspaceId | undefined
      const worker = AgentJobWorker.of({
        runOnce: (workspaceId) =>
          Effect.sync(() => {
            runCount += 1
            observedWorkspaceId = workspaceId
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.succeed({ _tag: "idle" } satisfies AgentJobWorkerRunResult))
          )
      })
      const startup = releaseAgentWorkerStartupLayer({
        workspaceId: WORKSPACE_ID,
        idlePollInterval: "1 hour"
      }).pipe(
        Layer.provide(Layer.mergeAll(
          Layer.succeed(AgentJobWorker, worker),
          Layer.succeed(ServerLifecycle, lifecycle)
        ))
      )

      const running = yield* Effect.gen(function*() {
        const state = yield* ReleaseAgentWorkerStartup
        yield* Deferred.await(started)
        yield* lifecycle.beginDrain
        yield* lifecycle.awaitWorkDrained
        return state
      }).pipe(Effect.provide(startup))

      assert.instanceOf(running, ReleaseAgentWorkerRunning)
      assert.strictEqual(running.workspaceId, WORKSPACE_ID)
      assert.strictEqual(runCount, 1)
      assert.strictEqual(observedWorkspaceId, WORKSPACE_ID)
    }).pipe(Effect.scoped))

  it.effect("preserves an admitted claim until it finishes during drain", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      const drained = yield* Deferred.make<void>()
      const drainWaiterStarted = yield* Deferred.make<void>()
      const interrupted = yield* Ref.make(false)
      const worker = AgentJobWorker.of({
        runOnce: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Deferred.succeed(completed, undefined)),
            Effect.as({ _tag: "idle" } satisfies AgentJobWorkerRunResult),
            Effect.onInterrupt(() => Ref.set(interrupted, true))
          )
      })
      const startup = releaseAgentWorkerStartupLayer({
        workspaceId: WORKSPACE_ID,
        idlePollInterval: "1 hour"
      }).pipe(
        Layer.provide(Layer.mergeAll(
          Layer.succeed(AgentJobWorker, worker),
          Layer.succeed(ServerLifecycle, lifecycle)
        ))
      )

      yield* Effect.gen(function*() {
        yield* ReleaseAgentWorkerStartup
        yield* Deferred.await(started)
        yield* lifecycle.beginDrain
        yield* Effect.forkChild(
          Deferred.succeed(drainWaiterStarted, undefined).pipe(
            Effect.andThen(lifecycle.awaitWorkDrained),
            Effect.andThen(Deferred.succeed(drained, undefined))
          )
        )
        yield* Deferred.await(drainWaiterStarted)
        assert.isFalse(yield* Deferred.isDone(drained))
        assert.isFalse(yield* Ref.get(interrupted))
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(drained)
        yield* Deferred.await(completed)
        assert.isFalse(yield* Ref.get(interrupted))
      }).pipe(Effect.provide(startup))
    }).pipe(Effect.scoped))
})
