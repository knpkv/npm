import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { WorkStore } from "@knpkv/herdr-work"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ClusterSchema, Entity, MessageStorage, RunnerAddress, SingleRunner } from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  layer as orchestratorLayer,
  Orchestrator,
  type OrchestratorCommand,
  OrchestratorPendingDispatch,
  OrchestratorRequest,
  type OrchestratorRoutedSubmission,
  type OrchestratorWorkLink,
  singleRunnerLayer,
  sqliteLayer
} from "../src/index.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const command: OrchestratorCommand = {
  actor: "coordinator",
  activityIdempotencyKey: "activity:check:1",
  kind: "fleet.job",
  payload: { kind: "nix.check" }
}

const lunaRoute = {
  action: "dispatch",
  linkedRequestId: null,
  model: "gpt-5.6-luna",
  protocol: "hostd.coordinator.route.v1",
  reason: "bounded coordination uses Luna",
  reasoningEffort: "medium"
} satisfies OrchestratorRoutedSubmission["route"]

const makeWorkLink = (lineage: ReadonlyArray<string>): OrchestratorWorkLink => ({
  handoff: {
    decision: "handoff",
    goalId: "goal:escalation",
    id: "handoff:escalation",
    laneId: "lane:escalation",
    occurredAt: 0,
    owner: { id: "agent:coordinator", name: "Coordinator" },
    summary: "Escalate the failed Luna request to Sol",
    version: "herdr.work.decision.v1"
  },
  lineage
})

