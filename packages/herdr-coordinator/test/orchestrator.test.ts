import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { ClusterSchema, Entity, MessageStorage, RunnerAddress, SingleRunner } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
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

const withTemporaryRoot = <A, E, R>(
  prefix: string,
  use: (root: string) => Effect.Effect<A, E, R>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), prefix))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      return yield* use(root)
    })
  )

const DurableEntity = Entity.make("HerdrDurableTestEntity", [
  Rpc.make("Echo", {
    payload: { value: Schema.String },
    success: Schema.String
  }).annotate(ClusterSchema.Persisted, true)
])

const DurableEntityLayer = DurableEntity.toLayer({
  Echo: ({ payload }) => Effect.succeed(payload.value)
})

const testSingleRunnerLayer = SingleRunner.layer({
  runnerStorage: "sql",
  shardingConfig: {
    entityMessagePollInterval: 0,
    entityReplyPollInterval: 0,
    refreshAssignmentsInterval: 0,
    runnerAddress: Option.some(RunnerAddress.make("localhost", 34_431)),
    runnerListenAddress: Option.none(),
    shardLockExpiration: 1_000,
    shardLockRefreshInterval: 100
  }
})

describe("durable coordinator orchestrator", () => {
  it.effect("accepts idempotent typed commands and records the complete lifecycle", () => {
    return withTemporaryRoot("herdr-orchestrator-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
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
      ))
  })

  it.effect("fails closed on idempotency conflicts and recovers running work without retry", () => {
    return withTemporaryRoot("herdr-orchestrator-recovery-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
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
      ))
  })

  it.effect("recovers a running dispatch from the durable database after restart", () => {
    return withTemporaryRoot("herdr-orchestrator-restart-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
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
      })
    })
  })

  it.effect("secures SQLite database and journal files", () =>
    withTemporaryRoot("herdr-orchestrator-permissions-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          const receipt = yield* orchestrator.submit(command, "dispatch:permissions")
          yield* orchestrator.queue(receipt.dispatchRequestId)
          const files = readdirSync(root).filter((file) =>
            ["orchestrator.sqlite", "orchestrator.sqlite-wal", "orchestrator.sqlite-shm"].includes(file)
          )
          expect(files).toContain("orchestrator.sqlite")
          for (const file of files) {
            expect(statSync(join(root, file)).mode & 0o777).toBe(0o600)
          }
        })
      )))

  it.effect("runs a durable entity through SingleRunner with SQL storage", () =>
    withTemporaryRoot("herdr-single-runner-", (root) => {
      const path = join(root, "cluster.sqlite")
      return Effect.gen(function*() {
        const result = yield* DurableEntity.client.pipe(
          Effect.flatMap((clientFor) => clientFor("entity-1").Echo({ value: "executed" }))
        )
        expect(result).toBe("executed")
      }).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(DurableEntityLayer.pipe(
          Layer.provideMerge(testSingleRunnerLayer),
          Layer.provide(sqliteLayer(path))
        ))
      )
    }))

  it.effect("provides SQL-backed MessageStorage with the default runner address", () =>
    withTemporaryRoot("herdr-single-runner-storage-", (root) =>
      Effect.scoped(
        Effect.gen(function*() {
          const storage = yield* MessageStorage.MessageStorage
          expect(storage).toBeDefined()
        }).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(Layer.provide(singleRunnerLayer, sqliteLayer(join(root, "cluster.sqlite"))))
        )
      )))
})
