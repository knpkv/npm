import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { makeWorkService, WorkAgentBinding, WorkGoalCheckpoint, WorkLaneClaimed, WorkStore } from "@knpkv/herdr-work"
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execPath } from "node:process"
import { DatabaseSync } from "node:sqlite"
import {
  Orchestrator,
  type OrchestratorCommand,
  OrchestratorDispatchActivation,
  OrchestratorPendingDispatch,
  OrchestratorRequest,
  OrchestratorRoutedSubmission,
  type OrchestratorWorkLink,
  sqliteLayer
} from "../src/index.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

class LegacyWriterError extends Schema.TaggedError<LegacyWriterError>()(
  "LegacyWriterError",
  { cause: Schema.String }
) {}

const command: OrchestratorCommand = {
  actor: "coordinator",
  activityIdempotencyKey: "activity:check:1",
  kind: "fleet.job",
  payload: { kind: "nix.check" }
}

const startedWorker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
  agentId: "agent-package-worker",
  host: "SER8",
  name: "Package worker",
  paneId: "wE:p3"
})

const migrationBinding = (
  dispatchRequestId: string,
  lane: WorkLaneClaimed,
  occurredAt: number
): WorkAgentBinding =>
  Schema.decodeUnknownSync(WorkAgentBinding)({
    checkpoint: {
      eventId: dispatchRequestId,
      goal: {
        agentHierarchy: { agent: startedWorker },
        blocker: null,
        connectTarget: {
          agentId: startedWorker.agentId,
          host: startedWorker.host,
          url: `/connect/?agent=${startedWorker.agentId}&host=${startedWorker.host}`
        },
        createdAt: 0,
        delivery: "local",
        detail: "Migration authority",
        id: lane.goalId,
        owner: lane.owner,
        repository: { branch: lane.branch, repository: "npm" },
        spend: null,
        state: "working",
        summary: "Migration authority",
        title: lane.goalId,
        updatedAt: occurredAt
      },
      occurredAt,
      version: "herdr.work.event.v1"
    },
    lane,
    request: {
      dispatchRequestId,
      expectedRevision: lane.expectedRevision,
      laneId: lane.laneId,
      version: "herdr.work.agent-binding-request.v1",
      worker: startedWorker
    },
    version: "herdr.work.agent-binding.v1"
  })

