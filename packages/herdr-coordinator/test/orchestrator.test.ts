import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { ClusterSchema, Entity, MessageStorage, RunnerAddress, SingleRunner } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
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

  it.effect("settles empty and fleet-sized results", () =>
    withTemporaryRoot("herdr-orchestrator-results-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          const results = ["", "r".repeat(4_097)]
          for (const [index, result] of results.entries()) {
            const receipt = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: `activity:settle:${index}` },
              `dispatch:settle:${index}`
            )
            yield* orchestrator.queue(receipt.dispatchRequestId)
            yield* orchestrator.run(receipt.dispatchRequestId)
            expect(yield* orchestrator.settle(receipt.dispatchRequestId, result)).toMatchObject({
              result,
              type: "settled"
            })
          }
        })
      )))

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

  it.effect("rejects malformed activity idempotency keys before persistence", () =>
    withTemporaryRoot("herdr-orchestrator-identity-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          expect(
            yield* Effect.result(orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:\uD800" },
              "dispatch:malformed-activity"
            ))
          ).toMatchObject({ failure: { _tag: "OrchestratorValidationError" } })
          expect(
            yield* Effect.result(orchestrator.submit(
              command,
              "dispatch:\uD800"
            ))
          ).toMatchObject({ failure: { _tag: "OrchestratorValidationError" } })
        })
      )))

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

  it.effect("discovers accepted and queued dispatches for explicit restart resumption", () =>
    withTemporaryRoot("herdr-orchestrator-pending-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const created = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:pending:accepted" },
              "dispatch:pending:accepted"
            )
            const queued = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:pending:queued" },
              "dispatch:pending:queued"
            )
            yield* orchestrator.queue(queued.dispatchRequestId)
            return { accepted, queued }
          })
        )
        const pending = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.pending()
          })
        )
        expect(pending).toHaveLength(2)
        expect(pending.find(({ status }) => status === "accepted")).toEqual({
          ...created.accepted,
          activityIdempotencyKey: "activity:pending:accepted",
          command: { ...command, activityIdempotencyKey: "activity:pending:accepted" },
          status: "accepted"
        })
        expect(pending.find(({ status }) => status === "queued")).toEqual({
          ...created.queued,
          activityIdempotencyKey: "activity:pending:queued",
          command: { ...command, activityIdempotencyKey: "activity:pending:queued" },
          status: "queued"
        })
        const resumed = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            yield* orchestrator.queue(created.accepted.dispatchRequestId)
            const acceptedRunning = yield* orchestrator.run(created.accepted.dispatchRequestId)
            const queuedRunning = yield* orchestrator.run(created.queued.dispatchRequestId)
            return [acceptedRunning.type, queuedRunning.type]
          })
        )
        expect(resumed).toEqual(["running", "running"])
        const noPending = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.pending()
          })
        )
        expect(noPending).toEqual([])
      })
    }))

  it.effect("pages pending restart work with a bounded typed query", () =>
    withTemporaryRoot("herdr-orchestrator-pending-page-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          const receipts = yield* Effect.forEach([0, 1, 2], (index) =>
            orchestrator.submit(
              { ...command, activityIdempotencyKey: `activity:pending-page:${index}` },
              `dispatch:pending-page:${index}`
            ))
          const first = yield* orchestrator.pending({ limit: 2 })
          expect(first).toHaveLength(2)
          const cursor = first.at(-1)
          if (cursor === undefined) return yield* Effect.die("pending page did not return its limit")
          const second = yield* orchestrator.pending({
            after: {
              acceptedAt: cursor.acceptedAt,
              dispatchRequestId: cursor.dispatchRequestId
            },
            limit: 2
          })
          expect(second).toHaveLength(1)
          expect([...first, ...second].map(({ dispatchRequestId }) => dispatchRequestId)).toEqual(
            receipts
              .toSorted((left, right) =>
                left.acceptedAt - right.acceptedAt || left.dispatchRequestId.localeCompare(right.dispatchRequestId)
              )
              .map(({ dispatchRequestId }) => dispatchRequestId)
          )
        })
      )))

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

  it.effect("creates only a private SQLite state directory and never rewrites a caller directory", () =>
    withTemporaryRoot("herdr-orchestrator-directory-security-", (root) =>
      Effect.gen(function*() {
        const createdDirectory = join(root, "created-state")
        const created = yield* Effect.result(
          withDatabase(
            join(createdDirectory, "orchestrator.sqlite"),
            Effect.void
          )
        )
        expect(created).toMatchObject({ _tag: "Success" })
        expect(statSync(createdDirectory).mode & 0o777).toBe(0o700)

        const nestedDirectory = join(root, "nested", "state")
        const nested = yield* Effect.result(
          withDatabase(join(nestedDirectory, "orchestrator.sqlite"), Effect.void)
        )
        expect(nested).toMatchObject({ _tag: "Success" })
        expect(statSync(nestedDirectory).mode & 0o777).toBe(0o700)

        const callerDirectory = join(root, "caller-state")
        mkdirSync(callerDirectory, { mode: 0o755 })
        const rejected = yield* Effect.result(
          withDatabase(
            join(callerDirectory, "orchestrator.sqlite"),
            Effect.void
          )
        )
        expect(rejected).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "OrchestratorStorageError", operation: "sqlite.secure.directory.private" }
        })
        expect(statSync(callerDirectory).mode & 0o777).toBe(0o755)
      })))

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
