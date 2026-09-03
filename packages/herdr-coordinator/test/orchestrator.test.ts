import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { MessageStorage } from "effect/unstable/cluster"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  layer as orchestratorLayer,
  Orchestrator,
  type OrchestratorCommand,
  singleRunnerLayer,
  sqliteLayer
} from "../src/index.js"

const command: OrchestratorCommand = {
  actor: "coordinator",
  activityIdempotencyKey: "activity:check:1",
  kind: "fleet.job",
  payload: { kind: "nix.check" }
}

const withDatabase = <A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(Layer.provide(orchestratorLayer, sqliteLayer(path))),
    Effect.scoped
  )

describe("durable coordinator orchestrator", () => {
  it.effect("accepts idempotent typed commands and records the complete lifecycle", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-orchestrator-"))
    const path = join(root, "orchestrator.sqlite")
    return Effect.acquireUseRelease(
      withDatabase(
        path,
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          const first = yield* orchestrator.submit(command, "dispatch:1")
          const replay = yield* orchestrator.submit(command, "dispatch:1")
          expect(replay).toEqual(first)
          expect(yield* orchestrator.queue(first.dispatchRequestId)).toMatchObject({ type: "queued" })
          expect(yield* orchestrator.run(first.dispatchRequestId)).toMatchObject({ type: "running" })
          expect(yield* orchestrator.settle(first.dispatchRequestId, "checked")).toMatchObject({ type: "settled" })
          const events = yield* Stream.runCollect(orchestrator.events(first.dispatchRequestId))
          expect(events.map(({ type }) => type)).toEqual([
            "accepted",
            "queued",
            "running",
            "settled"
          ])
        })
      ),
      () => Effect.void,
      () => Effect.sync(() => rmSync(root, { force: true, recursive: true }))
    )
  })

  it.effect("fails closed on idempotency conflicts and recovers running work without retry", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-orchestrator-recovery-"))
    const path = join(root, "orchestrator.sqlite")
    return Effect.acquireUseRelease(
      withDatabase(
        path,
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          const first = yield* orchestrator.submit(command, "dispatch:conflict")
          const changed = { ...command, activityIdempotencyKey: "activity:changed" }
          expect(yield* Effect.result(orchestrator.submit(changed, "dispatch:conflict"))).toMatchObject({
            failure: { _tag: "OrchestratorConflictError" }
          })
          expect(yield* Effect.result(orchestrator.submit(command, "dispatch:other"))).toMatchObject({
            failure: { _tag: "OrchestratorConflictError" }
          })
          yield* orchestrator.queue(first.dispatchRequestId)
          yield* orchestrator.run(first.dispatchRequestId)
          const recovered = yield* orchestrator.recover()
          expect(recovered.map(({ type }) => type)).toEqual(["delivery_failed"])
          expect((yield* Stream.runCollect(orchestrator.events(first.dispatchRequestId))).at(-1)?.type).toBe(
            "delivery_failed"
          )
        })
      ),
      () => Effect.void,
      () => Effect.sync(() => rmSync(root, { force: true, recursive: true }))
    )
  })

  it.effect("recovers a running dispatch from the durable database after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-orchestrator-restart-"))
    const path = join(root, "orchestrator.sqlite")
    return Effect.acquireUseRelease(
      Effect.gen(function*() {
        const requestId = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:restart:1" },
              "dispatch:restart"
            )
            yield* orchestrator.queue(receipt.dispatchRequestId)
            yield* orchestrator.run(receipt.dispatchRequestId)
            return receipt.dispatchRequestId
          })
        )
        const recovered = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.recover()
          })
        )
        expect(recovered).toHaveLength(1)
        expect(recovered[0]?.dispatchRequestId).toBe(requestId)
        expect(recovered[0]?.type).toBe("delivery_failed")
      }),
      () => Effect.void,
      () => Effect.sync(() => rmSync(root, { force: true, recursive: true }))
    )
  })

  it.effect("provides Effect SingleRunner with SQL-backed MessageStorage", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-single-runner-"))
    const path = join(root, "cluster.sqlite")
    return Effect.acquireUseRelease(
      Effect.scoped(
        Effect.gen(function*() {
          const storage = yield* MessageStorage.MessageStorage
          expect(storage).toBeDefined()
        }).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(Layer.provide(singleRunnerLayer, sqliteLayer(path)))
        )
      ),
      () => Effect.void,
      () => Effect.sync(() => rmSync(root, { force: true, recursive: true }))
    )
  })
})