const persistMigrationBindingCompanions = (
  database: DatabaseSync,
  binding: WorkAgentBinding
): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS work_goal_events (
      event_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      record TEXT NOT NULL, transaction_id TEXT, UNIQUE (goal_id, occurred_at)
    );
    CREATE TABLE IF NOT EXISTS work_lane_operations (
      operation_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, goal_id TEXT NOT NULL,
      phase TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL
    );
  `)
  database.prepare("INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)")
    .run(
      binding.checkpoint.eventId,
      binding.checkpoint.goal.id,
      binding.checkpoint.occurredAt,
      JSON.stringify(binding.checkpoint)
    )
  database.prepare("INSERT INTO work_lane_operations VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      binding.lane.operationId,
      binding.lane.laneId,
      binding.lane.goalId,
      binding.lane.phase,
      binding.lane.revision,
      JSON.stringify(binding.lane)
    )
}

const persistMigrationLifecycle = (
  database: DatabaseSync,
  dispatchRequestId: string,
  runningAt: number,
  status: "queued" | "running" | "settled" | "delivery_failed" | "task_failed",
  mode: "consult" | "work"
): void => {
  const activityIdempotencyKey = `activity:${dispatchRequestId}`
  const acceptedAt = Math.max(0, runningAt - 2)
  database.exec(`
    CREATE TABLE IF NOT EXISTS orchestrator_dispatches (
      dispatch_request_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      activity_idempotency_key TEXT NOT NULL, command TEXT NOT NULL,
      accepted_at INTEGER NOT NULL, is_routed INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orchestrator_events (
      dispatch_request_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
      activity_idempotency_key TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      detail TEXT, result TEXT, PRIMARY KEY (dispatch_request_id, sequence)
    );
  `)
  database.prepare("INSERT INTO orchestrator_dispatches VALUES (?, ?, ?, ?, ?, 1, ?)").run(
    dispatchRequestId,
    `idempotency:${dispatchRequestId}`,
    activityIdempotencyKey,
    JSON.stringify({
      activityIdempotencyKey,
      actor: "coordinator",
      kind: "fleet.job",
      payload: { kind: "agent.delegate", mode, prompt: "Migrate", repository: "/repo" }
    }),
    acceptedAt,
    status
  )
  const insert = database.prepare("INSERT INTO orchestrator_events VALUES (?, ?, ?, ?, ?, ?, ?)")
  insert.run(dispatchRequestId, 0, "accepted", activityIdempotencyKey, acceptedAt, null, null)
  insert.run(dispatchRequestId, 1, "queued", activityIdempotencyKey, Math.max(acceptedAt, runningAt - 1), null, null)
  if (status !== "queued") insert.run(dispatchRequestId, 2, "running", activityIdempotencyKey, runningAt, null, null)
  if (status === "settled") {
    insert.run(dispatchRequestId, 3, "settled", activityIdempotencyKey, runningAt + 1, null, "done")
  } else if (status === "delivery_failed" || status === "task_failed") {
    insert.run(dispatchRequestId, 3, status, activityIdempotencyKey, runningAt + 1, "failed", null)
  }
}

const lunaRoute = {
  action: "dispatch",
  linkedRequestId: null,
  model: "gpt-5.6-luna",
  protocol: "hostd.coordinator.route.v1",
  reason: "bounded coordination uses Luna",
  reasoningEffort: "medium"
} satisfies OrchestratorRoutedSubmission["route"]

const makeLunaCommand = <Mode extends "consult" | "transition_summary">(
  mode: Mode,
  activityIdempotencyKey: string
) =>
  ({
    activityIdempotencyKey,
    actor: command.actor,
    kind: "fleet.job",
    payload: {
      kind: "agent.delegate",
      mode,
      prompt: "Run bounded coordination",
      repository: "npm"
    }
  }) satisfies OrchestratorRoutedSubmission["command"]

const makeWorkLink = (lineage: ReadonlyArray<string>): OrchestratorWorkLink => ({
  handoff: {
    blockers: [{ id: "luna-failed", detail: "The linked Luna request failed" }],
    contextDelta: "Preserve the failed Luna evidence for the Sol worker",
    decision: "handoff",
    dispatchIds: lineage,
    evidenceRefs: [{ id: "linked-request", kind: "review", reference: "linked Luna terminal event" }],
    expectedRevision: 1,
    goalId: "goal:escalation",
    id: "handoff:escalation",
    laneId: "lane:escalation",
    occurredAt: 0,
    owner: { id: "agent:coordinator", name: "Coordinator" },
    sessionId: "session:escalation",
    summary: "Escalate the failed Luna request to Sol",
    version: "herdr.work.decision.v2"
  },
  lineage
})

const makeSolSubmission = (
  parentDispatchRequestId: string | null,
  idempotencyKey: string
): OrchestratorRoutedSubmission => ({
  command: {
    activityIdempotencyKey: `activity:${idempotencyKey}`,
    actor: command.actor,
    kind: "fleet.job",
    payload: {
      kind: "agent.delegate",
      mode: "work",
      prompt: "Execute the accepted Work handoff",
      repository: "npm"
    }
  },
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

const recordWorkAuthority = (path: string, workLink: OrchestratorWorkLink) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      yield* service.record({
        eventId: `created:${workLink.handoff.goalId}`,
        goal: {
          blocker: null,
          connectTarget: null,
          createdAt: 0,
          delivery: "local",
          detail: "Durable coordinator Work goal",
          id: workLink.handoff.goalId,
          owner: workLink.handoff.owner,
          repository: { branch: "feat/herdr-npm-packages", repository: "npm" },
          spend: null,
          state: "working",
          summary: "Exercise routed worker activation",
          title: "Coordinator activation",
          updatedAt: 0
        },
        occurredAt: 0,
        version: "herdr.work.event.v1"
      })
      const claim = yield* service.claim({
        branch: "feat/herdr-npm-packages",
        expectedRevision: 0,
        goalId: workLink.handoff.goalId,
        head: "0123456789012345678901234567890123456789",
        laneId: workLink.handoff.laneId,
        operationId: `operation:${workLink.handoff.laneId}`,
        owner: workLink.handoff.owner,
        parent: null,
        phase: "implementation",
        worktree: "/home/konopkov/Work/dev/knpkv.dev/worktrees/npm/feat/herdr-npm-packages"
      })
      yield* TestClock.setTime(1)
      return claim
    }).pipe(provideNodeServices)
  )

const withDatabase = <A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(sqliteLayer(path)),
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

describe("durable coordinator orchestrator", () => {
  it("exports the Nix-consumer worker-start activation contract", () => {
    expect(
      Schema.decodeUnknownResult(OrchestratorDispatchActivation)({
        dispatchRequestId: "dispatch:worker-start",
        expectedRevision: 1,
        laneId: "lane:escalation",
        version: "herdr.work.agent-binding-request.v1",
        worker: startedWorker
      })._tag
    ).toBe("Success")
  })

  it.effect("atomically activates a dispatch and its Work agent binding, including restart replay", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const activation = Schema.decodeUnknownSync(OrchestratorDispatchActivation)({
          dispatchRequestId: "placeholder",
          expectedRevision: lane.revision,
          laneId: lane.laneId,
          version: "herdr.work.agent-binding-request.v1",
          worker: startedWorker
        })
        const first = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            expect(yield* Effect.result(orchestrator.run(receipt.dispatchRequestId))).toMatchObject({
              failure: { _tag: "OrchestratorValidationError" }
            })
            return yield* orchestrator.workerStarted({
              ...activation,
              dispatchRequestId: receipt.dispatchRequestId
            })
          })
        )
        expect(first).toMatchObject({
          binding: {
            checkpoint: {
              goal: {
                agentHierarchy: { agent: startedWorker },
                connectTarget: { agentId: startedWorker.agentId, host: startedWorker.host }
              }
            },
            lane: { expectedRevision: lane.revision, revision: lane.revision + 1 }
          },
          event: { type: "running" }
        })
        expect(first.event.occurredAt).toBe(first.binding.checkpoint.occurredAt)

        const replay = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.workerStarted(first.binding.request)
          })
        )
        expect(replay).toEqual(first)

        const terminalReplay = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const terminal = yield* orchestrator.failDelivery(
              first.event.dispatchRequestId,
              "delivery failed after worker start"
            )
            return {
              activation: yield* orchestrator.workerStarted(first.binding.request),
              terminal
            }
          })
        )
        expect(terminalReplay).toEqual({
          activation: first,
          terminal: expect.objectContaining({
            type: "delivery_failed"
          })
        })

        const store = yield* Effect.acquireRelease(
          WorkStore.open(path).pipe(provideNodeServices),
          (store) => Effect.sync(() => store.close())
        )
        const work = yield* makeWorkService(store)
        expect(Option.getOrThrow(yield* work.agentBinding(first.event.dispatchRequestId))).toEqual(first.binding)
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                ...first.binding.request,
                worker: { ...startedWorker, agentId: "agent-conflicting-worker" }
              })
            })
          ))
        ).toMatchObject({
          failure: {
            _tag: "OrchestratorWorkerBindingConflictError",
            dispatchRequestId: first.event.dispatchRequestId
          }
        })
      })
    }))

  it.effect("rejects activation that refreshes the accepted Work lane revision", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-revision-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:accepted-revision")
      return Effect.gen(function*() {
        const acceptedLane = yield* recordWorkAuthority(path, submission.workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        const store = yield* Effect.acquireRelease(
          WorkStore.open(path).pipe(provideNodeServices),
          (opened) => Effect.sync(() => opened.close())
        )
        const work = yield* makeWorkService(store)
        const advancedLane = yield* work.claim({
          branch: acceptedLane.branch,
          expectedRevision: acceptedLane.revision,
          goalId: acceptedLane.goalId,
          head: acceptedLane.head,
          laneId: acceptedLane.laneId,
          operationId: "claim:advanced-after-acceptance",
          owner: acceptedLane.owner,
          parent: acceptedLane.parent,
          phase: "validation",
          worktree: acceptedLane.worktree
        })
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: advancedLane.revision,
                laneId: advancedLane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              })
            })
          ))
        ).toMatchObject({
          failure: {
            _tag: "OrchestratorWorkerStartAuthorityError",
            actualRevision: advancedLane.revision,
            expectedRevision: acceptedLane.revision,
            laneId: acceptedLane.laneId,
            reason: "accepted_revision_mismatch"
          }
        })
      })
    }))

  it.effect("repairs the pre-agent-binding Work schema before coordinator-owned activation", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-schema-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start-schema")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const database = new DatabaseSync(path)
        database.exec(`
          DROP TRIGGER work_lane_operations_after_insert;
          DROP TABLE work_lane_operation_totals;
          DROP TABLE work_lane_operations;
        `)
        database.close()

        const activation = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            return yield* orchestrator.workerStarted({
              dispatchRequestId: receipt.dispatchRequestId,
              expectedRevision: lane.revision,
              laneId: lane.laneId,
              version: "herdr.work.agent-binding-request.v1",
              worker: startedWorker
            })
          })
        )
        expect(activation.binding.lane.revision).toBe(lane.revision + 1)
        const repaired = new DatabaseSync(path, { readOnly: true })
        expect(
          repaired.prepare(
            `SELECT operation_count AS operationCount
             FROM work_lane_operation_totals WHERE singleton = 1`
          ).get()
        ).toEqual({ operationCount: 2 })
        repaired.close()
      })
    }))

  it.effect("allocates a monotonic Work checkpoint when worker start shares the current Work tick", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-same-tick-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start-same-tick")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        yield* Effect.scoped(
          Effect.gen(function*() {
            const store = yield* WorkStore.open(path)
            yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
            const work = yield* makeWorkService(store)
            const current = (yield* work.snapshots(1)).now.goals[0]
            if (current === undefined) return yield* Effect.die("missing seeded Work goal")
            yield* work.record({
              eventId: "event:same-tick-authority",
              goal: { ...current, updatedAt: 1 },
              occurredAt: 1,
              version: "herdr.work.event.v1"
            })
          }).pipe(provideNodeServices)
        )
        const lifecycle = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            const activation = yield* orchestrator.workerStarted({
              dispatchRequestId: receipt.dispatchRequestId,
              expectedRevision: lane.revision,
              laneId: lane.laneId,
              version: "herdr.work.agent-binding-request.v1",
              worker: startedWorker
            })
            const terminal = yield* orchestrator.settle(receipt.dispatchRequestId, "same tick complete")
            return { activation, terminal }
          })
        )
        expect(lifecycle.activation.binding.checkpoint.occurredAt).toBe(2)
        expect(lifecycle.activation.event.occurredAt).toBe(2)
        expect(lifecycle.terminal).toMatchObject({ occurredAt: 2, type: "settled" })
        const projection = yield* Effect.scoped(
          Effect.gen(function*() {
            const store = yield* WorkStore.open(path)
            yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
            const work = yield* makeWorkService(store)
            return yield* work.snapshots()
          }).pipe(provideNodeServices)
        )
        expect(projection.now.goals[0]).toMatchObject({
          agentHierarchy: { agent: startedWorker },
          updatedAt: 2
        })
      })
    }))

  it.effect("rejects queued replay when a persisted binding lost its lane-operation companion", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-partial-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start-partial")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const activation = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            return yield* orchestrator.workerStarted({
              dispatchRequestId: receipt.dispatchRequestId,
              expectedRevision: lane.revision,
              laneId: lane.laneId,
              version: "herdr.work.agent-binding-request.v1",
              worker: startedWorker
            })
          })
        )
        const database = new DatabaseSync(path)
        database.prepare("DELETE FROM work_lane_operations WHERE operation_id = ?")
          .run(activation.binding.lane.operationId)
        database.prepare("DELETE FROM orchestrator_events WHERE dispatch_request_id = ? AND type = 'running'")
          .run(activation.event.dispatchRequestId)
        database.prepare("UPDATE orchestrator_dispatches SET status = 'queued' WHERE dispatch_request_id = ?")
          .run(activation.event.dispatchRequestId)
        database.close()

        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted(activation.binding.request)
            })
          ))
        ).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
        const readback = new DatabaseSync(path)
        expect(
          readback.prepare("SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?")
            .get(activation.event.dispatchRequestId)
        ).toEqual({ status: "queued" })
        expect(
          readback.prepare(
            "SELECT COUNT(*) AS count FROM orchestrator_events WHERE dispatch_request_id = ? AND type = 'running'"
          ).get(activation.event.dispatchRequestId)
        ).toEqual({ count: 0 })
        readback.close()
      })
    }))

  it.effect("rejects an independently committed queued Work binding before readiness", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-independent-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start-independent")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        const request = {
          dispatchRequestId: receipt.dispatchRequestId,
          expectedRevision: lane.revision,
          laneId: lane.laneId,
          version: "herdr.work.agent-binding-request.v1",
          worker: startedWorker
        } satisfies OrchestratorDispatchActivation
        yield* Effect.scoped(
          Effect.gen(function*() {
            const store = yield* WorkStore.open(path)
            yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
            const work = yield* makeWorkService(store)
            yield* work.bindAgent(request)
          }).pipe(provideNodeServices)
        )
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted(request)
            })
          ))
        ).toMatchObject({ failure: { _tag: "OrchestratorStorageError", operation: "initialize.work" } })
        const readback = new DatabaseSync(path)
        expect(
          readback.prepare("SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?")
            .get(receipt.dispatchRequestId)
        ).toEqual({ status: "queued" })
        expect(
          readback.prepare(
            "SELECT COUNT(*) AS count FROM orchestrator_events WHERE dispatch_request_id = ? AND type = 'running'"
          ).get(receipt.dispatchRequestId)
        ).toEqual({ count: 0 })
        readback.close()
      })
    }))

  it.effect("reports a shipped target lane as typed worker-start authority failure", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-shipped-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start-shipped")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        const shipped = yield* Effect.scoped(
          Effect.gen(function*() {
            const store = yield* WorkStore.open(path)
            yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
            const work = yield* makeWorkService(store)
            return yield* work.claim({
              ...lane,
              expectedRevision: lane.revision,
              operationId: "operation:ship-worker-lane",
              phase: "shipped"
            })
          }).pipe(provideNodeServices)
        )
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: shipped.revision,
                laneId: shipped.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              })
            })
          ))
        ).toMatchObject({
          failure: { _tag: "OrchestratorWorkerStartAuthorityError", reason: "accepted_revision_mismatch" }
        })
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: shipped.revision - 1,
                laneId: shipped.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              })
            })
          ))
        ).toMatchObject({
          failure: {
            _tag: "OrchestratorWorkerStartAuthorityError",
            actualRevision: shipped.revision,
            expectedRevision: shipped.revision - 1,
            reason: "stale_revision"
          }
        })
      })
    }))

  it.effect("rolls back dispatch activation when lane CAS authority is stale", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-stale-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start-stale")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            expect(
              yield* Effect.result(orchestrator.workerStarted({
                dispatchRequestId: accepted.dispatchRequestId,
                expectedRevision: lane.revision - 1,
                laneId: lane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              }))
            ).toMatchObject({
              failure: { _tag: "OrchestratorWorkerStartAuthorityError", reason: "accepted_revision_mismatch" }
            })
            return accepted
          })
        )
        const database = new DatabaseSync(path)
        const state = database.prepare(
          `SELECT d.status,
             (SELECT COUNT(*) FROM orchestrator_events WHERE dispatch_request_id = ?) AS events,
             (SELECT COUNT(*) FROM work_agent_bindings WHERE dispatch_request_id = ?) AS bindings
           FROM orchestrator_dispatches d WHERE d.dispatch_request_id = ?`
        ).get(receipt.dispatchRequestId, receipt.dispatchRequestId, receipt.dispatchRequestId)
        database.close()
        expect(
          Schema.decodeUnknownSync(Schema.Struct({
            bindings: Schema.Number,
            events: Schema.Number,
            status: Schema.String
          }))(state)
        ).toEqual({ bindings: 0, events: 2, status: "queued" })
      })
    }))

  it.effect("rejects worker activation when Work history is ahead of the coordinator clock", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-future-work-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start-future-work")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const database = new DatabaseSync(path)
        const row = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          database.prepare("SELECT record FROM work_goal_events WHERE goal_id = ?").get(lane.goalId)
        )
        const checkpoint = Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(row.record))
        const future = {
          ...checkpoint,
          goal: { ...checkpoint.goal, createdAt: 200, updatedAt: 200 },
          occurredAt: 200
        }
        database.prepare("UPDATE work_goal_events SET occurred_at = ?, record = ? WHERE event_id = ?")
          .run(future.occurredAt, JSON.stringify(future), future.eventId)
        database.close()
        yield* TestClock.setTime(100)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: lane.revision,
                laneId: lane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              })
            })
          ))
        ).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
        const readback = new DatabaseSync(path)
        expect(
          readback.prepare("SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?")
            .get(receipt.dispatchRequestId)
        ).toEqual({ status: "queued" })
        expect(
          readback.prepare("SELECT COUNT(*) AS count FROM work_agent_bindings WHERE dispatch_request_id = ?")
            .get(receipt.dispatchRequestId)
        ).toEqual({ count: 0 })
        readback.close()
      })
    }))

  for (
    const tamper of [
      {
        name: "dispatch handoff deletion",
        mutate: (database: DatabaseSync, dispatchRequestId: string) =>
          database.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
            .run(dispatchRequestId)
      },
      {
        name: "decision record mutation",
        mutate: (database: DatabaseSync, _dispatchRequestId: string) =>
          database.prepare("UPDATE work_decision_handoffs SET record = '{}' WHERE handoff_id = ?")
            .run("handoff:escalation")
      }
    ]
  ) {
    it.effect(`rejects worker start after durable Work ${tamper.name}`, () =>
      withTemporaryRoot("herdr-orchestrator-worker-start-tamper-", (root) => {
        const path = join(root, "orchestrator.sqlite")
        const submission = makeSolSubmission(null, `dispatch:worker-start:${tamper.name}`)
        return Effect.gen(function*() {
          const lane = yield* recordWorkAuthority(path, submission.workLink)
          const receipt = yield* withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              const accepted = yield* orchestrator.submitRouted(submission)
              yield* orchestrator.queue(accepted.dispatchRequestId)
              return accepted
            })
          )
          const database = new DatabaseSync(path)
          tamper.mutate(database, receipt.dispatchRequestId)
          database.close()

          expect(
            yield* Effect.result(withDatabase(
              path,
              Effect.gen(function*() {
                const orchestrator = yield* Orchestrator
                return yield* orchestrator.workerStarted({
                  dispatchRequestId: receipt.dispatchRequestId,
                  expectedRevision: lane.revision,
                  laneId: lane.laneId,
                  version: "herdr.work.agent-binding-request.v1",
                  worker: startedWorker
                })
              })
            ))
          ).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
          const readback = new DatabaseSync(path)
          expect(
            readback.prepare(
              "SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?"
            ).get(receipt.dispatchRequestId)
          ).toEqual({ status: "queued" })
          expect(
            readback.prepare(
              "SELECT COUNT(*) AS count FROM work_agent_bindings WHERE dispatch_request_id = ?"
            ).get(receipt.dispatchRequestId)
          ).toEqual({ count: 0 })
          readback.close()
        })
      }))
  }

  it.effect("rejects worker start when another lane hides conflicting goal authority", () =>
    withTemporaryRoot("herdr-orchestrator-hidden-lane-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:hidden-lane")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        const hidden = {
          ...lane,
          laneId: "lane:hidden-conflict",
          operationId: "operation:hidden-conflict",
          revision: 1
        }
        const database = new DatabaseSync(path)
        database.prepare(
          `INSERT INTO work_lane_claims
             (lane_id, goal_id, operation_id, phase, revision, record)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          hidden.laneId,
          "goal:hidden-index",
          hidden.operationId,
          hidden.phase,
          hidden.revision,
          JSON.stringify(hidden)
        )
        database.close()
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: lane.revision,
                laneId: lane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              })
            })
          ))
        ).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
      })
    }))

  it.effect("accepts worker start with a valid shipped unrelated lane", () =>
    withTemporaryRoot("herdr-orchestrator-shipped-lane-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:shipped-lane")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const shipped = {
          ...lane,
          goalId: "goal:shipped-unrelated",
          laneId: "lane:shipped-unrelated",
          operationId: "operation:shipped-unrelated",
          phase: "shipped",
          revision: 1
        } satisfies typeof lane
        const database = new DatabaseSync(path)
        database.prepare(
          `INSERT INTO work_lane_claims
             (lane_id, goal_id, operation_id, phase, revision, record)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          shipped.laneId,
          shipped.goalId,
          shipped.operationId,
          shipped.phase,
          shipped.revision,
          JSON.stringify(shipped)
        )
        database.close()
        const activation = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            return yield* orchestrator.workerStarted({
              dispatchRequestId: receipt.dispatchRequestId,
              expectedRevision: lane.revision,
              laneId: lane.laneId,
              version: "herdr.work.agent-binding-request.v1",
              worker: startedWorker
            })
          })
        )
        expect(activation.event.type).toBe("running")
      })
    }))

  it.effect("rejects worker start when checkpoint row identity disagrees with its record", () =>
    withTemporaryRoot("herdr-orchestrator-checkpoint-identity-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:checkpoint-identity")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        const database = new DatabaseSync(path)
        const row = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          database.prepare("SELECT record FROM work_goal_events WHERE goal_id = ?").get(lane.goalId)
        )
        const checkpoint = Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(row.record))
        database.prepare("UPDATE work_goal_events SET record = ? WHERE event_id = ?").run(
          JSON.stringify({ ...checkpoint, eventId: receipt.dispatchRequestId }),
          checkpoint.eventId
        )
        database.close()
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: lane.revision,
                laneId: lane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              })
            })
          ))
        ).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
        const readback = new DatabaseSync(path)
        expect(
          readback.prepare("SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?")
            .get(receipt.dispatchRequestId)
        ).toEqual({ status: "queued" })
        readback.close()
      })
    }))

  for (
    const capacity of [
      {
        name: "operation count",
        update: "UPDATE work_lane_operation_totals SET operation_count = 16384 WHERE singleton = 1"
      },
      {
        name: "operation bytes",
        update: "UPDATE work_lane_operation_totals SET operation_bytes = 2097152 WHERE singleton = 1"
      }
    ]
  ) {
    it.effect(`applies the Work agent-binding ${capacity.name} bound before activation`, () =>
      withTemporaryRoot("herdr-orchestrator-worker-start-capacity-", (root) => {
        const path = join(root, "orchestrator.sqlite")
        const submission = makeSolSubmission(null, `dispatch:worker-start:${capacity.name}`)
        return Effect.gen(function*() {
          const lane = yield* recordWorkAuthority(path, submission.workLink)
          const receipt = yield* withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              const accepted = yield* orchestrator.submitRouted(submission)
              yield* orchestrator.queue(accepted.dispatchRequestId)
              return accepted
            })
          )
          const database = new DatabaseSync(path)
          database.exec(capacity.update)
          database.close()
          expect(
            yield* Effect.result(withDatabase(
              path,
              Effect.gen(function*() {
                const orchestrator = yield* Orchestrator
                return yield* orchestrator.workerStarted({
                  dispatchRequestId: receipt.dispatchRequestId,
                  expectedRevision: lane.revision,
                  laneId: lane.laneId,
                  version: "herdr.work.agent-binding-request.v1",
                  worker: startedWorker
                })
              })
            ))
          ).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
          const readback = new DatabaseSync(path)
          expect(
            readback.prepare(
              "SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?"
            ).get(receipt.dispatchRequestId)
          ).toEqual({ status: "queued" })
          readback.close()
        })
      }))
  }

  it.effect("applies the Work snapshot byte bound before dispatch activation", () =>
    withTemporaryRoot("herdr-orchestrator-worker-start-snapshot-capacity-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:worker-start:snapshot-capacity")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        const database = new DatabaseSync(path)
        const insert = database.prepare(
          "INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)"
        )
        const maximumText = "x".repeat(4_096)
        for (const index of Array.from({ length: 20 }, (_, index) => index)) {
          const goalId = `goal:snapshot-capacity:${index}`
          const event = Schema.decodeUnknownSync(WorkGoalCheckpoint)({
            eventId: `event:snapshot-capacity:${index}`,
            goal: {
              blocker: null,
              connectTarget: null,
              createdAt: 0,
              delivery: "local",
              detail: maximumText,
              id: goalId,
              owner: { id: `owner:${index}`, name: maximumText },
              repository: { branch: maximumText, repository: maximumText },
              spend: null,
              state: "working",
              summary: maximumText,
              title: maximumText,
              updatedAt: 0
            },
            occurredAt: 0,
            version: "herdr.work.event.v1"
          })
          insert.run(event.eventId, event.goal.id, event.occurredAt, JSON.stringify(event))
        }
        database.close()
        expect(
          yield* Effect.result(withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: lane.revision,
                laneId: lane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              })
            })
          ))
        ).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
        const readback = new DatabaseSync(path)
        expect(
          readback.prepare(
            "SELECT status FROM orchestrator_dispatches WHERE dispatch_request_id = ?"
          ).get(receipt.dispatchRequestId)
        ).toEqual({ status: "queued" })
        readback.close()
      })
    }))

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

  it.effect("follows persisted events from accepted through one terminal event", () =>
    withTemporaryRoot("herdr-orchestrator-live-events-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          const receipt = yield* orchestrator.submit(
            { ...command, activityIdempotencyKey: "activity:live-events" },
            "dispatch:live-events"
          )
          const acceptedSeen = yield* Deferred.make<void>()
          const eventsFiber = yield* orchestrator.events(receipt.dispatchRequestId).pipe(
            Stream.tap((event) => event.type === "accepted" ? Deferred.succeed(acceptedSeen, undefined) : Effect.void),
            Stream.runCollect,
            Effect.forkChild
          )
          yield* Deferred.await(acceptedSeen)
          yield* orchestrator.queue(receipt.dispatchRequestId)
          yield* orchestrator.run(receipt.dispatchRequestId)
          yield* orchestrator.settle(receipt.dispatchRequestId, "done")
          yield* TestClock.adjust("100 millis")
          const events = yield* Fiber.join(eventsFiber)
          expect(events.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
            { sequence: 0, type: "accepted" },
            { sequence: 1, type: "queued" },
            { sequence: 2, type: "running" },
            { sequence: 3, type: "settled" }
          ])
        })
      )))

  it.effect("records pre-worker executor failure as queued delivery failure", () =>
    withTemporaryRoot("herdr-orchestrator-queued-delivery-failure-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:queued-delivery-failure")
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            expect(
              yield* orchestrator.failDelivery(receipt.dispatchRequestId, "executor failed before worker start")
            ).toMatchObject({
              detail: "executor failed before worker start",
              type: "delivery_failed"
            })
            expect(
              yield* Effect.result(orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: lane.revision,
                laneId: lane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              }))
            ).toMatchObject({
              failure: {
                _tag: "OrchestratorTransitionError",
                dispatchRequestId: receipt.dispatchRequestId,
                from: "delivery_failed",
                to: "running"
              }
            })
            expect(
              (yield* Stream.runCollect(orchestrator.events(receipt.dispatchRequestId))).map(({ type }) => type)
            ).toEqual(["accepted", "queued", "delivery_failed"])
          })
        )
      })
    }))

  it.effect("persists executable route metadata for typed request lookup", () =>
    withTemporaryRoot("herdr-orchestrator-route-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const receipts = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.all({
              consult: orchestrator.submitRouted({
                command: makeLunaCommand("consult", "activity:route-luna"),
                idempotencyKey: "dispatch:route-luna",
                route: lunaRoute,
                workLink: null
              }),
              transitionSummary: orchestrator.submitRouted({
                command: makeLunaCommand("transition_summary", "activity:route-transition-summary"),
                idempotencyKey: "dispatch:route-transition-summary",
                route: {
                  ...lunaRoute,
                  reason: "transition summaries use Luna low",
                  reasoningEffort: "low"
                },
                workLink: null
              })
            })
          })
        )
        const requests = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.all({
              consult: orchestrator.request(receipts.consult.dispatchRequestId),
              transitionSummary: orchestrator.request(receipts.transitionSummary.dispatchRequestId)
            })
          })
        )
        expect(requests.consult).toMatchObject({
          activityIdempotencyKey: "activity:route-luna",
          command: { activityIdempotencyKey: "activity:route-luna" },
          dispatchRequestId: receipts.consult.dispatchRequestId,
          route: lunaRoute,
          status: "accepted",
          workLink: null
        })
        expect(requests.transitionSummary).toMatchObject({
          activityIdempotencyKey: "activity:route-transition-summary",
          dispatchRequestId: receipts.transitionSummary.dispatchRequestId,
          route: { model: "gpt-5.6-luna", reasoningEffort: "low" },
          status: "accepted",
          workLink: null
        })
      })
    }))

  it.effect("rejects a persisted command whose mode no longer matches its route", () =>
    withTemporaryRoot("herdr-orchestrator-route-command-mismatch-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const submission = makeSolSubmission(null, "dispatch:route-command-mismatch")
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const results = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            const database = new DatabaseSync(path)
            database.prepare(
              `UPDATE orchestrator_dispatches
               SET command = json_set(command, '$.payload.mode', 'transition_summary')
               WHERE dispatch_request_id = ?`
            ).run(receipt.dispatchRequestId)
            database.close()
            return {
              pending: yield* Effect.result(orchestrator.pending()),
              request: yield* Effect.result(orchestrator.request(receipt.dispatchRequestId)),
              workerStarted: yield* Effect.result(orchestrator.workerStarted({
                dispatchRequestId: receipt.dispatchRequestId,
                expectedRevision: lane.revision,
                laneId: lane.laneId,
                version: "herdr.work.agent-binding-request.v1",
                worker: startedWorker
              }))
            }
          })
        )
        expect(results.request).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "events.decode-authority" }
        })
        expect(results.pending).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "events.decode-authority" }
        })
        expect(results.workerStarted).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
      })
    }))

  it.effect("atomically binds a failed-Luna Sol dispatch to its Work lineage", () =>
    withTemporaryRoot("herdr-orchestrator-work-link-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* recordWorkAuthority(path, makeWorkLink([]))
        const linked = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:route-failed-luna"),
              idempotencyKey: "dispatch:route-failed-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            yield* orchestrator.failTask(luna.dispatchRequestId, "Luna task failed")
            const sol = yield* orchestrator.submitSolEscalation({
              command: {
                ...command,
                activityIdempotencyKey: "activity:dispatch:route-sol",
                payload: {
                  kind: "agent.delegate",
                  mode: "work",
                  prompt: "Continue failed Luna work with Sol",
                  repository: "/repo"
                }
              },
              idempotencyKey: "dispatch:route-sol",
              reason: "failed Luna work requires an explicit linked Sol escalation",
              reference: {
                failedLunaRequestId: luna.dispatchRequestId,
                workLink: makeWorkLink([luna.dispatchRequestId])
              }
            })
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
            yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
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

  it.effect("rejects a linked Sol child after its persisted Luna parent command changes", () =>
    withTemporaryRoot("herdr-orchestrator-linked-parent-command-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* recordWorkAuthority(path, makeWorkLink([]))
        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:linked-parent-command"),
              idempotencyKey: "dispatch:linked-parent-command",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            yield* orchestrator.failTask(luna.dispatchRequestId, "Luna failed")
            const sol = yield* orchestrator.submitSolEscalation({
              command: {
                ...command,
                activityIdempotencyKey: "activity:linked-parent-child",
                payload: {
                  kind: "agent.delegate",
                  mode: "work",
                  prompt: "Continue failed Luna work with Sol",
                  repository: "/repo"
                }
              },
              idempotencyKey: "dispatch:linked-parent-child",
              reason: "failed Luna work requires an explicit linked Sol escalation",
              reference: {
                failedLunaRequestId: luna.dispatchRequestId,
                workLink: makeWorkLink([luna.dispatchRequestId])
              }
            })
            const database = new DatabaseSync(path)
            database.prepare(
              "UPDATE orchestrator_dispatches SET command = json_set(command, '$.payload.mode', 'work') WHERE dispatch_request_id = ?"
            ).run(luna.dispatchRequestId)
            database.close()
            return yield* Effect.result(orchestrator.request(sol.dispatchRequestId))
          })
        )
        expect(result).toMatchObject({ failure: { _tag: "OrchestratorStorageError" } })
      })
    }))

  it.effect("surfaces stale Work authority without partially accepting a Sol dispatch", () =>
    withTemporaryRoot("herdr-orchestrator-stale-sol-authority-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const luna = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:stale-sol-luna"),
              idempotencyKey: "dispatch:stale-sol-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(accepted.dispatchRequestId)
            yield* orchestrator.run(accepted.dispatchRequestId)
            yield* orchestrator.failTask(accepted.dispatchRequestId, "Luna task failed")
            return accepted
          })
        )
        const workLink = makeWorkLink([luna.dispatchRequestId])
        const lane = yield* recordWorkAuthority(path, workLink)
        yield* Effect.scoped(
          Effect.gen(function*() {
            const store = yield* WorkStore.open(path)
            yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
            const work = yield* makeWorkService(store)
            yield* work.handoff(workLink.handoff)
            yield* work.claim({
              branch: lane.branch,
              expectedRevision: lane.revision,
              goalId: lane.goalId,
              head: lane.head,
              laneId: lane.laneId,
              operationId: "operation:stale-sol-authority",
              owner: lane.owner,
              parent: lane.parent,
              phase: lane.phase,
              worktree: lane.worktree
            })
          }).pipe(provideNodeServices)
        )

        expect(
          yield* withDatabase(
            path,
            Effect.gen(function*() {
              const orchestrator = yield* Orchestrator
              return yield* Effect.result(orchestrator.submitSolEscalation({
                command: {
                  ...command,
                  activityIdempotencyKey: "activity:stale-sol",
                  payload: {
                    kind: "agent.delegate",
                    mode: "work",
                    prompt: "Continue failed Luna work with Sol",
                    repository: "/repo"
                  }
                },
                idempotencyKey: "dispatch:stale-sol",
                reason: "failed Luna work requires an explicit linked Sol escalation",
                reference: { failedLunaRequestId: luna.dispatchRequestId, workLink }
              }))
            })
          )
        ).toMatchObject({
          failure: {
            _tag: "OrchestratorWorkRevisionConflictError",
            actualRevision: lane.revision + 1,
            expectedRevision: lane.revision,
            laneId: lane.laneId
          }
        })

        const database = new DatabaseSync(path)
        const counts = Schema.decodeUnknownSync(Schema.Struct({
          accepted: Schema.Number,
          dispatches: Schema.Number,
          metadata: Schema.Number
        }))(
          database.prepare(
            `SELECT
               (SELECT COUNT(*) FROM orchestrator_dispatches) AS dispatches,
               (SELECT COUNT(*) FROM orchestrator_dispatch_metadata) AS metadata,
               (SELECT COUNT(*) FROM orchestrator_events WHERE type = 'accepted') AS accepted`
          ).get()
        )
        database.close()
        expect(counts).toEqual({ accepted: 1, dispatches: 1, metadata: 1 })
      })
    }))

  it.effect("replays an accepted Sol binding after its Work lane ships", () =>
    withTemporaryRoot("herdr-orchestrator-work-replay-shipped-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const authority = yield* recordWorkAuthority(path, makeWorkLink([]))
        const accepted = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:replay-shipped-luna"),
              idempotencyKey: "dispatch:replay-shipped-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            yield* orchestrator.failTask(luna.dispatchRequestId, "Luna task failed")
            const submission = makeSolSubmission(luna.dispatchRequestId, "dispatch:replay-shipped-sol")
            const receipt = yield* orchestrator.submitRouted(submission)
            return { receipt, submission }
          })
        )
        yield* Effect.scoped(
          Effect.gen(function*() {
            const store = yield* WorkStore.open(path)
            yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
            const service = yield* makeWorkService(store)
            return yield* service.claim({
              branch: authority.branch,
              expectedRevision: authority.revision,
              goalId: authority.goalId,
              head: authority.head,
              laneId: authority.laneId,
              operationId: "operation:replay-shipped",
              owner: authority.owner,
              parent: authority.parent,
              phase: "shipped",
              worktree: authority.worktree
            })
          }).pipe(provideNodeServices)
        )

        const replayed = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return {
              receipt: yield* orchestrator.submitRouted(accepted.submission),
              request: yield* orchestrator.request(accepted.receipt.dispatchRequestId)
            }
          })
        )
        expect(replayed.receipt).toEqual(accepted.receipt)
        expect(replayed.request.workLink).toEqual(accepted.submission.workLink)
      })
    }))

  it.effect("fails closed when routed metadata disappears", () =>
    withTemporaryRoot("herdr-orchestrator-route-presence-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:route-presence"),
              idempotencyKey: "dispatch:route-presence",
              route: lunaRoute,
              workLink: null
            })
          })
        )
        const database = new DatabaseSync(path)
        database.prepare("DELETE FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?")
          .run(receipt.dispatchRequestId)
        database.close()

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.request(receipt.dispatchRequestId))
          })
        )
        expect(result).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "decode.metadata-presence-mismatch" }
        })
      })
    }))

  it.effect("backfills the routed discriminator when reopening the prior journal schema", () =>
    withTemporaryRoot("herdr-orchestrator-route-migration-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const database = new DatabaseSync(path)
        database.exec(`
          PRAGMA foreign_keys = ON;
          CREATE TABLE orchestrator_dispatches (
            dispatch_request_id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            activity_idempotency_key TEXT NOT NULL UNIQUE,
            command TEXT NOT NULL,
            accepted_at INTEGER NOT NULL,
            status TEXT NOT NULL
          );
          CREATE TABLE orchestrator_events (
            dispatch_request_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            activity_idempotency_key TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            detail TEXT,
            result TEXT,
            PRIMARY KEY (dispatch_request_id, sequence)
          );
          CREATE TABLE orchestrator_dispatch_metadata (
            dispatch_request_id TEXT PRIMARY KEY,
            route TEXT NOT NULL,
            work_link TEXT
          );
        `)
        database.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, status)
           VALUES (?, ?, ?, ?, 0, 'accepted')`
        ).run(
          "dispatch:migrated-route",
          "idempotency:migrated-route",
          "activity:migrated-route",
          JSON.stringify(makeLunaCommand("consult", "activity:migrated-route"))
        )
        database.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           VALUES (?, 0, 'accepted', ?, 0, NULL, NULL)`
        ).run("dispatch:migrated-route", "activity:migrated-route")
        database.prepare(
          `INSERT INTO orchestrator_dispatch_metadata (dispatch_request_id, route, work_link)
           VALUES (?, ?, NULL)`
        ).run("dispatch:migrated-route", JSON.stringify(lunaRoute))
        database.close()

        const request = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* orchestrator.request("dispatch:migrated-route")
          })
        )
        expect(request.route).toEqual(lunaRoute)
        const reopened = new DatabaseSync(path)
        const routed = reopened.prepare(
          "SELECT is_routed AS isRouted FROM orchestrator_dispatches WHERE dispatch_request_id = ?"
        ).get("dispatch:migrated-route")
        reopened.close()
        expect(routed).toEqual({ isRouted: 1 })
      })
    }))

  it.effect("migrates the previous Work handoff table with bounded companion loading", () =>
    withTemporaryRoot("herdr-orchestrator-work-schema-migration-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const lane = {
          branch: "feat/legacy",
          expectedRevision: 0,
          head: "0123456789012345678901234567890123456789",
          laneId: "goal:legacy",
          owner: { id: "owner:legacy", name: "Legacy owner" },
          parent: null,
          phase: "implementation",
          revision: 1,
          worktree: "/worktrees/legacy"
        }
        const legacy = {
          decision: "handoff",
          goalId: "goal:legacy",
          id: "handoff:legacy",
          laneId: "goal:legacy",
          occurredAt: 1,
          owner: { id: "owner:legacy", name: "Legacy owner" },
          summary: "Legacy coordinator handoff",
          version: "herdr.work.decision.v1"
        }
        const database = new DatabaseSync(path)
        database.exec("PRAGMA journal_mode = WAL")
        database.exec(`
          CREATE TABLE work_lane_claims (
            lane_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            record TEXT NOT NULL
          );
          CREATE TABLE work_decision_handoffs (
            handoff_id TEXT PRIMARY KEY,
            lane_id TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            record TEXT NOT NULL
          );
          CREATE TABLE work_dispatch_handoffs (
            dispatch_request_id TEXT PRIMARY KEY,
            handoff_id TEXT NOT NULL UNIQUE,
            lane_id TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            lineage TEXT NOT NULL,
            record TEXT NOT NULL
          );
          CREATE TABLE work_agent_bindings (
            dispatch_request_id TEXT PRIMARY KEY,
            lane_id TEXT NOT NULL,
            expected_revision INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            agent_id TEXT NOT NULL,
            host TEXT NOT NULL,
            record TEXT NOT NULL
          );
          CREATE TABLE orchestrator_dispatch_metadata (
            dispatch_request_id TEXT PRIMARY KEY,
            route TEXT NOT NULL,
            work_link TEXT
          );
        `)
        database.prepare("INSERT INTO work_lane_claims VALUES (?, ?, ?)")
          .run(lane.laneId, lane.revision, JSON.stringify(lane))
        database.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?)")
          .run(legacy.id, legacy.laneId, legacy.occurredAt, JSON.stringify(legacy))
        const parentDispatchRequestId = "dispatch:legacy-luna"
        const lineage = [parentDispatchRequestId]
        const legacyBinding = migrationBinding(
          "dispatch:legacy-sol",
          Schema.decodeUnknownSync(WorkLaneClaimed)({
            ...lane,
            expectedRevision: lane.revision,
            goalId: legacy.goalId,
            operationId: "dispatch:legacy-sol",
            revision: lane.revision + 1
          }),
          legacy.occurredAt
        )
        persistMigrationBindingCompanions(database, legacyBinding)
        database.prepare("INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)")
          .run("event:unreferenced", legacy.goalId, "not-a-timestamp", "not-json")
        database.prepare("INSERT INTO work_lane_operations VALUES (?, ?, ?, ?, ?, ?)")
          .run(
            "operation:unreferenced",
            legacy.laneId,
            legacy.goalId,
            legacyBinding.lane.phase,
            "not-a-revision",
            "not-json"
          )
        database.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)")
          .run(
            "dispatch:legacy-sol",
            legacy.id,
            legacy.laneId,
            legacy.occurredAt,
            JSON.stringify(lineage),
            JSON.stringify(legacy)
          )
        database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          "dispatch:legacy-sol",
          legacy.laneId,
          legacyBinding.request.expectedRevision,
          legacyBinding.lane.revision,
          legacyBinding.request.worker.agentId,
          legacyBinding.request.worker.host,
          JSON.stringify(legacyBinding)
        )
        database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)")
          .run(
            "dispatch:legacy-sol",
            JSON.stringify({
              ...lunaRoute,
              linkedRequestId: null,
              model: "gpt-5.6-sol",
              reasoningEffort: "high"
            }),
            JSON.stringify({ handoff: legacy, lineage })
          )
        persistMigrationLifecycle(
          database,
          "dispatch:legacy-sol",
          legacyBinding.checkpoint.occurredAt,
          "running",
          "work"
        )
        database.close()

        const missingMetadataLegacyPath = join(root, "missing-metadata-legacy.sqlite")
        copyFileSync(path, missingMetadataLegacyPath)
        const missingMetadataLegacy = new DatabaseSync(missingMetadataLegacyPath)
        missingMetadataLegacy.exec("DROP TABLE orchestrator_dispatch_metadata")
        missingMetadataLegacy.close()
        expect(yield* Effect.result(withDatabase(missingMetadataLegacyPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            operation: "initialize.work"
          }
        })

        const unroutedLegacyPath = join(root, "unrouted-legacy.sqlite")
        copyFileSync(path, unroutedLegacyPath)
        const unroutedLegacy = new DatabaseSync(unroutedLegacyPath)
        unroutedLegacy.prepare("UPDATE orchestrator_dispatches SET is_routed = 0").run()
        unroutedLegacy.close()
        expect(yield* Effect.result(withDatabase(unroutedLegacyPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.migrate.legacy-metadata-authority" },
            operation: "initialize.work"
          }
        })
        const unroutedLegacyRolledBack = new DatabaseSync(unroutedLegacyPath)
        const unroutedLegacyColumns = unroutedLegacyRolledBack.prepare(
          "PRAGMA table_info(work_decision_handoffs)"
        ).all()
        unroutedLegacyRolledBack.close()
        expect(
          unroutedLegacyColumns.some((column) =>
            Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(column).name === "session_id"
          )
        ).toBe(false)

        const missingParentLegacyPath = join(root, "missing-parent-legacy.sqlite")
        copyFileSync(path, missingParentLegacyPath)
        const missingParentLegacy = new DatabaseSync(missingParentLegacyPath)
        missingParentLegacy.prepare("UPDATE orchestrator_dispatch_metadata SET route = ?")
          .run(JSON.stringify({
            ...lunaRoute,
            linkedRequestId: parentDispatchRequestId,
            model: "gpt-5.6-sol",
            reasoningEffort: "high"
          }))
        missingParentLegacy.close()
        expect(yield* Effect.result(withDatabase(missingParentLegacyPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.migrate.legacy-metadata-authority.parent" },
            operation: "initialize.work"
          }
        })

        const failedParentLegacyPath = join(root, "failed-parent-legacy.sqlite")
        copyFileSync(path, failedParentLegacyPath)
        const failedParentLegacy = new DatabaseSync(failedParentLegacyPath)
        persistMigrationLifecycle(failedParentLegacy, parentDispatchRequestId, 10, "task_failed", "consult")
        failedParentLegacy.prepare("UPDATE orchestrator_dispatch_metadata SET route = ?")
          .run(JSON.stringify({
            ...lunaRoute,
            linkedRequestId: parentDispatchRequestId,
            model: "gpt-5.6-sol",
            reasoningEffort: "high"
          }))
        failedParentLegacy.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, NULL)")
          .run(parentDispatchRequestId, JSON.stringify(lunaRoute))
        failedParentLegacy.close()
        yield* withDatabase(failedParentLegacyPath, Effect.void)

        const queuedLegacyPath = join(root, "queued-legacy-lifecycle.sqlite")
        copyFileSync(path, queuedLegacyPath)
        const queuedLegacy = new DatabaseSync(queuedLegacyPath)
        queuedLegacy.prepare("DELETE FROM orchestrator_events WHERE type = 'running'").run()
        queuedLegacy.prepare("UPDATE orchestrator_dispatches SET status = 'queued'").run()
        queuedLegacy.close()
        expect(yield* Effect.result(withDatabase(queuedLegacyPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: {
              _tag: "WorkStoreError",
              operation: "sql-work.initialize.legacy-agent-binding.lifecycle"
            },
            operation: "initialize.work"
          }
        })
        const queuedLegacyRolledBack = new DatabaseSync(queuedLegacyPath)
        const retainedQueuedLegacyColumns = queuedLegacyRolledBack.prepare(
          "PRAGMA table_info(work_decision_handoffs)"
        ).all()
        queuedLegacyRolledBack.close()
        expect(
          retainedQueuedLegacyColumns.some((column) =>
            Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(column).name === "session_id"
          )
        ).toBe(false)

        const duplicateLegacyPath = join(root, "duplicate-legacy-dispatch.sqlite")
        copyFileSync(path, duplicateLegacyPath)
        const duplicateLegacy = new DatabaseSync(duplicateLegacyPath)
        duplicateLegacy.exec(`
          ALTER TABLE work_dispatch_handoffs RENAME TO unique_work_dispatch_handoffs;
          CREATE TABLE work_dispatch_handoffs (
            dispatch_request_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, lane_id TEXT NOT NULL,
            occurred_at INTEGER NOT NULL, lineage TEXT NOT NULL, record TEXT NOT NULL
          );
          INSERT INTO work_dispatch_handoffs SELECT * FROM unique_work_dispatch_handoffs;
          DROP TABLE unique_work_dispatch_handoffs;
        `)
        duplicateLegacy.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)").run(
          "dispatch:legacy-duplicate",
          legacy.id,
          legacy.laneId,
          legacy.occurredAt,
          JSON.stringify(lineage),
          JSON.stringify(legacy)
        )
        duplicateLegacy.close()
        const duplicateFailure = yield* Effect.flip(withDatabase(duplicateLegacyPath, Effect.void))
        expect(duplicateFailure).toMatchObject({
          _tag: "OrchestratorStorageError",
          operation: "initialize.work"
        })
        expect(duplicateFailure.cause).toMatchObject({
          _tag: "WorkStoreError",
          operation: "sql-work.migrate.legacy-dispatch-cardinality"
        })
        const duplicateLegacyRolledBack = new DatabaseSync(duplicateLegacyPath)
        const retainedDuplicateLegacy = duplicateLegacyRolledBack.prepare(
          "SELECT record FROM work_dispatch_handoffs WHERE handoff_id = ?"
        ).all(legacy.id)
        duplicateLegacyRolledBack.close()
        expect(retainedDuplicateLegacy).toHaveLength(2)

        const oversizedLegacyPath = join(root, "oversized-legacy.sqlite")
        copyFileSync(path, oversizedLegacyPath)
        const oversizedLegacy = new DatabaseSync(oversizedLegacyPath)
        for (let index = 0; index < 260; index++) {
          const occurredAt = index + 10
          const handoff = {
            ...legacy,
            id: `handoff:legacy-capacity:${String(index)}`,
            occurredAt,
            summary: "x".repeat(4_096)
          }
          const dispatchRequestId = `dispatch:legacy-capacity:${String(index)}`
          const dispatchLineage = [`dispatch:legacy-luna:${String(index)}`]
          const binding = migrationBinding(
            dispatchRequestId,
            Schema.decodeUnknownSync(WorkLaneClaimed)({
              ...lane,
              expectedRevision: lane.revision,
              goalId: handoff.goalId,
              operationId: dispatchRequestId,
              revision: lane.revision + 1
            }),
            occurredAt
          )
          persistMigrationBindingCompanions(oversizedLegacy, binding)
          oversizedLegacy.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?)")
            .run(handoff.id, handoff.laneId, handoff.occurredAt, JSON.stringify(handoff))
          oversizedLegacy.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)")
            .run(
              dispatchRequestId,
              handoff.id,
              handoff.laneId,
              handoff.occurredAt,
              JSON.stringify(dispatchLineage),
              JSON.stringify(handoff)
            )
          oversizedLegacy.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            dispatchRequestId,
            handoff.laneId,
            binding.request.expectedRevision,
            binding.lane.revision,
            binding.request.worker.agentId,
            binding.request.worker.host,
            JSON.stringify(binding)
          )
          oversizedLegacy.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)")
            .run(
              dispatchRequestId,
              JSON.stringify({
                ...lunaRoute,
                linkedRequestId: null,
                model: "gpt-5.6-sol",
                reasoningEffort: "high"
              }),
              JSON.stringify({ handoff, lineage: dispatchLineage })
            )
          persistMigrationLifecycle(
            oversizedLegacy,
            dispatchRequestId,
            binding.checkpoint.occurredAt,
            "running",
            "work"
          )
        }
        oversizedLegacy.close()
        expect(yield* Effect.result(withDatabase(oversizedLegacyPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.handoff-capacity" },
            operation: "initialize.work"
          }
        })
        const oversizedRolledBack = new DatabaseSync(oversizedLegacyPath)
        const oversizedColumns = oversizedRolledBack.prepare("PRAGMA table_info(work_decision_handoffs)").all()
        const oversizedRetained = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          oversizedRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(legacy.id)
        )
        oversizedRolledBack.close()
        expect(
          oversizedColumns.some((column) =>
            Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(column).name === "session_id"
          )
        ).toBe(false)
        expect(JSON.parse(oversizedRetained.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        const concurrent = { ...legacy, id: "handoff:legacy-concurrent", occurredAt: 2 }
        const concurrentDispatchRequestId = `dispatch:${concurrent.id}`
        const concurrentBinding = migrationBinding(
          concurrentDispatchRequestId,
          Schema.decodeUnknownSync(WorkLaneClaimed)({
            ...lane,
            expectedRevision: lane.revision,
            goalId: concurrent.goalId,
            operationId: concurrentDispatchRequestId,
            revision: lane.revision + 1
          }),
          concurrent.occurredAt
        )
        const writer = spawn(
          execPath,
          [
            "--input-type=module",
            "-e",
            `import { DatabaseSync } from "node:sqlite"
const database = new DatabaseSync(process.argv[1])
const handoff = JSON.parse(process.argv[2])
const expectedRevision = Number(process.argv[3])
const binding = JSON.parse(process.argv[4])
const dispatchRequestId = "dispatch:" + handoff.id
const lineage = ["dispatch:lineage:" + handoff.id]
database.exec("BEGIN IMMEDIATE")
database.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?)")
  .run(handoff.id, handoff.laneId, handoff.occurredAt, JSON.stringify(handoff))
