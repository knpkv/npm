import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"

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
      const worker = AgentJobWorker.of({
        runOnce: (workspaceId) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.succeed({ _tag: "idle" } satisfies AgentJobWorkerRunResult)),
            Effect.tap(() => Effect.sync(() => assert.strictEqual(workspaceId, WORKSPACE_ID)))
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
    }).pipe(Effect.scoped))

  it.effect("runs an initial reclaim cycle before supervision when requested", () =>
    Effect.gen(function*() {
      const lifecycle = yield* ServerLifecycle.make
      const cycles = yield* Deferred.make<void>()
      let runCount = 0
      const worker = AgentJobWorker.of({
        runOnce: () =>
          Effect.sync(() => {
            runCount += 1
            return runCount
          }).pipe(
            Effect.flatMap((current) => current === 1 ? Effect.void : Deferred.succeed(cycles, undefined)),
            Effect.as({ _tag: "idle" } satisfies AgentJobWorkerRunResult)
          )
      })
      const startup = releaseAgentWorkerStartupLayer({
        workspaceId: WORKSPACE_ID,
        idlePollInterval: "1 hour",
        runOnceBeforeSupervision: true
      }).pipe(
        Layer.provide(Layer.mergeAll(
          Layer.succeed(AgentJobWorker, worker),
          Layer.succeed(ServerLifecycle, lifecycle)
        ))
      )

      yield* Effect.gen(function*() {
        yield* ReleaseAgentWorkerStartup
        yield* Deferred.await(cycles)
        assert.strictEqual(runCount, 2)
        yield* lifecycle.beginDrain
        yield* lifecycle.awaitWorkDrained
      }).pipe(Effect.provide(startup))
    }).pipe(Effect.scoped))
})
