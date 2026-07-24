import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { AgentJobWorker, type AgentJobWorkerRunResult } from "../../src/server/agent/AgentJobWorker.js"
import {
  PrReviewWorkerRunning,
  PrReviewWorkerStartup,
  prReviewWorkerStartupLayer
} from "../../src/server/runtime/PrReviewWorkerStartup.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000021")

describe("PR review worker startup", () => {
  it.effect("attaches the worker to the server scope and exits it during drain", () =>
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
      const startup = prReviewWorkerStartupLayer({
        workspaceId: WORKSPACE_ID,
        idlePollInterval: "1 hour"
      }).pipe(
        Layer.provide(Layer.succeed(AgentJobWorker, worker)),
        Layer.provide(Layer.succeed(ServerLifecycle, lifecycle))
      )

      const running = yield* Effect.gen(function*() {
        const state = yield* PrReviewWorkerStartup
        yield* Deferred.await(started)
        yield* lifecycle.beginDrain
        yield* lifecycle.awaitWorkDrained
        return state
      }).pipe(Effect.provide(startup))

      assert.instanceOf(running, PrReviewWorkerRunning)
      assert.strictEqual(running.workspaceId, WORKSPACE_ID)
    }).pipe(Effect.scoped))
})