database.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)")
  .run(dispatchRequestId, handoff.id, handoff.laneId, handoff.occurredAt, JSON.stringify(lineage), JSON.stringify(handoff))
database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)")
  .run(dispatchRequestId, handoff.laneId, expectedRevision, expectedRevision + 1,
    binding.request.worker.agentId, binding.request.worker.host, JSON.stringify(binding))
database.prepare("INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)")
  .run(binding.checkpoint.eventId, binding.checkpoint.goal.id, binding.checkpoint.occurredAt,
    JSON.stringify(binding.checkpoint))
database.prepare("INSERT INTO work_lane_operations VALUES (?, ?, ?, ?, ?, ?)")
  .run(binding.lane.operationId, binding.lane.laneId, binding.lane.goalId, binding.lane.phase,
    binding.lane.revision, JSON.stringify(binding.lane))
database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)")
  .run(dispatchRequestId, JSON.stringify({
    action: "dispatch", linkedRequestId: null, model: "gpt-5.6-sol",
    protocol: "hostd.coordinator.route.v1", reason: "Migrate durable Work authority",
    reasoningEffort: "high"
  }), JSON.stringify({ handoff, lineage }))
const activityIdempotencyKey = "activity:" + dispatchRequestId
database.prepare("INSERT INTO orchestrator_dispatches VALUES (?, ?, ?, ?, ?, 1, 'running')")
  .run(dispatchRequestId, "idempotency:" + dispatchRequestId, activityIdempotencyKey,
    JSON.stringify({ activityIdempotencyKey, actor: "coordinator", kind: "fleet.job",
      payload: { kind: "agent.delegate", mode: "work", prompt: "Migrate", repository: "/repo" } }), 0)