const makeSolSubmission = (
  parentDispatchRequestId: string | null,
  idempotencyKey: string
): OrchestratorRoutedSubmission => ({
  command: { ...command, activityIdempotencyKey: `activity:${idempotencyKey}` },
  idempotencyKey,
  route: {
    action: "dispatch",
    linkedRequestId: parentDispatchRequestId,
    model: "gpt-5.6-sol",
    protocol: "hostd.coordinator.route.v1",
    reason: "failed Luna work requires an explicit linked Sol escalation",
    reasoningEffort: "high"
  },
  workLink: makeWorkLink(parentDispatchRequestId === null ? [] : [parentDispatchRequestId])
})

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

  it.effect("persists executable route metadata for typed request lookup", () =>
    withTemporaryRoot("herdr-orchestrator-route-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.submitRouted({
              command: { ...command, activityIdempotencyKey: "activity:route-luna" },
              idempotencyKey: "dispatch:route-luna",
              route: lunaRoute,
              workLink: null
            })
          })
        )
        const request = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.request(receipt.dispatchRequestId)
          })
        )
        expect(request).toMatchObject({
          activityIdempotencyKey: "activity:route-luna",
          command: { activityIdempotencyKey: "activity:route-luna" },
          dispatchRequestId: receipt.dispatchRequestId,
          route: lunaRoute,
          status: "accepted",
          workLink: null
        })
      })
    }))

  it.effect("atomically binds a failed-Luna Sol dispatch to its Work lineage", () =>
    withTemporaryRoot("herdr-orchestrator-work-link-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const linked = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: { ...command, activityIdempotencyKey: "activity:route-failed-luna" },
              idempotencyKey: "dispatch:route-failed-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            yield* orchestrator.failTask(luna.dispatchRequestId, "Luna task failed")
            const sol = yield* orchestrator.submitRouted(makeSolSubmission(
              luna.dispatchRequestId,
              "dispatch:route-sol"
            ))
            return yield* orchestrator.request(sol.dispatchRequestId)
          })
        )
        expect(linked.route).toEqual({
          action: "dispatch",
          linkedRequestId: linked.workLink?.lineage[0] ?? null,
          model: "gpt-5.6-sol",
          protocol: "hostd.coordinator.route.v1",
          reason: "failed Luna work requires an explicit linked Sol escalation",
          reasoningEffort: "high"
        })
        expect(linked.workLink?.handoff).toMatchObject({
          decision: "handoff",
          goalId: "goal:escalation",
          laneId: "lane:escalation"
        })

        const database = new DatabaseSync(path)
        const counts = database.prepare(
          `SELECT
             (SELECT COUNT(*) FROM orchestrator_dispatches) AS dispatches,
             (SELECT COUNT(*) FROM orchestrator_dispatch_metadata) AS metadata,
             (SELECT COUNT(*) FROM orchestrator_events WHERE type = 'accepted') AS accepted`
        ).get()
        database.close()
        expect(
          Schema.decodeUnknownSync(Schema.Struct({
            accepted: Schema.Number,
            dispatches: Schema.Number,
            metadata: Schema.Number
          }))(counts)
        ).toEqual({ accepted: 2, dispatches: 2, metadata: 2 })

        const decisions = yield* Effect.scoped(
          Effect.gen(function*() {
            const store = yield* WorkStore.open(path)
            return yield* store.decisions("lane:escalation")
          }).pipe(provideNodeServices)
        )
        expect(decisions).toHaveLength(1)
        expect(decisions[0]).toMatchObject({
          id: "handoff:escalation",
          laneId: "lane:escalation"
        })
      })
    }))

  it.effect("rejects invalid public route and Work-link combinations", () =>
    Effect.gen(function*() {
      const solRoute = makeSolSubmission(null, "dispatch:schema").route
      const workLink = makeWorkLink([])
      const request = {
        acceptedAt: 0,
        activityIdempotencyKey: command.activityIdempotencyKey,
        command,
        dispatchRequestId: "dispatch:schema",
        idempotencyKey: "idempotency:schema",
        route: solRoute,
        status: "accepted",
        workLink: null
      } satisfies typeof OrchestratorRequest.Encoded
      const pending = {
        ...request,
        status: "accepted"
      } satisfies typeof OrchestratorPendingDispatch.Encoded
      expect(yield* Effect.result(Schema.decodeUnknownEffect(OrchestratorRequest)(request))).toMatchObject({
        failure: { _tag: "SchemaError" }
      })
      expect(
        yield* Effect.result(
          Schema.decodeUnknownEffect(OrchestratorPendingDispatch)({
            ...pending,
            route: solRoute,
            workLink
          })
        )
      ).toMatchObject({ success: expect.anything() })
      expect(
        yield* Effect.result(
          Schema.decodeUnknownEffect(OrchestratorPendingDispatch)({
            ...pending,
            route: solRoute,
            workLink: null
          })
        )
      ).toMatchObject({ failure: { _tag: "SchemaError" } })
    }))

  it.effect("rejects a Sol link whose parent is not failed Luna work before acceptance", () =>
    withTemporaryRoot("herdr-orchestrator-work-link-reject-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: { ...command, activityIdempotencyKey: "activity:route-live-luna" },
              idempotencyKey: "dispatch:route-live-luna",
              route: lunaRoute,
              workLink: null
            })
            return yield* Effect.result(orchestrator.submitRouted(makeSolSubmission(
              luna.dispatchRequestId,
              "dispatch:route-invalid-sol"
            )))
          })
        )
        expect(result).toMatchObject({ failure: { _tag: "OrchestratorValidationError" } })

        const database = new DatabaseSync(path)
        const dispatchCount = database.prepare("SELECT COUNT(*) AS count FROM orchestrator_dispatches").get()
        const metadataCount = database.prepare("SELECT COUNT(*) AS count FROM orchestrator_dispatch_metadata").get()
        database.close()
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(dispatchCount).count).toBe(1)
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(metadataCount).count).toBe(1)
      })
    }))

  it.effect("rolls back Sol acceptance when the Work handoff cannot be recorded", () =>
    withTemporaryRoot("herdr-orchestrator-work-atomicity-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const failedLuna = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: { ...command, activityIdempotencyKey: "activity:atomicity-luna" },
              idempotencyKey: "dispatch:atomicity-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            return yield* orchestrator.failTask(luna.dispatchRequestId, "Luna task failed")
          })
        )
        const database = new DatabaseSync(path)
        database.prepare("UPDATE work_decision_totals SET decision_count = ? WHERE singleton = 1").run(16_384)
        database.close()

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.submitRouted(makeSolSubmission(
              failedLuna.dispatchRequestId,
              "dispatch:atomicity-sol"
            )))
          })
        )
        expect(result).toMatchObject({ failure: { _tag: "OrchestratorStorageError", operation: "submit.work-link" } })

        const remaining = new DatabaseSync(path)
        const counts = remaining.prepare(
          `SELECT
             (SELECT COUNT(*) FROM orchestrator_dispatches) AS dispatches,
             (SELECT COUNT(*) FROM orchestrator_events WHERE type = 'accepted') AS accepted,
             (SELECT COUNT(*) FROM work_dispatch_handoffs) AS workLinks`
        ).get()
        remaining.close()
        expect(
          Schema.decodeUnknownSync(
            Schema.Struct({ accepted: Schema.Number, dispatches: Schema.Number, workLinks: Schema.Number })
          )(counts)
        ).toEqual({
          accepted: 1,
          dispatches: 1,
          workLinks: 0
        })
      })
    }))

  it.effect("converges concurrent identical submissions on one durable receipt", () =>
    withTemporaryRoot("herdr-orchestrator-concurrent-submit-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = withDatabase(
        path,
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          return yield* orchestrator.submit(
            { ...command, activityIdempotencyKey: "activity:concurrent-submit" },
            "dispatch:concurrent-submit"
          )
        })
      )
      return Effect.gen(function*() {
        yield* withDatabase(path, Effect.void)
        const receipts = yield* Effect.all([submission, submission], { concurrency: 2 })
        expect(receipts[0]).toEqual(receipts[1])

        const database = new DatabaseSync(path)
        const dispatchCount = database.prepare("SELECT COUNT(*) AS count FROM orchestrator_dispatches").get()
        const eventCount = database.prepare("SELECT COUNT(*) AS count FROM orchestrator_events").get()
        database.close()
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(dispatchCount).count).toBe(1)
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(eventCount).count).toBe(1)
      })
    }))

  it.effect("rejects a backward transition timestamp before mutation", () =>
    withTemporaryRoot("herdr-orchestrator-timestamp-regression-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          yield* TestClock.setTime(100)
          const orchestrator = yield* Orchestrator
          const receipt = yield* orchestrator.submit(
            { ...command, activityIdempotencyKey: "activity:timestamp-regression" },
            "dispatch:timestamp-regression"
          )
          yield* TestClock.setTime(200)
          yield* orchestrator.queue(receipt.dispatchRequestId)
          yield* TestClock.setTime(199)
          const result = yield* Effect.result(orchestrator.run(receipt.dispatchRequestId))
          expect(result).toMatchObject({
            failure: { _tag: "OrchestratorStorageError", operation: "transition.timestamp-regression" }
          })
          expect(yield* Stream.runCollect(orchestrator.events(receipt.dispatchRequestId))).toHaveLength(2)
        })
      )))

  it.effect("rejects dispatch status and event mismatches before transition", () =>
    withTemporaryRoot("herdr-orchestrator-status-mismatch-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* withDatabase(path, Effect.void)
        const database = new DatabaseSync(path)
        database.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
           VALUES (?, ?, ?, ?, ?, 'queued')`
        ).run(
          "dispatch:status-mismatch",
          "idempotency:status-mismatch",
          "activity:status-mismatch",
          JSON.stringify({ ...command, activityIdempotencyKey: "activity:status-mismatch" }),
          0
        )
        database.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, ?, 'accepted', ?, ?, NULL, NULL)`
        ).run("dispatch:status-mismatch", 0, "activity:status-mismatch", 0)
        database.close()

        const eventsResult = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(Stream.runCollect(orchestrator.events("dispatch:status-mismatch")))
          })
        )
        expect(eventsResult).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "events.status-event-mismatch" }
        })

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.run("dispatch:status-mismatch"))
          })
        )
        expect(result).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "transition.status-event-mismatch" }
        })

        const remaining = new DatabaseSync(path)
        const dispatch = remaining.prepare(
          "SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?"
        ).get("dispatch:status-mismatch")
        const eventCount = remaining.prepare(
          "SELECT COUNT(*) AS count FROM orchestrator_events WHERE dispatch_request_id = ?"
        ).get("dispatch:status-mismatch")
        remaining.close()
        expect(dispatch).toEqual({ status: "queued" })
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(eventCount).count).toBe(1)
      })
    }))

  it.effect("rejects an activity identity mismatch before appending a transition", () =>
    withTemporaryRoot("herdr-orchestrator-activity-mismatch-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* withDatabase(path, Effect.void)
        const database = new DatabaseSync(path)
        database.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
           VALUES (?, ?, ?, ?, ?, 'queued')`
        ).run(
          "dispatch:activity-mismatch",
          "idempotency:activity-mismatch",
          "activity:activity-mismatch:dispatch",
          JSON.stringify({ ...command, activityIdempotencyKey: "activity:activity-mismatch:command" }),
          0
        )
        const insertEvent = database.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, ?, ?, ?, ?, NULL, NULL)`
        )
        insertEvent.run(
          "dispatch:activity-mismatch",
          0,
          "accepted",
          "activity:activity-mismatch:dispatch",
          0
        )
        insertEvent.run(
          "dispatch:activity-mismatch",
          1,
          "queued",
          "activity:activity-mismatch:event",
          1
        )
        database.close()

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.run("dispatch:activity-mismatch"))
          })
        )
        expect(result).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "transition.activity-idempotency-mismatch" }
        })

        const remaining = new DatabaseSync(path)
        const dispatch = remaining.prepare(
          "SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?"
        ).get("dispatch:activity-mismatch")
        const eventCount = remaining.prepare(
          "SELECT COUNT(*) AS count FROM orchestrator_events WHERE dispatch_request_id = ?"
        ).get("dispatch:activity-mismatch")
        remaining.close()
        expect(dispatch).toEqual({ status: "queued" })
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(eventCount).count).toBe(2)
      })
    }))

  it.effect("validates the complete lifecycle chain before appending a transition", () =>
    withTemporaryRoot("herdr-orchestrator-lifecycle-chain-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:lifecycle-chain" },
              "dispatch:lifecycle-chain"
            )
            yield* orchestrator.queue(receipt.dispatchRequestId)
            yield* orchestrator.run(receipt.dispatchRequestId)
            return receipt
          })
        )
        const database = new DatabaseSync(path)
        database.prepare(
          "UPDATE orchestrator_events SET type = 'running' WHERE dispatch_request_id = ? AND sequence = 1"
        ).run(receipt.dispatchRequestId)
        database.close()

        const eventsResult = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(Stream.runCollect(orchestrator.events(receipt.dispatchRequestId)))
          })
        )
        expect(eventsResult).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "transition.lifecycle-chain-mismatch" }
        })

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.settle(receipt.dispatchRequestId, "settled"))
          })
        )
        expect(result).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "transition.lifecycle-chain-mismatch" }
        })

        const remaining = new DatabaseSync(path)
        const status = remaining.prepare(
          "SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?"
        ).get(receipt.dispatchRequestId)
        const eventCount = remaining.prepare(
          "SELECT COUNT(*) AS count FROM orchestrator_events WHERE dispatch_request_id = ?"
        ).get(receipt.dispatchRequestId)
        remaining.close()
        expect(status).toEqual({ status: "running" })
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(eventCount).count).toBe(3)
      })
    }))

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

  it.effect("persists fleet-valid failure details exactly", () =>
    withTemporaryRoot("herdr-orchestrator-details-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          const details = ["", "d".repeat(4_097)]
          for (const [index, detail] of details.entries()) {
            const receipt = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: `activity:detail:${index}` },
              `dispatch:detail:${index}`
            )
            yield* orchestrator.queue(receipt.dispatchRequestId)
            yield* orchestrator.run(receipt.dispatchRequestId)
            const event = index === 0
              ? yield* orchestrator.failDelivery(receipt.dispatchRequestId, detail)
              : yield* orchestrator.failTask(receipt.dispatchRequestId, detail)
            expect(event).toMatchObject({ detail })
            expect((yield* Stream.runCollect(orchestrator.events(receipt.dispatchRequestId))).at(-1)).toEqual(event)
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
          const recovered = yield* Stream.runCollect(orchestrator.recover())
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

  it.effect("validates dispatch IDs before event lookup", () =>
    withTemporaryRoot("herdr-orchestrator-dispatch-id-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* withDatabase(path, Effect.void)
        const database = new DatabaseSync(path)
        database.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
           VALUES (?, ?, ?, ?, ?, 'accepted')`
        ).run(
          "dispatch:\uFFFD",
          "idempotency:dispatch-id",
          "activity:dispatch-id",
          JSON.stringify({ ...command, activityIdempotencyKey: "activity:dispatch-id" }),
          0
        )
        database.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, ?, 'accepted', ?, ?, NULL, NULL)`
        ).run("dispatch:\uFFFD", 0, "activity:dispatch-id", 0)
        database.close()

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const malformed = yield* Effect.result(Stream.runCollect(orchestrator.events("dispatch:\uD800")))
            const malformedTransition = yield* Effect.result(orchestrator.run("dispatch:\uD800"))
            const missingTransition = yield* Effect.result(orchestrator.run("dispatch:missing"))
            const replacement = yield* Stream.runCollect(orchestrator.events("dispatch:\uFFFD"))
            return { malformed, malformedTransition, missingTransition, replacement }
          })
        )
        expect(result.malformed).toMatchObject({
          failure: { _tag: "OrchestratorValidationError", detail: "dispatch request ID is invalid" }
        })
        expect(result.malformedTransition).toMatchObject({
          failure: { _tag: "OrchestratorValidationError", detail: "dispatch request ID is invalid" }
        })
        expect(result.missingTransition).toMatchObject({
          failure: { _tag: "OrchestratorNotFoundError", dispatchRequestId: "dispatch:missing" }
        })
        expect(result.replacement).toHaveLength(1)
        expect(result.replacement[0]?.dispatchRequestId).toBe("dispatch:\uFFFD")
      })
    }))

  it.effect("requires an exact accepted event before replaying a receipt", () =>
    withTemporaryRoot("herdr-orchestrator-receipt-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* withDatabase(path, Effect.void)
        const database = new DatabaseSync(path)
        database.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
           VALUES (?, ?, ?, ?, ?, 'accepted')`
        ).run(
          "dispatch:receipt-valid",
          "idempotency:receipt-valid",
          "activity:receipt-valid",
          JSON.stringify({ ...command, activityIdempotencyKey: "activity:receipt-valid" }),
          0
        )
        database.close()

        const missingEvent = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:receipt-valid" },
              "idempotency:receipt-valid"
            ))
          })
        )
        expect(missingEvent).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "submit.accepted-event-mismatch" }
        })

        const acceptedDatabase = new DatabaseSync(path)
        acceptedDatabase.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, 0, 'accepted', ?, ?, NULL, NULL)`
        ).run("dispatch:receipt-valid", "activity:receipt-valid", 0)
        acceptedDatabase.close()

        const replay = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:receipt-valid" },
              "idempotency:receipt-valid"
            )
          })
        )
        expect(replay).toEqual({
          acceptedAt: 0,
          dispatchRequestId: "dispatch:receipt-valid",
          idempotencyKey: "idempotency:receipt-valid",
          status: "accepted"
        })

        const trailingDatabase = new DatabaseSync(path)
        trailingDatabase.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, 1, 'queued', ?, ?, NULL, NULL)`
        ).run("dispatch:receipt-valid", "activity:receipt-valid", 1)
        trailingDatabase.close()
        const invalidStatusTail = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:receipt-valid" },
              "idempotency:receipt-valid"
            ))
          })
        )
        expect(invalidStatusTail).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "submit.accepted-event-mismatch" }
        })

        const malformedDatabase = new DatabaseSync(path)
        malformedDatabase.prepare(
          "UPDATE orchestrator_events SET activity_idempotency_key = ? WHERE dispatch_request_id = ?"
        ).run("activity:receipt-mismatch", "dispatch:receipt-valid")
        malformedDatabase.close()
        const invalidEvent = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.submit(
              { ...command, activityIdempotencyKey: "activity:receipt-valid" },
              "idempotency:receipt-valid"
            ))
          })
        )
        expect(invalidEvent).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "submit.accepted-event-mismatch" }
        })
      })
    }))

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
            return yield* Stream.runCollect(orchestrator.recover())
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

  it.effect("rejects incomplete queued lifecycle history from pending", () =>
    withTemporaryRoot("herdr-orchestrator-pending-invalid-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* withDatabase(path, Effect.void)
        const database = new DatabaseSync(path)
        database.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
           VALUES (?, ?, ?, ?, ?, 'queued')`
        ).run(
          "dispatch:pending-invalid",
          "idempotency:pending-invalid",
          "activity:pending-invalid",
          JSON.stringify({ ...command, activityIdempotencyKey: "activity:pending-invalid" }),
          0
        )
        database.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, ?, 'accepted', ?, ?, NULL, NULL)`
        ).run("dispatch:pending-invalid", 0, "activity:pending-invalid", 0)
        database.close()

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.pending())
          })
        )
        expect(result).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "events.status-event-mismatch" }
        })
      })
    }))

  it.effect("recovers running dispatches page by page", () =>
    withTemporaryRoot("herdr-orchestrator-recovery-pages-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const total = 257
      return Effect.gen(function*() {
        yield* withDatabase(path, Effect.void)
        const database = new DatabaseSync(path)
        database.exec("BEGIN IMMEDIATE")
        const insertDispatch = database.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
           VALUES (?, ?, ?, ?, ?, 'running')`
        )
        const insertEvent = database.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, ?, ?, ?, ?, NULL, NULL)`
        )
        for (let index = 0; index < total; index += 1) {
          const dispatchRequestId = `dispatch:recovery-page:${index}`
          const activityIdempotencyKey = `activity:recovery-page:${index}`
          const encodedCommand = JSON.stringify({ ...command, activityIdempotencyKey })
          insertDispatch.run(
            dispatchRequestId,
            `idempotency:recovery-page:${index}`,
            activityIdempotencyKey,
            encodedCommand,
            index
          )
          insertEvent.run(dispatchRequestId, 0, "accepted", activityIdempotencyKey, index)
          insertEvent.run(dispatchRequestId, 1, "queued", activityIdempotencyKey, index)
          insertEvent.run(dispatchRequestId, 2, "running", activityIdempotencyKey, index)
        }
        database.exec("COMMIT")
        database.close()

        yield* TestClock.setTime(total)
        const recovered = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Stream.runCollect(orchestrator.recover())
          })
        )
        expect(recovered).toHaveLength(total)
        expect(recovered.every(({ type }) => type === "delivery_failed")).toBe(true)
        const remaining = new DatabaseSync(path)
        const runningRow = remaining.prepare(
          "SELECT COUNT(*) AS count FROM orchestrator_dispatches WHERE status = 'running'"
        ).get()
        remaining.close()
        const running = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(runningRow)
        expect(running.count).toBe(0)
      })
    }))

  it.effect("drains concurrent recovery races without overwriting terminal dispatches", () =>
    withTemporaryRoot("herdr-orchestrator-recovery-race-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            for (const index of [0, 1]) {
              const receipt = yield* orchestrator.submit(
                { ...command, activityIdempotencyKey: `activity:recovery-race:${index}` },
                `dispatch:recovery-race:${index}`
              )
              yield* orchestrator.queue(receipt.dispatchRequestId)
              yield* orchestrator.run(receipt.dispatchRequestId)
            }
          })
        )

        const recovered = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.all(
              [Stream.runCollect(orchestrator.recover()), Stream.runCollect(orchestrator.recover())],
              { concurrency: 2 }
            )
          })
        )
        const recoveryEvents = recovered.flatMap((events) => [...events])
        expect(recoveryEvents).toHaveLength(2)
        expect(recoveryEvents.every(({ type }) => type === "delivery_failed")).toBe(true)

        const remaining = new DatabaseSync(path)
        const runningRow = remaining.prepare(
          "SELECT COUNT(*) AS count FROM orchestrator_dispatches WHERE status = 'running'"
        ).get()
        remaining.close()
        const running = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(runningRow)
        expect(running.count).toBe(0)
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
          const database = new DatabaseSync(join(root, "orchestrator.sqlite"))
          const pendingPlans = [
            database.prepare(
              `EXPLAIN QUERY PLAN
               SELECT dispatch_request_id FROM orchestrator_dispatches
               WHERE status IN ('accepted', 'queued')
               ORDER BY accepted_at ASC, dispatch_request_id ASC
               LIMIT 2`
            ).all(),
            database.prepare(
              `EXPLAIN QUERY PLAN
               SELECT dispatch_request_id FROM orchestrator_dispatches
               WHERE status IN ('accepted', 'queued')
                 AND (accepted_at > ? OR (accepted_at = ? AND dispatch_request_id > ?))
               ORDER BY accepted_at ASC, dispatch_request_id ASC
               LIMIT 2`
            ).all(0, 0, "dispatch:pending-page:0")
          ]
          database.close()
          expect(pendingPlans.every((plan) =>
            plan.some((row) => String(row.detail).includes("orchestrator_pending_dispatches_order"))
          )).toBe(true)
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

        const realStateDirectory = join(root, "real-state")
        mkdirSync(realStateDirectory, { mode: 0o700 })
        const linkedStateDirectory = join(root, "linked-state")
        symlinkSync(realStateDirectory, linkedStateDirectory)
        const linkedState = yield* Effect.result(
          withDatabase(join(linkedStateDirectory, "orchestrator.sqlite"), Effect.void)
        )
        expect(linkedState).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "OrchestratorStorageError", operation: "sqlite.secure.directory.path-identity" }
        })
        expect(readdirSync(realStateDirectory)).toEqual([])

        const realAncestor = join(root, "real-ancestor")
        const realNestedState = join(realAncestor, "nested-state")
        mkdirSync(realNestedState, { mode: 0o700, recursive: true })
        const linkedAncestor = join(root, "linked-ancestor")
        symlinkSync(realAncestor, linkedAncestor)
        const linkedAncestorState = yield* Effect.result(
          withDatabase(join(linkedAncestor, "nested-state", "orchestrator.sqlite"), Effect.void)
        )
        expect(linkedAncestorState).toMatchObject({ _tag: "Success" })
      })))

  it.effect("rejects SQLite database and journal path substitutions", () =>
    withTemporaryRoot("herdr-orchestrator-path-identity-", (root) =>
      Effect.gen(function*() {
        const stateDirectory = join(root, "state")
        mkdirSync(stateDirectory, { mode: 0o700 })
        const realDatabase = join(stateDirectory, "real.sqlite")
        yield* withDatabase(realDatabase, Effect.void)

        const linkedDatabase = join(stateDirectory, "linked.sqlite")
        symlinkSync(realDatabase, linkedDatabase)
        const databaseResult = yield* Effect.result(withDatabase(linkedDatabase, Effect.void))
        expect(databaseResult).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "OrchestratorStorageError", operation: "sqlite.secure.path-identity" }
        })

        const journalTarget = join(stateDirectory, "journal-target")
        writeFileSync(journalTarget, "journal target")
        const journal = `${realDatabase}-wal`
        symlinkSync(journalTarget, journal)
        const journalResult = yield* Effect.result(withDatabase(realDatabase, Effect.void))
        expect(journalResult).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "OrchestratorStorageError", operation: "sqlite.secure.path-identity" }
        })
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