database.prepare("INSERT INTO orchestrator_events VALUES (?, 0, 'accepted', ?, 0, NULL, NULL)")
  .run(dispatchRequestId, activityIdempotencyKey)
database.prepare("INSERT INTO orchestrator_events VALUES (?, 1, 'queued', ?, 1, NULL, NULL)")
  .run(dispatchRequestId, activityIdempotencyKey)
database.prepare("INSERT INTO orchestrator_events VALUES (?, 2, 'running', ?, ?, NULL, NULL)")
  .run(dispatchRequestId, activityIdempotencyKey, binding.checkpoint.occurredAt)
process.stdout.write("locked\\n")
await new Promise((resolve) => setTimeout(resolve, 250))
database.exec("COMMIT")
database.close()`,
            path,
            JSON.stringify(concurrent),
            String(lane.revision),
            JSON.stringify(concurrentBinding)
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => writer.kill()))
        yield* Effect.callback<void, LegacyWriterError>((resume) => {
          let completed = false
          const complete = (result: Effect.Effect<void, LegacyWriterError>) => {
            if (completed) return
            completed = true
            resume(result)
          }
          writer.stdout.setEncoding("utf8")
          writer.stdout.once("data", () => complete(Effect.void))
          writer.once("error", (cause) => complete(Effect.fail(new LegacyWriterError({ cause: String(cause) }))))
          writer.once(
            "exit",
            (code, signal) =>
              complete(
                Effect.fail(
                  new LegacyWriterError({ cause: `legacy writer exited before readiness: ${code ?? signal}` })
                )
              )
          )
        })

        yield* withDatabase(path, Effect.void)
        const migrated = new DatabaseSync(path)
        const decision = migrated.prepare(
          "SELECT session_id AS sessionId, record FROM work_decision_handoffs WHERE handoff_id = ?"
        ).get(legacy.id)
        const migratedLane = migrated.prepare(
          "SELECT goal_id AS goalId, operation_id AS operationId, phase, record FROM work_lane_claims WHERE lane_id = ?"
        ).get(lane.laneId)
        const dispatch = migrated.prepare(
          "SELECT record FROM work_dispatch_handoffs WHERE dispatch_request_id = ?"
        ).get("dispatch:legacy-sol")
        const metadata = migrated.prepare(
          "SELECT work_link AS workLink FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?"
        ).get("dispatch:legacy-sol")
        const concurrentDecision = migrated.prepare(
          "SELECT session_id AS sessionId FROM work_decision_handoffs WHERE handoff_id = ?"
        ).get(concurrent.id)
        migrated.close()
        expect(Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String, record: Schema.String }))(decision))
          .toMatchObject({ sessionId: legacy.id, record: expect.stringContaining("dispatch:legacy-luna") })
        const decodedLane = Schema.decodeUnknownSync(Schema.Struct({
          goalId: Schema.String,
          operationId: Schema.String,
          phase: Schema.String,
          record: Schema.String
        }))(migratedLane)
        expect(decodedLane).toMatchObject({
          goalId: lane.laneId,
          operationId: lane.laneId,
          phase: lane.phase
        })
        expect(JSON.parse(decodedLane.record)).toEqual({ ...lane, goalId: lane.laneId, operationId: lane.laneId })
        expect(Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(dispatch).record)
          .toContain("dispatch:legacy-luna")
        expect(Schema.decodeUnknownSync(Schema.Struct({ workLink: Schema.String }))(metadata).workLink)
          .toContain("dispatch:legacy-luna")
        expect(Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(concurrentDecision).sessionId)
          .toBe(concurrent.id)
      })
    }))

  it.effect("rejects a partial coordinator schema before SQL Work DDL", () =>
    withTemporaryRoot("herdr-orchestrator-partial-schema-preflight-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const database = new DatabaseSync(path)
        database.exec("CREATE TABLE orchestrator_dispatches (id TEXT)")
        database.close()

        expect(yield* Effect.result(withDatabase(path, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.schema" },
            operation: "initialize.work"
          }
        })
        const unchanged = new DatabaseSync(path)
        const workTables = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(
          unchanged.prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'work_%'"
          ).get()
        )
        unchanged.close()
        expect(workTables.count).toBe(0)
      })
    }))

  it.effect("migrates current-schema v1 handoffs and replays the exact running worker", () =>
    withTemporaryRoot("herdr-orchestrator-current-handoff-migration-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const parentDispatchRequestId = "dispatch:failed-luna"
      const workLink = makeWorkLink([parentDispatchRequestId])
      const submission = {
        ...makeSolSubmission(null, "dispatch:current-handoff-migration"),
        workLink
      }
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, submission.workLink)
        const activation = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const receipt = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(receipt.dispatchRequestId)
            return yield* orchestrator.workerStarted({
              dispatchRequestId: receipt.dispatchRequestId,
              expectedRevision: lane.revision,
              laneId: lane.laneId,
              version: "herdr.work.agent-binding-request.v1",
              worker: startedWorker
            })
          })
        )
        const previousHandoff = {
          blockers: workLink.handoff.blockers,
          decision: workLink.handoff.decision,
          dispatchIds: [...workLink.handoff.dispatchIds, "dispatch:earlier"],
          evidenceRefs: workLink.handoff.evidenceRefs,
          goalId: workLink.handoff.goalId,
          id: workLink.handoff.id,
          laneId: workLink.handoff.laneId,
          occurredAt: workLink.handoff.occurredAt,
          owner: workLink.handoff.owner,
          sessionId: workLink.handoff.sessionId,
          summary: workLink.handoff.summary,
          version: "herdr.work.decision.v1"
        }
        const database = new DatabaseSync(path)
        database.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        database.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify(previousHandoff), activation.event.dispatchRequestId)
        database.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage }),
            activation.event.dispatchRequestId
          )
        database.close()

        const v2OnlyPartialSchemaPath = join(root, "v2-only-partial-coordinator-schema.sqlite")
        copyFileSync(path, v2OnlyPartialSchemaPath)
        yield* withDatabase(v2OnlyPartialSchemaPath, Effect.void)
        const v2OnlyPartialSchema = new DatabaseSync(v2OnlyPartialSchemaPath)
        v2OnlyPartialSchema.exec("DROP TABLE orchestrator_dispatch_metadata")
        v2OnlyPartialSchema.close()
        expect(yield* Effect.result(withDatabase(v2OnlyPartialSchemaPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.schema" },
            operation: "initialize.work"
          }
        })

        const v2OnlyMissingMetadataPath = join(root, "v2-only-missing-metadata.sqlite")
        copyFileSync(v2OnlyPartialSchemaPath, v2OnlyMissingMetadataPath)
        const v2OnlyMissingMetadata = new DatabaseSync(v2OnlyMissingMetadataPath)
        v2OnlyMissingMetadata.exec(`
          CREATE TABLE orchestrator_dispatch_metadata (
            dispatch_request_id TEXT PRIMARY KEY,
            route TEXT NOT NULL,
            work_link TEXT
          )
        `)
        v2OnlyMissingMetadata.close()
        expect(yield* Effect.result(withDatabase(v2OnlyMissingMetadataPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.metadata-authority" },
            operation: "initialize.work"
          }
        })

        const missingAuthorityMetadataPath = join(root, "missing-metadata-current.sqlite")
        copyFileSync(path, missingAuthorityMetadataPath)
        const missingAuthorityMetadata = new DatabaseSync(missingAuthorityMetadataPath)
        missingAuthorityMetadata.exec("DROP TABLE orchestrator_dispatch_metadata")
        missingAuthorityMetadata.close()
        expect(yield* Effect.result(withDatabase(missingAuthorityMetadataPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.schema" },
            operation: "initialize.work"
          }
        })

        const unroutedPath = join(root, "unrouted-current.sqlite")
        copyFileSync(path, unroutedPath)
        const unrouted = new DatabaseSync(unroutedPath)
        unrouted.prepare("UPDATE orchestrator_dispatches SET is_routed = 0").run()
        unrouted.close()
        expect(yield* Effect.result(withDatabase(unroutedPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.metadata-authority" },
            operation: "initialize.work"
          }
        })
        const unroutedRolledBack = new DatabaseSync(unroutedPath)
        const unroutedDecision = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          unroutedRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        unroutedRolledBack.close()
        expect(JSON.parse(unroutedDecision.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        const missingParentPath = join(root, "missing-parent-current.sqlite")
        copyFileSync(path, missingParentPath)
        const missingParent = new DatabaseSync(missingParentPath)
        missingParent.prepare("UPDATE orchestrator_dispatch_metadata SET route = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ ...submission.route, linkedRequestId: parentDispatchRequestId }),
            activation.event.dispatchRequestId
          )
        missingParent.close()
        expect(yield* Effect.result(withDatabase(missingParentPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.metadata-authority.parent" },
            operation: "initialize.work"
          }
        })

        const failedParentPath = join(root, "failed-parent-current.sqlite")
        copyFileSync(path, failedParentPath)
        const failedParent = new DatabaseSync(failedParentPath)
        persistMigrationLifecycle(failedParent, parentDispatchRequestId, 10, "delivery_failed", "consult")
        failedParent.prepare("UPDATE orchestrator_dispatch_metadata SET route = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ ...submission.route, linkedRequestId: parentDispatchRequestId }),
            activation.event.dispatchRequestId
          )
        failedParent.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, NULL)")
          .run(parentDispatchRequestId, JSON.stringify(lunaRoute))
        failedParent.close()
        yield* withDatabase(failedParentPath, Effect.void)

        const queuedBindingPath = join(root, "queued-binding-current-handoff.sqlite")
        copyFileSync(path, queuedBindingPath)
        const queuedBinding = new DatabaseSync(queuedBindingPath)
        queuedBinding.prepare("DELETE FROM orchestrator_events WHERE dispatch_request_id = ? AND type = 'running'")
          .run(activation.event.dispatchRequestId)
        queuedBinding.prepare("UPDATE orchestrator_dispatches SET status = 'queued' WHERE dispatch_request_id = ?")
          .run(activation.event.dispatchRequestId)
        queuedBinding.close()
        expect(yield* Effect.result(withDatabase(queuedBindingPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.agent-binding.lifecycle" },
            operation: "initialize.work"
          }
        })
        const queuedBindingRolledBack = new DatabaseSync(queuedBindingPath)
        const retainedQueuedBinding = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          queuedBindingRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        queuedBindingRolledBack.close()
        expect(JSON.parse(retainedQueuedBinding.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        const incompleteTerminalPath = join(root, "incomplete-terminal-current-handoff.sqlite")
        copyFileSync(path, incompleteTerminalPath)
        const incompleteTerminal = new DatabaseSync(incompleteTerminalPath)
        incompleteTerminal.prepare("UPDATE orchestrator_dispatches SET status = 'settled'").run()
        incompleteTerminal.close()
        expect(yield* Effect.result(withDatabase(incompleteTerminalPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.agent-binding.lifecycle" },
            operation: "initialize.work"
          }
        })
        const incompleteTerminalRolledBack = new DatabaseSync(incompleteTerminalPath)
        const retainedIncompleteTerminal = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          incompleteTerminalRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        incompleteTerminalRolledBack.close()
        expect(JSON.parse(retainedIncompleteTerminal.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        const completeTerminalPath = join(root, "complete-terminal-current-handoff.sqlite")
        copyFileSync(path, completeTerminalPath)
        const completeTerminal = new DatabaseSync(completeTerminalPath)
        completeTerminal.prepare(
          `INSERT INTO orchestrator_events
             (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
           SELECT dispatch_request_id, 3, 'settled', activity_idempotency_key, ? + 1, NULL, 'done'
           FROM orchestrator_dispatches WHERE dispatch_request_id = ?`
        ).run(activation.event.occurredAt, activation.event.dispatchRequestId)
        completeTerminal.prepare("UPDATE orchestrator_dispatches SET status = 'settled'").run()
        completeTerminal.close()
        yield* withDatabase(completeTerminalPath, Effect.void)

        const mismatchedGoalPath = join(root, "mismatched-binding-goal-current-handoff.sqlite")
        copyFileSync(path, mismatchedGoalPath)
        const mismatchedGoal = new DatabaseSync(mismatchedGoalPath)
        const otherGoalHandoff = { ...previousHandoff, goalId: "goal:other" }
        mismatchedGoal.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(otherGoalHandoff), previousHandoff.id)
        mismatchedGoal.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify(otherGoalHandoff), activation.event.dispatchRequestId)
        mismatchedGoal.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ handoff: otherGoalHandoff, lineage: workLink.lineage }),
            activation.event.dispatchRequestId
          )
        mismatchedGoal.close()
        expect(yield* Effect.result(withDatabase(mismatchedGoalPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.agent-binding.goal" },
            operation: "initialize.work"
          }
        })

        for (
          const invalidRoute of [
            { name: "work-linked-luna", route: lunaRoute },
            {
              name: "outsider-sol-link",
              route: { ...submission.route, linkedRequestId: "dispatch:outsider" }
            }
          ]
        ) {
          const invalidRoutePath = join(root, `${invalidRoute.name}.sqlite`)
          copyFileSync(path, invalidRoutePath)
          const candidate = new DatabaseSync(invalidRoutePath)
          candidate.prepare("UPDATE orchestrator_dispatch_metadata SET route = ? WHERE dispatch_request_id = ?")
            .run(JSON.stringify(invalidRoute.route), activation.event.dispatchRequestId)
          candidate.close()
          expect(yield* Effect.result(withDatabase(invalidRoutePath, Effect.void))).toMatchObject({
            failure: {
              _tag: "OrchestratorStorageError",
              cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.metadata-authority" },
              operation: "initialize.work"
            }
          })
        }

        const replay = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return {
              activation: yield* orchestrator.workerStarted(activation.binding.request),
              request: yield* orchestrator.request(activation.event.dispatchRequestId)
            }
          })
        )
        expect(replay.activation).toEqual(activation)
        expect(replay.request.workLink?.handoff).toMatchObject({
          contextDelta: previousHandoff.summary,
          expectedRevision: activation.binding.request.expectedRevision,
          version: "herdr.work.decision.v2"
        })

        const multipleDispatchPath = join(root, "multiple-dispatches.sqlite")
        copyFileSync(path, multipleDispatchPath)
        const multipleDispatches = new DatabaseSync(multipleDispatchPath)
        multipleDispatches.exec(`
          ALTER TABLE work_dispatch_handoffs RENAME TO previous_work_dispatch_handoffs;
          CREATE TABLE work_dispatch_handoffs (
            dispatch_request_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, lane_id TEXT NOT NULL,
            occurred_at INTEGER NOT NULL, lineage TEXT NOT NULL, record TEXT NOT NULL,
            FOREIGN KEY (handoff_id) REFERENCES work_decision_handoffs(handoff_id)
          );
        `)
        multipleDispatches.prepare(
          `INSERT INTO orchestrator_dispatches
             (dispatch_request_id, idempotency_key, activity_idempotency_key, command, accepted_at, is_routed, status)
           SELECT ?, idempotency_key || ':unbound', activity_idempotency_key || ':unbound', command,
             accepted_at, is_routed, status
           FROM orchestrator_dispatches WHERE dispatch_request_id = ?`
        ).run("dispatch:unbound-current-handoff", activation.event.dispatchRequestId)
        multipleDispatches.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)").run(
          "dispatch:unbound-current-handoff",
          previousHandoff.id,
          previousHandoff.laneId,
          previousHandoff.occurredAt,
          JSON.stringify(workLink.lineage),
          JSON.stringify(previousHandoff)
        )
        multipleDispatches.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)").run(
          "dispatch:unbound-current-handoff",
          JSON.stringify(submission.route),
          JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage })
        )
        multipleDispatches.prepare(
          `INSERT INTO work_dispatch_handoffs
           SELECT dispatch_request_id, handoff_id, lane_id, occurred_at, lineage, ?
           FROM previous_work_dispatch_handoffs`
        ).run(JSON.stringify(previousHandoff))
        multipleDispatches.exec("DROP TABLE previous_work_dispatch_handoffs")
        multipleDispatches.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        multipleDispatches.prepare(
          "UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?"
        )
          .run(
            JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage }),
            activation.event.dispatchRequestId
          )
        multipleDispatches.close()

        expect(yield* Effect.result(withDatabase(multipleDispatchPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.dispatch-cardinality" },
            operation: "initialize.work"
          }
        })
        const multipleRolledBack = new DatabaseSync(multipleDispatchPath)
        const retainedMultipleDecision = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          multipleRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        const retainedMultipleDispatches = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
          record: Schema.String
        })))(
          multipleRolledBack.prepare(
            "SELECT record FROM work_dispatch_handoffs WHERE handoff_id = ? ORDER BY dispatch_request_id"
          ).all(previousHandoff.id)
        )
        multipleRolledBack.close()
        expect(JSON.parse(retainedMultipleDecision.record)).toMatchObject({ version: "herdr.work.decision.v1" })
        expect(retainedMultipleDispatches).toHaveLength(2)
        for (const retained of retainedMultipleDispatches) {
          expect(JSON.parse(retained.record)).toMatchObject({ version: "herdr.work.decision.v1" })
        }

        const upgradedHandoff = {
          ...previousHandoff,
          contextDelta: previousHandoff.summary,
          expectedRevision: activation.binding.request.expectedRevision,
          version: "herdr.work.decision.v2"
        }
        const current = new DatabaseSync(path)
        const retainedBeforeReopen = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          current.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        current.close()
        yield* withDatabase(path, Effect.void)
        const reopened = new DatabaseSync(path)
        const retainedAfterReopen = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          reopened.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        reopened.close()
        expect(retainedAfterReopen.record).toBe(retainedBeforeReopen.record)

        const currentCommandModeMismatchPath = join(root, "current-command-mode-mismatch.sqlite")
        copyFileSync(path, currentCommandModeMismatchPath)
        const currentCommandModeMismatch = new DatabaseSync(currentCommandModeMismatchPath)
        currentCommandModeMismatch.prepare(
          `UPDATE orchestrator_dispatches
           SET command = json_set(command, '$.payload.mode', 'transition_summary')
           WHERE dispatch_request_id = ?`
        ).run(activation.event.dispatchRequestId)
        const currentCommandModeMismatchBefore = Schema.decodeUnknownSync(Schema.Struct({
          command: Schema.String,
          record: Schema.String
        }))(
          currentCommandModeMismatch.prepare(
            `SELECT dispatch.command, decision.record
             FROM orchestrator_dispatches dispatch
             JOIN work_dispatch_handoffs handoff USING (dispatch_request_id)
             JOIN work_decision_handoffs decision USING (handoff_id)
             WHERE dispatch.dispatch_request_id = ?`
          ).get(activation.event.dispatchRequestId)
        )
        currentCommandModeMismatch.close()
        expect(yield* Effect.result(withDatabase(currentCommandModeMismatchPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.metadata-authority" },
            operation: "initialize.work"
          }
        })
        const currentCommandModeMismatchRolledBack = new DatabaseSync(currentCommandModeMismatchPath)
        const currentCommandModeMismatchAfter = Schema.decodeUnknownSync(Schema.Struct({
          command: Schema.String,
          record: Schema.String
        }))(
          currentCommandModeMismatchRolledBack.prepare(
            `SELECT dispatch.command, decision.record
             FROM orchestrator_dispatches dispatch
             JOIN work_dispatch_handoffs handoff USING (dispatch_request_id)
             JOIN work_decision_handoffs decision USING (handoff_id)
             WHERE dispatch.dispatch_request_id = ?`
          ).get(activation.event.dispatchRequestId)
        )
        currentCommandModeMismatchRolledBack.close()
        expect(currentCommandModeMismatchAfter).toEqual(currentCommandModeMismatchBefore)

        for (
          const integrityCase of [
            {
              name: "current-channelled-sol-command",
              operation: "sql-work.initialize.metadata-authority",
              mutate: (candidate: DatabaseSync) =>
                candidate.prepare(
                  `UPDATE orchestrator_dispatches
                   SET command = json_set(command, '$.payload.channel', 'coordinator_chat')
                   WHERE dispatch_request_id = ?`
                ).run(activation.event.dispatchRequestId)
            },
            {
              name: "current-command-activity-key-mismatch",
              operation: "sql-work.initialize.metadata-authority",
              mutate: (candidate: DatabaseSync) =>
                candidate.prepare(
                  `UPDATE orchestrator_dispatches
                   SET command = json_set(command, '$.activityIdempotencyKey', 'activity:outsider')
                   WHERE dispatch_request_id = ?`
                ).run(activation.event.dispatchRequestId)
            },
            {
              name: "current-missing-running-binding",
              operation: "sql-work.initialize.current-agent-binding",
              mutate: (candidate: DatabaseSync) =>
                candidate.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
                  .run(activation.event.dispatchRequestId)
            },
            {
              name: "current-orphan-dispatch",
              operation: "sql-work.initialize.dispatch-decision",
              mutate: (candidate: DatabaseSync) => {
                candidate.exec("PRAGMA foreign_keys = OFF")
                candidate.prepare("DELETE FROM work_decision_handoffs WHERE handoff_id = ?")
                  .run(previousHandoff.id)
              }
            }
          ]
        ) {
          const integrityPath = join(root, `${integrityCase.name}.sqlite`)
          copyFileSync(path, integrityPath)
          const candidate = new DatabaseSync(integrityPath)
          integrityCase.mutate(candidate)
          candidate.close()
          expect(yield* Effect.result(withDatabase(integrityPath, Effect.void))).toMatchObject({
            failure: {
              _tag: "OrchestratorStorageError",
              cause: { _tag: "WorkStoreError", operation: integrityCase.operation },
              operation: "initialize.work"
            }
          })
        }

        for (
          const terminal of ["queued", "delivery_failed"] satisfies ReadonlyArray<
            "queued" | "delivery_failed"
          >
        ) {
          const bindingFreePath = join(root, `current-binding-free-${terminal}.sqlite`)
          copyFileSync(path, bindingFreePath)
          const bindingFree = new DatabaseSync(bindingFreePath)
          bindingFree.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
            .run(activation.event.dispatchRequestId)
          bindingFree.prepare("DELETE FROM orchestrator_events WHERE type = 'running'").run()
          if (terminal === "delivery_failed") {
            bindingFree.prepare(
              `INSERT INTO orchestrator_events
                 (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
               VALUES (?, 2, 'delivery_failed', ?, 2, 'delivery failed before worker start', NULL)`
            ).run(activation.event.dispatchRequestId, activation.event.activityIdempotencyKey)
          }
          bindingFree.prepare("UPDATE orchestrator_dispatches SET status = ? WHERE dispatch_request_id = ?")
            .run(terminal, activation.event.dispatchRequestId)
          bindingFree.close()
          yield* withDatabase(bindingFreePath, Effect.void)
        }

        for (
          const invalid of [
            {
              name: "unknown-handoff-version",
              operation: "sql-work.initialize.invalid-handoff",
              record: JSON.stringify({ ...upgradedHandoff, version: "herdr.work.decision.v3" })
            },
            {
              name: "malformed-current-handoff",
              operation: "sql-work.initialize.invalid-handoff",
              record: JSON.stringify({ ...upgradedHandoff, expectedRevision: "not-a-revision" })
            },
            {
              name: "current-handoff-indexed-lane-mismatch",
              operation: "sql-work.initialize.handoff-identity",
              record: JSON.stringify({ ...upgradedHandoff, laneId: "lane:other" })
            }
          ]
        ) {
          const invalidPath = join(root, `${invalid.name}.sqlite`)
          copyFileSync(path, invalidPath)
          const candidate = new DatabaseSync(invalidPath)
          candidate.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
            .run(invalid.record, previousHandoff.id)
          candidate.close()

          expect(yield* Effect.result(withDatabase(invalidPath, Effect.void))).toMatchObject({
            failure: {
              _tag: "OrchestratorStorageError",
              cause: { _tag: "WorkStoreError", operation: invalid.operation },
              operation: "initialize.work"
            }
          })
          const rolledBack = new DatabaseSync(invalidPath)
          const retained = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
            rolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
              .get(previousHandoff.id)
          )
          rolledBack.close()
          expect(retained.record).toBe(invalid.record)
        }

        const malformedPath = join(root, "malformed-v1-handoff.sqlite")
        copyFileSync(path, malformedPath)
        const malformed = new DatabaseSync(malformedPath)
        malformed.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify({ ...previousHandoff, dispatchIds: "not-an-array" }), previousHandoff.id)
        malformed.close()
        expect(yield* Effect.result(withDatabase(malformedPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.invalid-handoff" },
            operation: "initialize.work"
          }
        })
        const malformedRolledBack = new DatabaseSync(malformedPath)
        const retainedMalformed = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          malformedRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        malformedRolledBack.close()
        expect(JSON.parse(retainedMalformed.record)).toMatchObject({
          dispatchIds: "not-an-array",
          version: "herdr.work.decision.v1"
        })

        const outsiderPath = join(root, "outsider-lineage.sqlite")
        copyFileSync(path, outsiderPath)
        const outsider = new DatabaseSync(outsiderPath)
        outsider.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        outsider.prepare("UPDATE work_dispatch_handoffs SET lineage = ?, record = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify(["dispatch:outsider"]),
            JSON.stringify(previousHandoff),
            activation.event.dispatchRequestId
          )
        outsider.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ handoff: previousHandoff, lineage: ["dispatch:outsider"] }),
            activation.event.dispatchRequestId
          )
        outsider.close()
        expect(yield* Effect.result(withDatabase(outsiderPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.dispatch-authority" },
            operation: "initialize.work"
          }
        })
        const outsiderRolledBack = new DatabaseSync(outsiderPath)
        const retainedOutsider = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          outsiderRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        outsiderRolledBack.close()
        expect(JSON.parse(retainedOutsider.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        const corruptBindingPath = join(root, "corrupt-binding.sqlite")
        copyFileSync(path, corruptBindingPath)
        const corruptBinding = new DatabaseSync(corruptBindingPath)
        corruptBinding.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        corruptBinding.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify(previousHandoff), activation.event.dispatchRequestId)
        corruptBinding.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage }),
            activation.event.dispatchRequestId
          )
        corruptBinding.prepare("UPDATE work_agent_bindings SET expected_revision = expected_revision + 1")
          .run()
        corruptBinding.close()
        expect(yield* Effect.result(withDatabase(corruptBindingPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.agent-binding.identity-mismatch" },
            operation: "initialize.work"
          }
        })
        const corruptBindingRolledBack = new DatabaseSync(corruptBindingPath)
        const retainedCorruptBinding = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          corruptBindingRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        corruptBindingRolledBack.close()
        expect(JSON.parse(retainedCorruptBinding.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        for (
          const companion of [
            {
              expectedOperation: "sql-work.initialize.agent-binding.missing-companion",
              name: "missing-checkpoint-companion",
              mutate: (candidate: DatabaseSync) =>
                candidate.prepare("DELETE FROM work_goal_events WHERE event_id = ?")
                  .run(activation.binding.checkpoint.eventId)
            },
            {
              expectedOperation: "sql-work.initialize.agent-binding.companion-identity-mismatch",
              name: "mismatched-lane-companion",
              mutate: (candidate: DatabaseSync) =>
                candidate.prepare("UPDATE work_lane_operations SET revision = revision + 1 WHERE operation_id = ?")
                  .run(activation.binding.lane.operationId)
            }
          ]
        ) {
          const companionPath = join(root, `${companion.name}.sqlite`)
          copyFileSync(path, companionPath)
          const candidate = new DatabaseSync(companionPath)
          candidate.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
            .run(JSON.stringify(previousHandoff), previousHandoff.id)
          candidate.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
            .run(JSON.stringify(previousHandoff), activation.event.dispatchRequestId)
          candidate.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
            .run(
              JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage }),
              activation.event.dispatchRequestId
            )
          companion.mutate(candidate)
          candidate.close()

          expect(yield* Effect.result(withDatabase(companionPath, Effect.void))).toMatchObject({
            failure: {
              _tag: "OrchestratorStorageError",
              cause: { _tag: "WorkStoreError", operation: companion.expectedOperation },
              operation: "initialize.work"
            }
          })
          const rolledBack = new DatabaseSync(companionPath)
          const retained = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
            rolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
              .get(previousHandoff.id)
          )
          rolledBack.close()
          expect(JSON.parse(retained.record)).toMatchObject({ version: "herdr.work.decision.v1" })
        }

        const missingMetadataPath = join(root, "missing-metadata.sqlite")
        copyFileSync(path, missingMetadataPath)
        const missingMetadata = new DatabaseSync(missingMetadataPath)
        missingMetadata.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        missingMetadata.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify(previousHandoff), activation.event.dispatchRequestId)
        missingMetadata.prepare("DELETE FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?")
          .run(activation.event.dispatchRequestId)
        missingMetadata.close()
        expect(yield* Effect.result(withDatabase(missingMetadataPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.metadata-authority" },
            operation: "initialize.work"
          }
        })
        const missingMetadataRolledBack = new DatabaseSync(missingMetadataPath)
        const retainedMissingMetadata = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          missingMetadataRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        missingMetadataRolledBack.close()
        expect(JSON.parse(retainedMissingMetadata.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        const unboundDecisionPath = join(root, "unbound-decision.sqlite")
        copyFileSync(path, unboundDecisionPath)
        const unboundDecision = new DatabaseSync(unboundDecisionPath)
        const advancedLane = {
          ...activation.binding.lane,
          expectedRevision: activation.binding.lane.revision,
          revision: activation.binding.lane.revision + 1
        }
        unboundDecision.prepare("UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?")
          .run(advancedLane.revision, JSON.stringify(advancedLane), advancedLane.laneId)
        unboundDecision.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        unboundDecision.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
          .run(activation.event.dispatchRequestId)
        unboundDecision.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
          .run(activation.event.dispatchRequestId)
        unboundDecision.prepare("DELETE FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?")
          .run(activation.event.dispatchRequestId)
        unboundDecision.close()
        expect(yield* Effect.result(withDatabase(unboundDecisionPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.handoff-revision" },
            operation: "initialize.work"
          }
        })
        const unboundDecisionRolledBack = new DatabaseSync(unboundDecisionPath)
        const retainedUnboundDecision = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          unboundDecisionRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        unboundDecisionRolledBack.close()
        expect(JSON.parse(retainedUnboundDecision.record)).toMatchObject({ version: "herdr.work.decision.v1" })

        const orphanMetadataPath = join(root, "orphan-metadata.sqlite")
        copyFileSync(path, orphanMetadataPath)
        const orphanMetadata = new DatabaseSync(orphanMetadataPath)
        orphanMetadata.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        orphanMetadata.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
          .run(activation.event.dispatchRequestId)
        orphanMetadata.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage }),
            activation.event.dispatchRequestId
          )
        expect(
          orphanMetadata.prepare(
            `SELECT json_extract(work_link, '$.handoff.id') AS handoffId,
               (SELECT COUNT(*) FROM work_dispatch_handoffs) AS dispatchCount
             FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?`
          ).get(activation.event.dispatchRequestId)
        ).toEqual({ dispatchCount: 0, handoffId: previousHandoff.id })
        orphanMetadata.close()
        expect(yield* Effect.result(withDatabase(orphanMetadataPath, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.metadata-authority" },
            operation: "initialize.work"
          }
        })
        const orphanMetadataRolledBack = new DatabaseSync(orphanMetadataPath)
        const retainedOrphanMetadata = Schema.decodeUnknownSync(Schema.Struct({
          record: Schema.String,
          workLink: Schema.String
        }))(
          orphanMetadataRolledBack.prepare(
            `SELECT decision.record, metadata.work_link AS workLink
             FROM work_decision_handoffs decision
             JOIN orchestrator_dispatch_metadata metadata
             WHERE decision.handoff_id = ? AND metadata.dispatch_request_id = ?`
          ).get(previousHandoff.id, activation.event.dispatchRequestId)
        )
        orphanMetadataRolledBack.close()
        expect(JSON.parse(retainedOrphanMetadata.record)).toMatchObject({ version: "herdr.work.decision.v1" })
        expect(JSON.parse(retainedOrphanMetadata.workLink)).toMatchObject({
          handoff: { version: "herdr.work.decision.v1" }
        })

        const divergent = new DatabaseSync(path)
        divergent.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        divergent.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ ...previousHandoff, summary: "Divergent SQL replica" }),
            activation.event.dispatchRequestId
          )
        divergent.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage }),
            activation.event.dispatchRequestId
          )
        divergent.close()
        expect(yield* Effect.result(withDatabase(path, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.dispatch-authority" },
            operation: "initialize.work"
          }
        })
        const rolledBack = new DatabaseSync(path)
        const retained = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          rolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        rolledBack.close()
        expect(JSON.parse(retained.record)).toMatchObject({ version: "herdr.work.decision.v1" })
      })
    }))

  it.effect("fails closed instead of re-authorizing an unbound queued v1 handoff", () =>
    withTemporaryRoot("herdr-orchestrator-unbound-handoff-migration-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const workLink = makeWorkLink([])
      const submission = {
        ...makeSolSubmission(null, "dispatch:unbound-handoff-migration"),
        workLink
      }
      return Effect.gen(function*() {
        const lane = yield* recordWorkAuthority(path, workLink)
        const receipt = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const accepted = yield* orchestrator.submitRouted(submission)
            yield* orchestrator.queue(accepted.dispatchRequestId)
            return accepted
          })
        )
        const previousHandoff = {
          blockers: workLink.handoff.blockers,
          decision: workLink.handoff.decision,
          dispatchIds: workLink.handoff.dispatchIds,
          evidenceRefs: workLink.handoff.evidenceRefs,
          goalId: workLink.handoff.goalId,
          id: workLink.handoff.id,
          laneId: workLink.handoff.laneId,
          occurredAt: workLink.handoff.occurredAt,
          owner: workLink.handoff.owner,
          sessionId: workLink.handoff.sessionId,
          summary: workLink.handoff.summary,
          version: "herdr.work.decision.v1"
        }
        const advancedLane = {
          ...lane,
          expectedRevision: lane.revision,
          revision: lane.revision + 1
        }
        const database = new DatabaseSync(path)
        database.prepare("UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?")
          .run(advancedLane.revision, JSON.stringify(advancedLane), advancedLane.laneId)
        database.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        database.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify(previousHandoff), receipt.dispatchRequestId)
        database.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(
            JSON.stringify({ handoff: previousHandoff, lineage: workLink.lineage }),
            receipt.dispatchRequestId
          )
        database.close()

        expect(yield* Effect.result(withDatabase(path, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.handoff-revision" },
            operation: "initialize.work"
          }
        })
        const rolledBack = new DatabaseSync(path)
        const retained = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          rolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(previousHandoff.id)
        )
        rolledBack.close()
        expect(JSON.parse(retained.record)).toMatchObject({ version: "herdr.work.decision.v1" })
      })
    }))

  it.effect("rejects a mutated referenced Work decision during initialization", () =>
    withTemporaryRoot("herdr-orchestrator-work-readback-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* recordWorkAuthority(path, makeWorkLink([]))
        yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:readback-luna"),
              idempotencyKey: "dispatch:readback-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            yield* orchestrator.failTask(luna.dispatchRequestId, "Luna task failed")
            return yield* orchestrator.submitRouted(makeSolSubmission(luna.dispatchRequestId, "dispatch:readback-sol"))
          })
        )
        const database = new DatabaseSync(path)
        database.prepare(
          `UPDATE work_decision_handoffs
           SET record = replace(record, 'Escalate the failed Luna request to Sol', 'Changed durable decision')
           WHERE handoff_id = ?`
        ).run("handoff:escalation")
        database.close()

        expect(yield* Effect.result(withDatabase(path, Effect.void))).toMatchObject({
          failure: {
            _tag: "OrchestratorStorageError",
            cause: { _tag: "WorkStoreError", operation: "sql-work.initialize.dispatch-authority" },
            operation: "initialize.work"
          }
        })
      })
    }))

  it.effect("rejects invalid public route and Work-link combinations", () =>
    Effect.gen(function*() {
      const solSubmission = makeSolSubmission(null, "dispatch:schema")
      const solRoute = solSubmission.route
      const workLink = makeWorkLink([])
      const request = {
        acceptedAt: 0,
        activityIdempotencyKey: solSubmission.command.activityIdempotencyKey,
        command: solSubmission.command,
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
              command: makeLunaCommand("consult", "activity:route-live-luna"),
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

  it.effect("rejects a Sol link whose lineage contradicts its Work handoff", () =>
    withTemporaryRoot("herdr-orchestrator-work-lineage-reject-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission("dispatch:lineage-parent", "dispatch:lineage-invalid-sol")
      const contradictory = {
        ...submission,
        workLink: submission.workLink === null ? null : {
          ...submission.workLink,
          handoff: { ...submission.workLink.handoff, dispatchIds: ["dispatch:unrelated"] }
        }
      } satisfies OrchestratorRoutedSubmission
      return Effect.gen(function*() {
        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.submitRouted(contradictory))
          })
        )
        expect(result).toMatchObject({ failure: { _tag: "OrchestratorValidationError" } })
        const database = new DatabaseSync(path)
        const count = database.prepare("SELECT COUNT(*) AS count FROM orchestrator_dispatches").get()
        database.close()
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(count).count).toBe(0)
      })
    }))

  it.effect("rejects a transition summary Sol route before persistence", () =>
    withTemporaryRoot("herdr-orchestrator-transition-summary-sol-reject-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      const submission = makeSolSubmission(null, "dispatch:transition-summary-sol")
      const invalid = {
        ...submission,
        command: {
          ...submission.command,
          payload: { ...submission.command.payload, mode: "transition_summary" }
        }
      }
      return Effect.gen(function*() {
        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(
              Schema.decodeUnknownEffect(OrchestratorRoutedSubmission)(invalid).pipe(
                Effect.flatMap((decoded) => orchestrator.submitRouted(decoded))
              )
            )
          })
        )
        expect(result).toMatchObject({ failure: { _tag: "SchemaError" } })
        const database = new DatabaseSync(path)
        const count = database.prepare("SELECT COUNT(*) AS count FROM orchestrator_dispatches").get()
        database.close()
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(count).count).toBe(0)
      })
    }))

  it.effect("rolls back Sol acceptance when the Work handoff cannot be recorded", () =>
    withTemporaryRoot("herdr-orchestrator-work-atomicity-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        yield* recordWorkAuthority(path, makeWorkLink([]))
        const failedLuna = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:atomicity-luna"),
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
        database.prepare(`
          WITH RECURSIVE capacity(value) AS (
            VALUES(1)
            UNION ALL
            SELECT value + 1 FROM capacity WHERE value < 16384
          )
          INSERT INTO work_decision_handoffs (handoff_id, session_id, lane_id, occurred_at, record)
          SELECT 'capacity:' || value, 'session:capacity:' || value, 'lane:capacity', value,
            json_set(
              ?, '$.id', 'capacity:' || value, '$.sessionId', 'session:capacity:' || value,
              '$.laneId', 'lane:capacity', '$.goalId', 'lane:capacity', '$.occurredAt', value
            )
          FROM capacity
        `).run(JSON.stringify(makeWorkLink([]).handoff))
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

  it.effect("rolls back Sol acceptance when the handoff lacks active lane authority", () =>
    withTemporaryRoot("herdr-orchestrator-work-authority-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const authority = makeWorkLink([])
        yield* recordWorkAuthority(path, authority)
        const failedLuna = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:authority-luna"),
              idempotencyKey: "dispatch:authority-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            return yield* orchestrator.failTask(luna.dispatchRequestId, "Luna task failed")
          })
        )
        const submission = makeSolSubmission(
          failedLuna.dispatchRequestId,
          "dispatch:authority-invalid-sol"
        )
        const wrongGoal = {
          ...submission,
          workLink: submission.workLink === null ? null : {
            ...submission.workLink,
            handoff: { ...submission.workLink.handoff, goalId: "goal:other" }
          }
        } satisfies OrchestratorRoutedSubmission

        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            return yield* Effect.result(orchestrator.submitRouted(wrongGoal))
          })
        )
        expect(result).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "submit.work-link" }
        })

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
        ).toEqual({ accepted: 1, dispatches: 1, workLinks: 0 })
      })
    }))

  it.effect("rolls back Sol acceptance when Work has duplicate active goal authority", () =>
    withTemporaryRoot("herdr-orchestrator-work-ambiguous-authority-", (root) => {
      const path = join(root, "orchestrator.sqlite")
      return Effect.gen(function*() {
        const workLink = makeWorkLink([])
        const lane = yield* recordWorkAuthority(path, workLink)
        const duplicate = {
          ...lane,
          laneId: "lane:duplicate-submit-authority",
          operationId: "operation:duplicate-submit-authority",
          revision: 1
        }
        const result = yield* withDatabase(
          path,
          Effect.gen(function*() {
            const orchestrator = yield* Orchestrator
            const luna = yield* orchestrator.submitRouted({
              command: makeLunaCommand("consult", "activity:ambiguous-authority-luna"),
              idempotencyKey: "dispatch:ambiguous-authority-luna",
              route: lunaRoute,
              workLink: null
            })
            yield* orchestrator.queue(luna.dispatchRequestId)
            yield* orchestrator.run(luna.dispatchRequestId)
            const failedLuna = yield* orchestrator.failTask(luna.dispatchRequestId, "Luna task failed")
            const database = new DatabaseSync(path)
            database.exec("DROP INDEX work_lane_claims_one_active_goal")
            database.prepare(
              `INSERT INTO work_lane_claims
                 (lane_id, goal_id, operation_id, phase, revision, record)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).run(
              duplicate.laneId,
              duplicate.goalId,
              duplicate.operationId,
              duplicate.phase,
              duplicate.revision,
              JSON.stringify(duplicate)
            )
            database.prepare(
              `INSERT INTO work_lane_operations
                 (operation_id, lane_id, goal_id, phase, revision, record)
               VALUES (?, ?, ?, ?, ?, ?)`
            ).run(
              duplicate.operationId,
              duplicate.laneId,
              duplicate.goalId,
              duplicate.phase,
              duplicate.revision,
              JSON.stringify(duplicate)
            )
            database.close()
            return yield* Effect.result(orchestrator.submitRouted(makeSolSubmission(
              failedLuna.dispatchRequestId,
              "dispatch:ambiguous-authority-sol"
            )))
          })
        )
        expect(result).toMatchObject({
          failure: { _tag: "OrchestratorStorageError", operation: "submit.work-link" }
        })

        const remaining = new DatabaseSync(path)
        const counts = remaining.prepare(
          `SELECT
             (SELECT COUNT(*) FROM orchestrator_dispatches) AS dispatches,
             (SELECT COUNT(*) FROM orchestrator_events WHERE type = 'accepted') AS accepted,
             (SELECT COUNT(*) FROM work_dispatch_handoffs) AS workLinks,
             (SELECT COUNT(*) FROM work_decision_handoffs) AS decisions`
        ).get()
        remaining.close()
        expect(
          Schema.decodeUnknownSync(
            Schema.Struct({
              accepted: Schema.Number,
              decisions: Schema.Number,
              dispatches: Schema.Number,
              workLinks: Schema.Number
            })
          )(counts)
        ).toEqual({ accepted: 1, decisions: 0, dispatches: 1, workLinks: 0 })
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

  it.effect("preserves the logical event clock when the sampled clock moves backward", () =>
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
          const running = yield* orchestrator.run(receipt.dispatchRequestId)
          expect(running).toMatchObject({ occurredAt: 200, type: "running" })
          const events = yield* orchestrator.events(receipt.dispatchRequestId).pipe(
            Stream.take(3),
            Stream.runCollect
          )
          expect(events.map(({ occurredAt, type }) => ({ occurredAt, type }))).toEqual([
            { occurredAt: 100, type: "accepted" },
            { occurredAt: 200, type: "queued" },
            { occurredAt: 200, type: "running" }
          ])
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
            const replacement = yield* orchestrator.events("dispatch:\uFFFD").pipe(Stream.take(1), Stream.runCollect)
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

  it.effect("does not report pending exhaustion while a selected row transitions", () =>
    withTemporaryRoot("herdr-orchestrator-pending-race-", (root) =>
      withDatabase(
        join(root, "orchestrator.sqlite"),
        Effect.gen(function*() {
          const orchestrator = yield* Orchestrator
          for (let index = 0; index < 32; index += 1) {
            yield* TestClock.setTime(index)
            const selected = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: `activity:pending-race:${index}:a` },
              `dispatch:pending-race:${index}:a`
            )
            yield* orchestrator.queue(selected.dispatchRequestId)
            const later = yield* orchestrator.submit(
              { ...command, activityIdempotencyKey: `activity:pending-race:${index}:b` },
              `dispatch:pending-race:${index}:b`
            )
            const [page] = yield* Effect.all([
              orchestrator.pending({ limit: 1 }),
              orchestrator.run(selected.dispatchRequestId)
            ], { concurrency: 2 })
            expect(page).toHaveLength(1)
            expect([selected.dispatchRequestId, later.dispatchRequestId]).toContain(page[0]?.dispatchRequestId)
            yield* orchestrator.settle(selected.dispatchRequestId, "selected complete")
            yield* orchestrator.queue(later.dispatchRequestId)
            yield* orchestrator.run(later.dispatchRequestId)
            yield* orchestrator.settle(later.dispatchRequestId, "later complete")
          }
          expect(yield* orchestrator.pending()).toEqual([])
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

  it.effect("rejects dangling SQLite database and journal symlinks before opening", () =>
    withTemporaryRoot("herdr-orchestrator-dangling-path-", (root) =>
      Effect.gen(function*() {
        const paths: ReadonlyArray<readonly [string, string]> = [["database", ""], ["wal", "-wal"], ["shm", "-shm"]]
        for (const [name, suffix] of paths) {
          const stateDirectory = join(root, name)
          mkdirSync(stateDirectory, { mode: 0o700 })
          const database = join(stateDirectory, "orchestrator.sqlite")
          if (suffix !== "") yield* withDatabase(database, Effect.void)
          const target = join(stateDirectory, "missing-target")
          symlinkSync(target, `${database}${suffix}`)

          const result = yield* Effect.result(withDatabase(database, Effect.void))
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "OrchestratorStorageError", operation: "sqlite.secure.path-identity" }
          })
          expect(existsSync(target)).toBe(false)
        }
      })))
})
