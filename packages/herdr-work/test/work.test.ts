import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { Effect, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { execPath } from "node:process"
import { DatabaseSync } from "node:sqlite"
import {
  makeWorkService,
  projectWorkSnapshots,
  WorkAgentBinding,
  WorkAgentBindingRequest,
  WorkDecisionHandoff,
  WorkDispatchHandoff,
  type WorkGoal,
  WorkGoalCheckpoint,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  type WorkGoalFamily,
  WorkGoalFamilyGroup,
  workHistoryMaxEvents,
  WorkLaneClaim,
  WorkLaneClaimed,
  WorkSnapshot,
  workSnapshotMaxGoals,
  WorkSnapshots,
  WorkStore
} from "../src/index.js"
import {
  __herdrWorkEncodedBytesForTest,
  __herdrWorkLaneOperationMaxBytesForTest,
  __herdrWorkMaximumSnapshotBytesForTest,
  __herdrWorkSnapshotEnvelopeMaxBytesForTest
} from "../src/store.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const openScopedStore = (path: string) =>
  Effect.gen(function*() {
    const state = { open: true }
    const store = yield* Effect.acquireRelease(
      // Existing explicit state makes manual close and scope release one idempotent owner.
      // eslint-disable-next-line local-rules/require-immediate-work-store-cleanup
      WorkStore.open(path),
      (store) =>
        Effect.sync(() => {
          if (state.open) {
            state.open = false
            store.close()
          }
        })
    )
    const close = () => {
      if (state.open) {
        state.open = false
        store.close()
      }
    }
    return { close, store }
  })

const safelyOpenResult = (path: string) =>
  Effect.result(Effect.acquireUseRelease(
    WorkStore.open(path),
    () => Effect.void,
    (store) => Effect.sync(() => store.close())
  ))

class LockHolderError extends Schema.TaggedError<LockHolderError>()(
  "LockHolderError",
  { cause: Schema.String }
) {}

const day = 24 * 60 * 60 * 1_000
const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength

const goal = (
  updatedAt: number,
  state: WorkGoal["state"],
  delivery: WorkGoal["delivery"]
): WorkGoal => ({
  blocker: state === "blocked" ? { since: updatedAt, summary: "Waiting for exact package contracts" } : null,
  connectTarget: state === "planned" ? null : {
    agentId: "agent-package-owner",
    host: "SER8",
    url: "/connect/?agent=agent-package-owner&host=SER8"
  },
  createdAt: 0,
  delivery,
  detail: `Durable ${state} checkpoint`,
  id: "goal-packages",
  owner: { id: "owner-packages", name: "Package owner" },
  repository: { branch: "feat/herdr-npm-packages", repository: "npm" },
  spend: { currency: "USD", minorUnits: 11_370 },
  state,
  summary: "Move Herdr into publishable packages",
  title: "Extract Herdr packages",
  updatedAt
})

const checkpoint = (
  eventId: string,
  updatedAt: number,
  state: WorkGoal["state"],
  delivery: WorkGoal["delivery"]
): WorkGoalCheckpointType => ({
  eventId,
  goal: goal(updatedAt, state, delivery),
  occurredAt: updatedAt,
  version: "herdr.work.event.v1"
})

const checkpointForGoal = (
  goalId: string,
  eventId: string,
  occurredAt: number,
  createdAt: number
): WorkGoalCheckpointType => ({
  eventId,
  goal: {
    ...goal(occurredAt, "working", "local"),
    createdAt,
    id: goalId,
    title: goalId
  },
  occurredAt,
  version: "herdr.work.event.v1"
})

const familyCheckpoint = (
  checkpoint: WorkGoalCheckpointType,
  eventId: string,
  occurredAt: number,
  canonicalGoalId: string,
  role: WorkGoalFamily["role"]
): WorkGoalCheckpointType => ({
  eventId,
  goal: {
    ...checkpoint.goal,
    goalFamily: { canonicalGoalId, role },
    updatedAt: occurredAt
  },
  occurredAt,
  version: "herdr.work.event.v1"
})

const maximumTextCheckpoint = (index: number): WorkGoalCheckpointType => {
  const maximumText = "x".repeat(4_096)
  const agentId = `agent-${"a".repeat(250)}`
  const host = "h".repeat(253)
  const idPrefix = `goal-${index}-`
  const eventPrefix = `event-${index}-`
  return {
    eventId: `${eventPrefix}${"e".repeat(256 - eventPrefix.length)}`,
    goal: {
      blocker: { since: 0, summary: maximumText },
      connectTarget: {
        agentId,
        host,
        url: `/connect/?agent=${agentId}&host=${host}`
      },
      createdAt: 0,
      delivery: "local",
      detail: maximumText,
      id: `${idPrefix}${"g".repeat(256 - idPrefix.length)}`,
      owner: { id: "o".repeat(256), name: maximumText },
      repository: { branch: maximumText, repository: maximumText },
      spend: { currency: "USD", minorUnits: Number.MAX_SAFE_INTEGER },
      state: "blocked",
      summary: maximumText,
      title: maximumText,
      updatedAt: 0
    },
    occurredAt: 0,
    version: "herdr.work.event.v1"
  }
}

const seedWorkDatabase = (
  path: string,
  events: ReadonlyArray<WorkGoalCheckpointType>
): void => {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE work_goal_events (
      event_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      record TEXT NOT NULL,
      UNIQUE (goal_id, occurred_at)
    );
    BEGIN IMMEDIATE;
  `)
  const insert = database.prepare(
    "INSERT INTO work_goal_events (event_id, goal_id, occurred_at, record) VALUES (?, ?, ?, ?)"
  )
  for (const event of events) {
    insert.run(event.eventId, event.goal.id, event.occurredAt, JSON.stringify(event))
  }
  database.exec("COMMIT")
  database.close()
}

const history = [
  checkpoint("event-created", 0, "planned", "local"),
  checkpoint("event-working", 10 * day, "working", "local"),
  checkpoint("event-blocked", 25 * day, "blocked", "local"),
  checkpoint("event-review", 30 * day, "review", "review")
]

const laneClaim = (laneId: string, goalId: string = laneId): WorkLaneClaim => ({
  branch: "feat/durable-work",
  expectedRevision: 0,
  goalId,
  head: "0123456789012345678901234567890123456789",
  laneId,
  operationId: `operation-${laneId}`,
  owner: { id: "owner-packages", name: "Package owner" },
  parent: null,
  phase: "implementation",
  worktree: "/home/konopkov/Work/dev/knpkv.dev/worktrees/npm/feat-durable-work"
})

const startedWorker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
  agentId: "agent-package-worker",
  host: "SER8",
  name: "Package worker",
  paneId: "wE:p3"
})

const migrationBinding = (
  dispatchRequestId: string,
  lane: WorkLaneClaimed,
  occurredAt: number,
  worker: typeof startedWorker = startedWorker
): WorkAgentBinding =>
  Schema.decodeUnknownSync(WorkAgentBinding)({
    checkpoint: {
      eventId: dispatchRequestId,
      goal: {
        ...goal(occurredAt, "working", "local"),
        agentHierarchy: { agent: worker },
        connectTarget: {
          agentId: worker.agentId,
          host: worker.host,
          url: `/connect/?agent=${worker.agentId}&host=${worker.host}`
        },
        id: lane.goalId,
        owner: lane.owner,
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
      worker
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

const migrationSolRoute = (linkedRequestId: string | null) => ({
  action: "dispatch",
  linkedRequestId,
  model: "gpt-5.6-sol",
  protocol: "hostd.coordinator.route.v1",
  reason: "Migrate durable Work authority",
  reasoningEffort: "high"
})

const migrationLunaRoute = {
  action: "dispatch",
  linkedRequestId: null,
  model: "gpt-5.6-luna",
  protocol: "hostd.coordinator.route.v1",
  reason: "Persist failed bounded coordination",
  reasoningEffort: "medium"
}

const persistCoordinatorLifecycle = (
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
      dispatch_request_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL,
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
    insert.run(dispatchRequestId, 3, status, activityIdempotencyKey, runningAt + 1, null, "done")
  } else if (status === "delivery_failed" || status === "task_failed") {
    insert.run(dispatchRequestId, 3, status, activityIdempotencyKey, runningAt + 1, "failed", null)
  }
}

describe("durable Work projection", () => {
  it("exports an exact typed dispatch, lane revision, and worker binding contract", () => {
    const request = {
      dispatchRequestId: "dispatch:worker-start",
      expectedRevision: 1,
      laneId: "lane:package",
      version: "herdr.work.agent-binding-request.v1",
      worker: startedWorker
    }
    expect(Schema.decodeUnknownResult(WorkAgentBindingRequest)(request)._tag).toBe("Success")
    expect(
      Schema.decodeUnknownResult(WorkAgentBindingRequest)({
        ...request,
        expectedRevision: -1
      })._tag
    ).toBe("Failure")
  })

  it.effect("atomically binds a started worker, replays exactly, and recovers after restart", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "herdr-work-agent-binding-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
        const path = join(directory, "work.sqlite")
        const first = yield* openScopedStore(path)
        const service = yield* makeWorkService(first.store)
        yield* service.record(history[0])
        const lane = yield* service.claim(laneClaim("lane:package", history[0].goal.id))
        yield* TestClock.setTime(0)
        const request = Schema.decodeUnknownSync(WorkAgentBindingRequest)({
          dispatchRequestId: "dispatch:worker-start",
          expectedRevision: lane.revision,
          laneId: lane.laneId,
          version: "herdr.work.agent-binding-request.v1",
          worker: startedWorker
        })
        const binding = yield* service.bindAgent(request)
        expect(binding.checkpoint.occurredAt).toBe(1)
        expect(Schema.decodeUnknownResult(WorkAgentBinding)(binding)._tag).toBe("Success")
        expect(binding).toMatchObject({
          checkpoint: {
            eventId: request.dispatchRequestId,
            goal: {
              agentHierarchy: { agent: startedWorker },
              connectTarget: { agentId: startedWorker.agentId, host: startedWorker.host }
            }
          },
          lane: {
            expectedRevision: lane.revision,
            operationId: request.dispatchRequestId,
            revision: lane.revision + 1
          }
        })
        expect((yield* service.snapshots()).now.goals[0]).toMatchObject({
          agentHierarchy: { agent: startedWorker },
          updatedAt: binding.checkpoint.occurredAt
        })
        const future = {
          ...binding.checkpoint,
          eventId: "event:caller-future",
          goal: {
            ...binding.checkpoint.goal,
            summary: "Caller-authored future state",
            updatedAt: day
          },
          occurredAt: day
        }
        yield* service.record(future)
        const currentSnapshot = yield* service.snapshots()
        expect(currentSnapshot.observedAt).toBe(binding.checkpoint.occurredAt)
        expect(currentSnapshot.now.goals[0]?.summary).not.toBe(future.goal.summary)
        expect((yield* service.snapshots(day)).now.goals[0]?.summary).toBe(future.goal.summary)
        expect(yield* service.bindAgent(request)).toEqual(binding)
        expect(
          yield* Effect.result(service.bindAgent({
            ...request,
            worker: { ...startedWorker, agentId: "agent-conflicting-worker" }
          }))
        ).toMatchObject({
          failure: { _tag: "WorkAgentBindingConflictError", dispatchRequestId: request.dispatchRequestId }
        })
        expect(
          yield* Effect.result(service.bindAgent({
            ...request,
            dispatchRequestId: "dispatch:stale-worker-start"
          }))
        ).toMatchObject({
          failure: {
            _tag: "WorkAgentBindingAuthorityError",
            actualRevision: lane.revision + 1,
            reason: "stale_revision"
          }
        })
        first.close()

        const reopened = yield* openScopedStore(path)
        const restarted = yield* makeWorkService(reopened.store)
        expect(Option.getOrThrow(yield* restarted.agentBinding(request.dispatchRequestId))).toEqual(binding)
        expect(Option.getOrThrow(yield* restarted.currentClaim(lane.laneId))).toEqual(binding.lane)
        expect((yield* restarted.snapshots(binding.checkpoint.occurredAt)).now.goals[0]).toMatchObject({
          agentHierarchy: { agent: startedWorker },
          connectTarget: { agentId: startedWorker.agentId, host: startedWorker.host }
        })
      }).pipe(provideNodeServices)
    ))

  it.effect("rejects agent binding when corrupted storage has duplicate active goal claims", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "herdr-work-agent-binding-ambiguous-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
        const path = join(directory, "work.sqlite")
        const opened = yield* openScopedStore(path)
        const service = yield* makeWorkService(opened.store)
        yield* service.record(history[0])
        const lane = yield* service.claim(laneClaim("lane:authority", history[0].goal.id))
        const duplicate = Schema.decodeUnknownSync(WorkLaneClaimed)({
          ...laneClaim("lane:duplicate-authority", history[0].goal.id),
          revision: 1
        })
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

        yield* TestClock.setTime(1)
        const dispatchRequestId = "dispatch:ambiguous-authority"
        expect(
          yield* Effect.result(service.bindAgent({
            dispatchRequestId,
            expectedRevision: lane.revision,
            laneId: lane.laneId,
            version: "herdr.work.agent-binding-request.v1",
            worker: startedWorker
          }))
        ).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            operation: "agent-binding.goal-authority-conflict"
          }
        })
        expect(Option.isNone(yield* service.agentBinding(dispatchRequestId))).toBe(true)
        expect(Option.getOrThrow(yield* service.currentClaim(lane.laneId))).toEqual(lane)
      }).pipe(provideNodeServices)
    ))

  it.effect("rejects decision handoff when corrupted storage has duplicate active goal claims", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "herdr-work-decision-ambiguous-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
        const path = join(directory, "work.sqlite")
        const opened = yield* openScopedStore(path)
        const service = yield* makeWorkService(opened.store)
        const lane = yield* service.claim(laneClaim("lane:decision-authority", "goal:decision-authority"))
        const duplicate = Schema.decodeUnknownSync(WorkLaneClaimed)({
          ...laneClaim("lane:duplicate-decision-authority", lane.goalId),
          revision: 1
        })
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

        const handoff: WorkDecisionHandoff = {
          blockers: [],
          contextDelta: "Must have one active lane authority",
          decision: "handoff",
          dispatchIds: ["dispatch:ambiguous-decision"],
          evidenceRefs: [],
          expectedRevision: lane.revision,
          goalId: lane.goalId,
          id: "handoff:ambiguous-decision",
          laneId: lane.laneId,
          occurredAt: 1,
          owner: lane.owner,
          sessionId: "session:ambiguous-decision",
          summary: "Must have one active lane authority",
          version: "herdr.work.decision.v2"
        }
        expect(yield* Effect.result(service.handoff(handoff))).toMatchObject({
          failure: {
            _tag: "WorkDecisionAuthorityConflictError",
            goalId: lane.goalId,
            laneId: lane.laneId
          }
        })
        expect(yield* service.decisions(lane.laneId)).toEqual([])
        expect(Option.isNone(yield* service.coordinatorHandoff(handoff.sessionId))).toBe(true)
      }).pipe(provideNodeServices)
    ))

  for (
    const tamper of [
      {
        name: "missing lane-operation companion",
        mutate: (database: DatabaseSync, dispatchRequestId: string) =>
          database.prepare("DELETE FROM work_lane_operations WHERE operation_id = ?").run(dispatchRequestId)
      },
      {
        name: "mutated checkpoint companion",
        mutate: (database: DatabaseSync, dispatchRequestId: string) =>
          database.prepare("UPDATE work_goal_events SET record = '{}' WHERE event_id = ?").run(dispatchRequestId)
      }
    ]
  ) {
    it.effect(`rejects agent-binding replay with a ${tamper.name}`, () =>
      Effect.scoped(
        Effect.gen(function*() {
          const directory = mkdtempSync(join(tmpdir(), "herdr-work-agent-binding-readback-"))
          yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
          const path = join(directory, "work.sqlite")
          const first = yield* openScopedStore(path)
          const service = yield* makeWorkService(first.store)
          yield* service.record(history[0])
          const lane = yield* service.claim(laneClaim("lane:readback", history[0].goal.id))
          yield* TestClock.setTime(1)
          const request = Schema.decodeUnknownSync(WorkAgentBindingRequest)({
            dispatchRequestId: `dispatch:${tamper.name}`,
            expectedRevision: lane.revision,
            laneId: lane.laneId,
            version: "herdr.work.agent-binding-request.v1",
            worker: startedWorker
          })
          yield* service.bindAgent(request)
          first.close()

          const database = new DatabaseSync(path)
          tamper.mutate(database, request.dispatchRequestId)
          database.close()

          const reopened = yield* openScopedStore(path)
          const restarted = yield* makeWorkService(reopened.store)
          expect(yield* Effect.result(restarted.bindAgent(request))).toMatchObject({
            failure: { _tag: "WorkStoreError" }
          })
          expect(yield* Effect.result(restarted.agentBinding(request.dispatchRequestId))).toMatchObject({
            failure: { _tag: "WorkStoreError" }
          })
        }).pipe(provideNodeServices)
      ))
  }

  it.effect("rejects agent binding when a historical checkpoint record disagrees with its row identity", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "herdr-work-agent-binding-history-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
        const path = join(directory, "work.sqlite")
        const first = yield* openScopedStore(path)
        const service = yield* makeWorkService(first.store)
        yield* service.record(history[0])
        const lane = yield* service.claim(laneClaim("lane:history-identity", history[0].goal.id))
        first.close()
        const request = Schema.decodeUnknownSync(WorkAgentBindingRequest)({
          dispatchRequestId: "dispatch:history-identity",
          expectedRevision: lane.revision,
          laneId: lane.laneId,
          version: "herdr.work.agent-binding-request.v1",
          worker: startedWorker
        })
        const database = new DatabaseSync(path)
        database.prepare("UPDATE work_goal_events SET record = ? WHERE event_id = ?").run(
          JSON.stringify({ ...history[0], eventId: request.dispatchRequestId }),
          history[0].eventId
        )
        database.close()
        const reopened = yield* openScopedStore(path)
        const restarted = yield* makeWorkService(reopened.store)
        expect(yield* Effect.result(restarted.bindAgent(request))).toMatchObject({
          failure: { _tag: "WorkStoreError" }
        })
        expect(Option.isNone(yield* restarted.agentBinding(request.dispatchRequestId))).toBe(true)
      }).pipe(provideNodeServices)
    ))

  it("binds dispatch lineage to the persisted coordinator handoff", () => {
    const binding = {
      dispatchRequestId: "dispatch:sol",
      handoff: {
        blockers: [],
        contextDelta: "Escalate failed work",
        decision: "handoff",
        dispatchIds: ["dispatch:luna"],
        evidenceRefs: [],
        expectedRevision: 1,
        goalId: "goal:package",
        id: "handoff:package",
        laneId: "lane:package",
        occurredAt: 1,
        owner: { id: "owner:package", name: "Package owner" },
        sessionId: "session:package",
        summary: "Escalate failed work",
        version: "herdr.work.decision.v2"
      },
      lineage: ["dispatch:luna"]
    }
    expect(Schema.decodeUnknownResult(WorkDispatchHandoff)(binding)._tag).toBe("Success")
    expect(
      Schema.decodeUnknownResult(WorkDispatchHandoff)({ ...binding, lineage: ["dispatch:other"] })._tag
    ).toBe("Failure")
  })

  it.effect("does not mutate a caller-owned state directory", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-work-mode-test-"))
    const stateDirectory = join(root, "state")
    mkdirSync(stateDirectory, { mode: 0o755 })
    return Effect.acquireUseRelease(
      WorkStore.open(join(stateDirectory, "work.sqlite")),
      () =>
        Effect.sync(() => {
          if (platform() !== "win32") expect(statSync(stateDirectory).mode & 0o777).toBe(0o755)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("rejects writable and substituted authority paths before database creation", () =>
    Effect.scoped(
      Effect.gen(function*() {
        if (platform() === "win32") return
        const root = mkdtempSync(join(tmpdir(), "herdr-work-unsafe-path-test-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))

        for (const mode of [0o775, 0o777]) {
          const stateDirectory = join(root, mode.toString(8))
          mkdirSync(stateDirectory)
          chmodSync(stateDirectory, mode)
          const database = join(stateDirectory, "work.sqlite")
          const result = yield* safelyOpenResult(database)
          expect(result).toMatchObject({
            failure: { _tag: "WorkStoreError", operation: "open.directory.unsafe" }
          })
          expect(existsSync(database)).toBe(false)
          expect(statSync(stateDirectory).mode & 0o777).toBe(mode)
        }

        const realDirectory = join(root, "real")
        mkdirSync(realDirectory, { mode: 0o700 })
        const linkedDirectory = join(root, "linked")
        symlinkSync(realDirectory, linkedDirectory)
        const linkedResult = yield* safelyOpenResult(join(linkedDirectory, "work.sqlite"))
        expect(linkedResult).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "open.directory.path-identity" }
        })
        expect(existsSync(join(realDirectory, "work.sqlite"))).toBe(false)

        const safeDirectory = join(root, "safe")
        mkdirSync(safeDirectory, { mode: 0o700 })
        const danglingTarget = join(safeDirectory, "missing-target")
        const database = join(safeDirectory, "work.sqlite")
        symlinkSync(danglingTarget, database)
        const databaseResult = yield* safelyOpenResult(database)
        expect(databaseResult).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "open.path-identity" }
        })
        expect(existsSync(danglingTarget)).toBe(false)
      }).pipe(provideNodeServices)
    ))

  it.effect("rejects an unsafe existing database before schema migration", () =>
    Effect.scoped(
      Effect.gen(function*() {
        if (platform() === "win32") return
        const root = mkdtempSync(join(tmpdir(), "herdr-work-unsafe-database-test-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
        chmodSync(root, 0o700)
        const unsafePath = join(root, "unsafe.sqlite")
        const unsafe = new DatabaseSync(unsafePath)
        unsafe.exec("CREATE TABLE preserved (id TEXT PRIMARY KEY)")
        unsafe.close()
        chmodSync(unsafePath, 0o660)

        expect(yield* safelyOpenResult(unsafePath)).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "open.file.unsafe" }
        })
        expect(statSync(unsafePath).mode & 0o777).toBe(0o660)
        const unchanged = new DatabaseSync(unsafePath, { readOnly: true })
        expect(unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get())
          .toEqual({ count: 1 })
        unchanged.close()

        const safePath = join(root, "safe.sqlite")
        const safe = new DatabaseSync(safePath)
        safe.close()
        chmodSync(safePath, 0o600)
        const opened = yield* openScopedStore(safePath)
        expect(statSync(safePath).mode & 0o777).toBe(0o600)
        opened.close()
      }).pipe(provideNodeServices)
    ))

  it.effect("derives now, day, week, and month from recorded timestamps", () =>
    Effect.gen(function*() {
      const snapshots = yield* projectWorkSnapshots(history, 31 * day)
      expect(snapshots.now.goals[0]?.state).toBe("review")
      expect(snapshots.day.goals[0]?.state).toBe("review")
      expect(snapshots.week.goals[0]?.state).toBe("working")
      expect(snapshots.month.goals[0]?.state).toBe("planned")
      expect(snapshots.now.goals[0]?.connectTarget?.url).toBe(
        "/connect/?agent=agent-package-owner&host=SER8"
      )
    }))

  it.effect("keeps goals absent before their durable creation checkpoint", () =>
    Effect.gen(function*() {
      const later = {
        ...checkpoint("event-later", 20 * day, "planned", "local"),
        goal: { ...goal(20 * day, "planned", "local"), createdAt: 20 * day, id: "goal-later" }
      }
      const snapshots = yield* projectWorkSnapshots([...history, later], 31 * day)
      expect(snapshots.week.goals.map(({ id }) => id)).toContain("goal-later")
      expect(snapshots.month.goals.map(({ id }) => id)).not.toContain("goal-later")
    }))

  it.effect("projects only the canonical goal after durable supersession", () =>
    Effect.gen(function*() {
      const original = checkpointForGoal("goal-connect-original", "original-created", 0, 0)
      const versionTwo: WorkGoalCheckpointType = {
        ...checkpointForGoal("goal-connect-v2", "v2-created", 0, 0),
        goal: {
          ...checkpointForGoal("goal-connect-v2", "v2-created", 0, 0).goal,
          blocker: { since: 0, summary: "Audit gate failed" },
          state: "blocked"
        }
      }

      const versionThree = checkpointForGoal("goal-connect-v3", "v3-created", 0, 0)
      const relationAt = 2 * day
      const canonical = familyCheckpoint(
        versionThree,
        "v3-canonical",
        relationAt,
        "goal-connect-v3",
        "canonical"
      )
      const supersededV2 = familyCheckpoint(
        versionTwo,
        "v2-superseded",
        relationAt,
        "goal-connect-v3",
        "superseded"
      )
      const supersededOriginal = familyCheckpoint(
        original,
        "original-superseded",
        relationAt,
        "goal-connect-v3",
        "superseded"
      )

      const snapshots = yield* projectWorkSnapshots(
        [original, versionTwo, versionThree, supersededV2, supersededOriginal, canonical],
        relationAt + 1
      )
      expect(snapshots.now.goals.map(({ id }) => id)).toEqual(["goal-connect-v3"])
      expect(snapshots.day.goals.map(({ id }) => id).toSorted()).toEqual([
        "goal-connect-original",
        "goal-connect-v2",
        "goal-connect-v3"
      ])
      expect(snapshots.day.goals.find(({ id }) => id === "goal-connect-v2")).toMatchObject({
        blocker: { since: 0, summary: "Audit gate failed" },
        state: "blocked"
      })
    }))

  it.effect("rejects dangling, changed, and removed goal-family relations", () =>
    Effect.gen(function*() {
      const dangling = familyCheckpoint(
        checkpointForGoal("goal-v2", "v2-created", 0, 0),
        "v2-superseded",
        0,
        "goal-v3",
        "superseded"
      )
      expect(yield* Effect.result(projectWorkSnapshots([dangling], 0))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "inconsistent_history" }
      })

      const canonical = familyCheckpoint(
        checkpointForGoal("goal-v3", "v3-created", 0, 0),
        "v3-canonical",
        0,
        "goal-v3",
        "canonical"
      )
      const removed = {
        ...checkpointForGoal("goal-v3", "v3-removed", 1, 0),
        goal: { ...checkpointForGoal("goal-v3", "v3-removed", 1, 0).goal }
      }
      expect(yield* Effect.result(projectWorkSnapshots([canonical, removed], 1))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "inconsistent_history" }
      })

      const retargeted = familyCheckpoint(
        removed,
        "v3-retargeted",
        1,
        "goal-v4",
        "superseded"
      )
      expect(yield* Effect.result(projectWorkSnapshots([canonical, retargeted], 1))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "inconsistent_history" }
      })
    }))

  it.effect("rejects invalid goal-family checkpoints before committing them", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-family-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const versionTwo = checkpointForGoal("goal-v2", "v2-created", 0, 0)
      const versionThree = checkpointForGoal("goal-v3", "v3-created", 0, 0)
      yield* store.append(versionTwo)
      yield* store.append(versionThree)

      const superseded = familyCheckpoint(versionTwo, "v2-superseded", 1, "goal-v3", "superseded")
      expect(yield* Effect.result(store.append(superseded))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "inconsistent_history" }
      })
      expect(yield* store.list()).toEqual([versionTwo, versionThree])

      const canonical = familyCheckpoint(versionThree, "v3-canonical", 1, "goal-v3", "canonical")
      yield* store.append(canonical)
      yield* store.append(superseded)
      expect(yield* store.list()).toEqual([versionTwo, versionThree, superseded, canonical])
    }).pipe(provideNodeServices))

  it.effect("rejects malformed and ambiguous durable history", () =>
    Effect.gen(function*() {
      const malformed = yield* Effect.result(
        Schema.decodeUnknownEffect(WorkGoalCheckpoint)({ ...history[0], occurredAt: 1 })
      )
      expect(malformed._tag).toBe("Failure")
      const ambiguous = yield* Effect.result(
        projectWorkSnapshots(
          [...history, { ...history[1], eventId: "event-working-again" }],
          31 * day
        )
      )
      expect(ambiguous).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "ambiguous_checkpoint" }
      })
    }))

  it.effect("survives store close and reopen without changing exact targets", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const first = yield* openScopedStore(path)
      for (const event of history) yield* first.store.append(event)
      first.close()
      const reopened = yield* openScopedStore(path)
      expect(yield* reopened.store.list()).toEqual(history)
    }).pipe(provideNodeServices))

  it.effect("replays an identical checkpoint without duplicating the durable event", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-conflict-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      yield* store.append(history[0])
      expect(yield* store.append(history[0])).toEqual(history[0])
      expect(yield* store.list()).toEqual([history[0]])
    }).pipe(provideNodeServices))

  it.effect("rejects replay collisions with changed checkpoint content", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-conflict-content-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      yield* store.append(history[0])

      const changed = {
        ...history[0],
        goal: { ...history[0].goal, summary: "Changed checkpoint content" }
      }
      const sameEvent = yield* Effect.result(store.append(changed))
      expect(sameEvent).toMatchObject({
        failure: { _tag: "WorkCheckpointConflictError", eventId: history[0].eventId }
      })
      const differentEvent = yield* Effect.result(
        store.append({ ...changed, eventId: "event-created-replayed" })
      )
      expect(differentEvent).toMatchObject({
        failure: { _tag: "WorkCheckpointConflictError", eventId: "event-created-replayed" }
      })
      expect(yield* store.list()).toEqual([history[0]])
    }).pipe(provideNodeServices))

  it.effect("atomically replays checkpoint batches and rejects transaction conflicts", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-transaction-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      for (const transactionId of ["transaction-\uD800", "transaction-\uDC00"]) {
        expect(yield* Effect.result(service.recordMany(transactionId, [history[0]]))).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "appendMany.decode.transaction" }
        })
      }
      expect(yield* service.recordMany("transaction-1", history.slice(0, 2))).toEqual(history.slice(0, 2))
      expect(yield* service.recordMany("transaction-1", history.slice(0, 2))).toEqual(history.slice(0, 2))
      const changed = { ...history[1], goal: { ...history[1].goal, summary: "changed transaction" } }
      expect(yield* service.recordMany("transaction-replay-only", history.slice(0, 2))).toEqual(history.slice(0, 2))
      expect(yield* Effect.result(service.recordMany("transaction-replay-only", [history[2]]))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-replay-only" }
      })
      expect(yield* Effect.result(service.recordMany("transaction-replay-only", history.slice(0, 3)))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-replay-only" }
      })
      expect(yield* Effect.result(service.recordMany("transaction-replay-only", [history[0], changed]))).toMatchObject({
        failure: { _tag: "WorkCheckpointConflictError" }
      })
      expect(yield* Effect.result(service.recordMany("transaction-replay-only", [history[0]]))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-replay-only" }
      })
      expect(yield* Effect.result(service.recordMany("transaction-1", [history[0], changed]))).toMatchObject({
        failure: { _tag: "WorkCheckpointConflictError" }
      })
      expect(yield* store.list()).toEqual(history.slice(0, 2))
    }).pipe(provideNodeServices))

  it.effect("revalidates legacy transaction rows against durable checkpoints", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-legacy-transaction-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const store = yield* openScopedStore(path)
      store.close()

      const legacyEvents = history.slice(0, 2)
      const database = new DatabaseSync(path)
      database.prepare(
        "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
      ).run("transaction-legacy", JSON.stringify(legacyEvents))
      database.close()

      const missingStore = yield* openScopedStore(path)
      const missingService = yield* makeWorkService(missingStore.store)
      expect(yield* Effect.result(missingService.recordMany("transaction-legacy", legacyEvents))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-legacy" }
      })
      expect(yield* missingStore.store.list()).toEqual([])
      missingStore.close()

      const repaired = new DatabaseSync(path)
      const insert = repaired.prepare(
        `INSERT INTO work_goal_events
           (event_id, goal_id, occurred_at, record, transaction_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (const event of legacyEvents) {
        insert.run(event.eventId, event.goal.id, event.occurredAt, JSON.stringify(event), "transaction-legacy")
      }
      repaired.close()

      const driftedEvent = legacyEvents[1]
      if (driftedEvent === undefined) return yield* Effect.die("legacy fixture missing its second event")
      const corrupted = new DatabaseSync(path)
      corrupted.prepare(
        "UPDATE work_goal_events SET goal_id = ?, occurred_at = ? WHERE event_id = ?"
      ).run("goal-denormalized-drift", 99, driftedEvent.eventId)
      corrupted.close()

      const corruptedStore = yield* openScopedStore(path)
      const corruptedService = yield* makeWorkService(corruptedStore.store)
      expect(yield* Effect.result(corruptedService.recordMany("transaction-legacy", legacyEvents))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-legacy" }
      })
      corruptedStore.close()

      const restored = new DatabaseSync(path)
      restored.prepare(
        "UPDATE work_goal_events SET goal_id = ?, occurred_at = ? WHERE event_id = ?"
      ).run(driftedEvent.goal.id, driftedEvent.occurredAt, driftedEvent.eventId)
      restored.close()

      const completeStore = yield* openScopedStore(path)
      const completeService = yield* makeWorkService(completeStore.store)
      expect(yield* completeService.recordMany("transaction-legacy", legacyEvents)).toEqual(legacyEvents)
      const changed = { ...legacyEvents[1], goal: { ...legacyEvents[1].goal, summary: "changed legacy" } }
      expect(yield* Effect.result(completeService.recordMany("transaction-legacy", [legacyEvents[0], changed])))
        .toMatchObject(
          { failure: { _tag: "WorkCheckpointConflictError" } }
        )
      const unrelated = checkpointForGoal("goal-legacy-unrelated", "event-legacy-unrelated", 0, 0)
      expect(yield* Effect.result(completeService.recordMany("transaction-legacy", [unrelated]))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-legacy" }
      })
      expect(yield* completeStore.store.list()).toEqual(legacyEvents)
      completeStore.close()
    }).pipe(provideNodeServices))

  it.effect("fails closed on legacy compact transaction denormalized identities", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-legacy-compact-transaction-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const initial = yield* openScopedStore(path)
      initial.close()

      const legacyEvents = history.slice(0, 2)
      const secondEvent = legacyEvents[1]
      if (secondEvent === undefined) return yield* Effect.die("legacy fixture missing its second event")
      const database = new DatabaseSync(path)
      const insertEvent = database.prepare(
        `INSERT INTO work_goal_events
           (event_id, goal_id, occurred_at, record, transaction_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (const event of legacyEvents) {
        insertEvent.run(
          event.eventId,
          event.goal.id,
          event.occurredAt,
          JSON.stringify(event),
          "transaction-legacy-compact"
        )
      }
      database.prepare(
        "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
      ).run(
        "transaction-legacy-compact",
        JSON.stringify({
          events: legacyEvents.map(({ eventId, goal, occurredAt }) => ({ eventId, goalId: goal.id, occurredAt })),
          version: "herdr.work.transaction.v1"
        })
      )
      database.prepare(
        "UPDATE work_goal_events SET goal_id = ?, occurred_at = ? WHERE event_id = ?"
      ).run("goal-denormalized-drift", 99, secondEvent.eventId)
      database.close()

      const corrupted = yield* openScopedStore(path)
      const corruptedService = yield* makeWorkService(corrupted.store)
      expect(yield* Effect.result(corruptedService.recordMany("transaction-legacy-compact", legacyEvents)))
        .toMatchObject({
          failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-legacy-compact" }
        })
      corrupted.close()

      const restored = new DatabaseSync(path)
      restored.prepare(
        "UPDATE work_goal_events SET goal_id = ?, occurred_at = ? WHERE event_id = ?"
      ).run(secondEvent.goal.id, secondEvent.occurredAt, secondEvent.eventId)
      restored.close()

      const complete = yield* openScopedStore(path)
      const completeService = yield* makeWorkService(complete.store)
      expect(yield* Effect.result(completeService.recordMany("transaction-legacy-compact", legacyEvents)))
        .toMatchObject({
          failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-legacy-compact" }
        })
      complete.close()
    }).pipe(provideNodeServices))

  it.effect("revalidates compact transaction denormalized identities", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-compact-transaction-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const events = history.slice(0, 2)
      const secondEvent = events[1]
      if (secondEvent === undefined) return yield* Effect.die("compact transaction fixture missing its second event")
      const opened = yield* openScopedStore(path)
      const service = yield* makeWorkService(opened.store)
      expect(yield* service.recordMany("transaction-compact", events)).toEqual(events)

      const changedEventId = { ...secondEvent, eventId: "event-compact-existing-goal-time" }
      const collisionReplay = yield* Effect.result(
        service.recordMany("transaction-compact", [events[0], changedEventId])
      )
      expect(collisionReplay).toMatchObject({ failure: { _tag: "WorkCheckpointConflictError" } })
      opened.close()

      const recordDrift = new DatabaseSync(path)
      const changedRecord = {
        ...secondEvent,
        goal: { ...secondEvent.goal, summary: "Changed persisted checkpoint content" }
      }
      recordDrift.prepare(
        "UPDATE work_goal_events SET record = ? WHERE event_id = ?"
      ).run(JSON.stringify(changedRecord), secondEvent.eventId)
      recordDrift.close()

      const recordDriftStore = yield* openScopedStore(path)
      const recordDriftService = yield* makeWorkService(recordDriftStore.store)
      expect(yield* Effect.result(recordDriftService.recordMany("transaction-compact", [events[0], changedRecord])))
        .toMatchObject({
          failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-compact" }
        })
      recordDriftStore.close()

      const recordRestored = new DatabaseSync(path)
      recordRestored.prepare(
        "UPDATE work_goal_events SET record = ? WHERE event_id = ?"
      ).run(JSON.stringify(secondEvent), secondEvent.eventId)
      recordRestored.close()

      const database = new DatabaseSync(path)
      database.prepare(
        "UPDATE work_goal_events SET goal_id = ?, occurred_at = ? WHERE event_id = ?"
      ).run("goal-denormalized-drift", 99, secondEvent.eventId)
      database.close()

      const corrupted = yield* openScopedStore(path)
      const corruptedService = yield* makeWorkService(corrupted.store)
      expect(yield* Effect.result(corruptedService.recordMany("transaction-compact", events))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-compact" }
      })
      corrupted.close()

      const restored = new DatabaseSync(path)
      restored.prepare(
        "UPDATE work_goal_events SET goal_id = ?, occurred_at = ? WHERE event_id = ?"
      ).run(secondEvent.goal.id, secondEvent.occurredAt, secondEvent.eventId)
      restored.close()

      const complete = yield* openScopedStore(path)
      const completeService = yield* makeWorkService(complete.store)
      expect(yield* completeService.recordMany("transaction-compact", events)).toEqual(events)

      complete.close()
      const aliasDatabase = new DatabaseSync(path)
      aliasDatabase.prepare(
        "UPDATE work_goal_events SET goal_id = ? WHERE event_id = ?"
      ).run("goal-denormalized-drift", secondEvent.eventId)
      aliasDatabase.close()

      const aliasCorrupted = yield* openScopedStore(path)
      const aliasCorruptedService = yield* makeWorkService(aliasCorrupted.store)
      expect(yield* Effect.result(aliasCorruptedService.recordMany("transaction-compact-alias", events))).toMatchObject(
        {
          failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-compact-alias" }
        }
      )
      aliasCorrupted.close()
      const aliasLedger = new DatabaseSync(path)
      expect(
        aliasLedger.prepare(
          "SELECT record FROM work_goal_transactions WHERE transaction_id = ?"
        ).get("transaction-compact-alias")
      ).toBeUndefined()
      aliasLedger.close()

      const aliasRestored = new DatabaseSync(path)
      aliasRestored.prepare(
        "UPDATE work_goal_events SET goal_id = ? WHERE event_id = ?"
      ).run(secondEvent.goal.id, secondEvent.eventId)
      aliasRestored.close()

      const eventIdDatabase = new DatabaseSync(path)
      eventIdDatabase.prepare(
        "UPDATE work_goal_events SET event_id = ? WHERE event_id = ?"
      ).run("event-denormalized-drift", secondEvent.eventId)
      eventIdDatabase.close()

      const eventIdDrift = yield* openScopedStore(path)
      const eventIdDriftService = yield* makeWorkService(eventIdDrift.store)
      expect(yield* Effect.result(eventIdDriftService.recordMany("transaction-compact", events))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-compact" }
      })
      eventIdDrift.close()

      const eventIdRestored = new DatabaseSync(path)
      eventIdRestored.prepare(
        "UPDATE work_goal_events SET event_id = ? WHERE event_id = ?"
      ).run(secondEvent.eventId, "event-denormalized-drift")
      eventIdRestored.close()
    }).pipe(provideNodeServices))

  it.effect("configures a bounded SQLite writer lock wait", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-busy-timeout-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const store = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      const lockHolder = spawn(
        execPath,
        [
          "--input-type=module",
          "-e",
          `import { DatabaseSync } from "node:sqlite"
const database = new DatabaseSync(process.argv[1])
database.exec("BEGIN IMMEDIATE")
process.stdout.write("locked\\n")
await new Promise((resolve) => setTimeout(resolve, 250))
database.exec("COMMIT")
database.close()`,
          path
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => lockHolder.kill()))
      yield* Effect.callback<void, LockHolderError>((resume) => {
        let ready = false
        lockHolder.stdout.setEncoding("utf8")
        lockHolder.stdout.on("data", (chunk: string) => {
          if (!ready && chunk.includes("locked")) {
            ready = true
            resume(Effect.undefined)
          }
        })
        lockHolder.on("error", (cause) => resume(Effect.fail(new LockHolderError({ cause: String(cause) }))))
        lockHolder.on("close", (code) => {
          if (!ready) {
            resume(Effect.fail(
              new LockHolderError({
                cause: `lock holder exited before acquiring the lock: ${String(code)}`
              })
            ))
          }
        })
      })
      expect(
        yield* Effect.result(service.claim({
          branch: "feat/busy-timeout",
          expectedRevision: 0,
          goalId: "goal-busy-timeout",
          head: "0123456789012345678901234567890123456789",
          laneId: "goal-busy-timeout",
          operationId: "operation-busy-timeout",
          owner: { id: "owner-packages", name: "Package owner" },
          parent: null,
          phase: "implementation",
          worktree: "/home/konopkov/Work/dev/knpkv.dev/worktrees/npm/feat-busy-timeout"
        }))
      ).toMatchObject({ _tag: "Success" })
    }).pipe(provideNodeServices))

  it.effect("rejects a transaction extension after an exact replay prefix", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-transaction-prefix-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)

      expect(yield* service.recordMany("transaction-prefix", [history[0]])).toEqual([history[0]])
      expect(
        yield* Effect.result(service.recordMany("transaction-prefix", history.slice(0, 2)))
      ).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-prefix" }
      })
      expect(yield* store.list()).toEqual([history[0]])
    }).pipe(provideNodeServices))

  it.effect("keeps maximum same-goal batches within the snapshot budget", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-snapshot-batch-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      const events = Array.from(
        { length: workHistoryMaxEvents },
        (_, index) => checkpointForGoal("goal-linear", `event-linear-${index}`, index, 0)
      )

      expect(yield* service.recordMany("transaction-linear-snapshot", events)).toEqual(events)
      expect(yield* service.recordMany("transaction-linear-replay", events)).toEqual(events)
      expect(yield* store.list()).toHaveLength(workHistoryMaxEvents)
    }).pipe(provideNodeServices), 30_000)

  it.effect("rejects oversized batches before reading their elements", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-oversized-batch-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      let elementRead = false
      const oversized = Array.from({ length: workHistoryMaxEvents + 1 }, () => history[0])
      Object.defineProperty(oversized, 0, {
        configurable: true,
        get: () => {
          elementRead = true
          return history[0]
        }
      })
      expect(yield* Effect.result(service.recordMany("transaction-oversized", oversized))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
      })
      expect(elementRead).toBe(false)
      expect(yield* store.list()).toEqual([])
      expect(yield* service.recordMany("transaction-small", [history[0]])).toEqual([history[0]])
      expect(yield* store.list()).toEqual([history[0]])
    }).pipe(provideNodeServices))

  it.effect("rejects appendMany when family projection exceeds the snapshot budget", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-family-batch-budget-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      const large = (goalId: string, eventId: string, occurredAt: number): WorkGoalCheckpointType => {
        const base = maximumTextCheckpoint(0)
        return {
          ...base,
          eventId,
          goal: { ...base.goal, createdAt: 0, id: goalId, updatedAt: occurredAt },
          occurredAt
        }
      }
      const canonicalId = "goal-family-batch-canonical"
      const supersededId = "goal-family-batch-superseded"
      const unrelated = Array.from({ length: 12 }, (_, index) =>
        large(`goal-family-batch-${index}`, `event-family-batch-${index}`, 0))
      const canonicalBase = large(canonicalId, "event-family-batch-canonical-base", 0)
      const supersededBase = large(supersededId, "event-family-batch-superseded-base", 0)
      const canonical = familyCheckpoint(
        canonicalBase,
        "event-family-batch-canonical",
        1,
        canonicalId,
        "canonical"
      )
      const superseded = familyCheckpoint(
        supersededBase,
        "event-family-batch-superseded",
        1,
        canonicalId,
        "superseded"
      )
      const events = [...unrelated, canonicalBase, supersededBase, canonical, superseded]
      const projected = yield* projectWorkSnapshots(events, 2)
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeGreaterThan(fleetResponseBodyMaxBytes)
      expect(yield* Effect.result(service.recordMany("transaction-family-batch-budget", events))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
      })
      expect(yield* store.list()).toEqual([])
    }).pipe(provideNodeServices), 30_000)

  it.effect("bounds replay transaction storage separately from transaction row count", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-transaction-bytes-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const event = checkpoint("event-byte-cap", 0, "working", "local")
      yield* Effect.acquireUseRelease(
        WorkStore.open(path),
        (store) =>
          Effect.gen(function*() {
            const service = yield* makeWorkService(store)
            yield* service.record(event)
          }),
        (store) => Effect.sync(() => store.close())
      )

      const database = new DatabaseSync(path)
      database.exec("BEGIN IMMEDIATE")
      const insert = database.prepare(
        "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
      )
      const record = JSON.stringify({ digest: "a".repeat(64), version: "herdr.work.transaction.v2" })
      for (let index = 0; index < 16_383; index++) {
        insert.run(`seed-${String(index).padStart(5, "0")}-${"x".repeat(240)}`, record)
      }
      database.exec("COMMIT")
      database.close()

      const reopened = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => reopened.close()))
      expect(yield* Effect.result(reopened.appendMany("transaction-byte-cap", [event]))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
      })
      expect(yield* reopened.list()).toEqual([event])
    }).pipe(provideNodeServices))

  it.effect("maintains replay ledger totals transactionally without rescanning", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-transaction-ledger-totals-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      const first = history.slice(0, 2)
      yield* service.recordMany("transaction-ledger-1", first)

      const database = new DatabaseSync(store.path)
      const totalsAfterInsert = database.prepare(
        `SELECT transaction_count AS transactionCount, transaction_bytes AS transactionBytes
         FROM work_goal_transaction_totals WHERE singleton = 1`
      ).get()
      database.close()
      expect(totalsAfterInsert).toEqual({
        transactionCount: 1,
        transactionBytes: "transaction-ledger-1".length + JSON.stringify({
          digest: "a".repeat(64),
          version: "herdr.work.transaction.v2"
        }).length
      })

      yield* service.recordMany("transaction-ledger-1", first)
      const databaseAfterReplay = new DatabaseSync(store.path)
      const totalsAfterReplay = databaseAfterReplay.prepare(
        `SELECT transaction_count AS transactionCount, transaction_bytes AS transactionBytes
         FROM work_goal_transaction_totals WHERE singleton = 1`
      ).get()
      const ledgerRows = databaseAfterReplay.prepare(
        "SELECT COUNT(*) AS count FROM work_goal_transactions"
      ).get()
      databaseAfterReplay.close()
      expect(totalsAfterReplay).toEqual(totalsAfterInsert)
      expect(ledgerRows).toEqual({ count: 1 })
    }).pipe(provideNodeServices))

  it.effect("bounds durable decision handoffs by encoded bytes", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-decision-bytes-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const store = yield* openScopedStore(path)
      const initialService = yield* makeWorkService(store.store)
      yield* initialService.claim(laneClaim("goal-decision-cap"))
      store.close()

      const handoff: WorkDecisionHandoff = {
        blockers: [],
        contextDelta: "Decision ledger capacity fixture",
        decision: "handoff",
        dispatchIds: [],
        evidenceRefs: [],
        expectedRevision: 1,
        goalId: "goal-decision-cap",
        id: "handoff-overflow",
        laneId: "goal-decision-cap",
        occurredAt: 0,
        owner: { id: "owner-packages", name: "Package owner" },
        sessionId: "session-overflow",
        summary: "x".repeat(4_096),
        version: "herdr.work.decision.v2"
      }
      const database = new DatabaseSync(path)
      database.exec("BEGIN IMMEDIATE")
      const insert = database.prepare(
        `INSERT INTO work_decision_handoffs
           (handoff_id, session_id, lane_id, occurred_at, record)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (let index = 0; index < 500; index++) {
        const seeded = {
          ...handoff,
          id: `handoff-seed-${index}`,
          occurredAt: index,
          sessionId: `session-seed-${index}`
        }
        insert.run(seeded.id, seeded.sessionId, seeded.laneId, seeded.occurredAt, JSON.stringify(seeded))
      }
      database.exec("COMMIT")
      database.close()

      const reopened = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => reopened.close()))
      const service = yield* makeWorkService(reopened)
      expect(yield* Effect.result(service.handoff(handoff))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
      })
      expect(yield* service.decisions(handoff.laneId)).toHaveLength(500)
    }).pipe(provideNodeServices))

  it.effect("validates decision lookup identifiers before SQLite binding", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-decision-identity-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      const handoff: WorkDecisionHandoff = {
        blockers: [],
        contextDelta: "Replacement character remains a valid distinct lane",
        decision: "handoff",
        dispatchIds: [],
        evidenceRefs: [],
        expectedRevision: 1,
        goalId: "lane-\uFFFD",
        id: "handoff-replacement-lane",
        laneId: "lane-\uFFFD",
        occurredAt: 0,
        owner: { id: "owner-packages", name: "Package owner" },
        sessionId: "session-replacement-lane",
        summary: "Replacement character remains a valid distinct lane",
        version: "herdr.work.decision.v2"
      }
      yield* service.claim(laneClaim(handoff.laneId, handoff.goalId))
      yield* service.handoff(handoff)
      for (const malformedLaneId of ["lane-\uD800", "lane-\uDC00"]) {
        expect(yield* Effect.result(service.decisions(malformedLaneId))).toMatchObject({
          failure: { _tag: "WorkStoreError", operation: "decisions.list.decode-lane-id" }
        })
      }
      expect(yield* service.decisions("lane-\uFFFD")).toEqual([handoff])
      expect(yield* service.decisions("lane-normal")).toEqual([])
    }).pipe(provideNodeServices))

  it.effect("compare-and-set claims and retains compact decision handoffs", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-lane-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)
      const claim: WorkLaneClaim = {
        branch: "feat/durable-work",
        expectedRevision: 0,
        goalId: "goal-packages",
        head: "0123456789012345678901234567890123456789",
        laneId: "goal-packages",
        operationId: "operation-claim-1",
        owner: { id: "owner-packages", name: "Package owner" },
        parent: null,
        phase: "implementation",
        worktree: "/home/konopkov/Work/dev/knpkv.dev/worktrees/npm/feat-durable-work"
      }
      expect(yield* service.claim(claim)).toMatchObject({ revision: 1, head: claim.head })
      const current = yield* service.currentClaim(claim.laneId)
      expect(Option.isSome(current)).toBe(true)
      if (Option.isSome(current)) expect(current.value).toMatchObject({ revision: 1, head: claim.head })
      expect(yield* service.claim(claim)).toMatchObject({ operationId: claim.operationId, revision: 1 })
      expect(yield* Effect.result(service.claim({ ...claim, phase: "review" }))).toMatchObject({
        failure: { _tag: "WorkLaneOperationConflictError", operationId: claim.operationId }
      })
      expect(
        yield* Effect.result(service.claim({
          ...claim,
          operationId: "operation-stale",
          phase: "review"
        }))
      ).toMatchObject({
        failure: { _tag: "WorkLaneClaimConflictError", actualRevision: 1 }
      })
      const next = yield* service.claim({
        ...claim,
        expectedRevision: 1,
        operationId: "operation-claim-2",
        phase: "validation"
      })
      expect(next.revision).toBe(2)
      expect(yield* service.claim(claim)).toMatchObject({ operationId: claim.operationId, revision: 1 })
      expect(
        yield* Effect.result(service.claim({
          ...claim,
          expectedRevision: 2,
          goalId: "goal-other",
          operationId: "operation-move-goal",
          phase: "review"
        }))
      ).toMatchObject({
        failure: { _tag: "WorkLaneGoalConflictError", activeLaneId: claim.laneId, goalId: "goal-other" }
      })
      expect(
        yield* Effect.result(service.claim({
          ...claim,
          goalId: claim.goalId,
          laneId: "lane-competing",
          operationId: "operation-competing"
        }))
      ).toMatchObject({
        failure: {
          _tag: "WorkLaneGoalConflictError",
          activeLaneId: claim.laneId,
          goalId: claim.goalId,
          laneId: "lane-competing"
        }
      })
      const active = yield* service.activeGoalClaim(claim.goalId)
      expect(active).toEqual(Option.some(next))
      const updated = yield* service.currentClaim(claim.laneId)
      expect(Option.isSome(updated)).toBe(true)
      if (Option.isSome(updated)) expect(updated.value).toMatchObject({ revision: 2, phase: "validation" })
      yield* service.claim({
        ...laneClaim("lane-shipped-same-goal", claim.goalId),
        operationId: "operation-shipped-same-goal",
        phase: "shipped"
      })
      const handoff: WorkDecisionHandoff = {
        blockers: [{ id: "review", detail: "Fresh exact-head review required" }],
        contextDelta: "Coordinator owns release verification",
        decision: "handoff",
        dispatchIds: ["dispatch-1", "dispatch-2"],
        evidenceRefs: [{ id: "test", kind: "test", reference: "pnpm --filter @knpkv/herdr-work test" }],
        expectedRevision: next.revision,
        goalId: "goal-packages",
        id: "handoff-1",
        laneId: "goal-packages",
        occurredAt: 1,
        owner: claim.owner,
        sessionId: "session-package-coordinator",
        summary: "Coordinator owns release verification",
        version: "herdr.work.decision.v2"
      }
      expect(yield* service.handoff(handoff)).toEqual(handoff)
      expect(yield* service.handoff(handoff)).toEqual(handoff)
      expect(yield* service.coordinatorHandoff(handoff.sessionId)).toEqual(Option.some(handoff))
      expect(yield* Effect.result(service.handoff({ ...handoff, summary: "Changed" }))).toMatchObject({
        failure: { _tag: "WorkCoordinatorHandoffConflictError", sessionId: handoff.sessionId }
      })
      expect(
        yield* Effect.result(service.handoff({
          ...handoff,
          goalId: "goal-other",
          id: "handoff-wrong-authority",
          sessionId: "session-wrong-authority"
        }))
      ).toMatchObject({
        failure: {
          _tag: "WorkDecisionAuthorityConflictError",
          goalId: "goal-other",
          laneId: handoff.laneId
        }
      })
      expect(yield* service.decisions("goal-packages")).toEqual([handoff])

      const database = new DatabaseSync(store.path)
      const totals = database.prepare(
        `SELECT decision_count AS decisionCount, decision_bytes AS decisionBytes
         FROM work_decision_totals WHERE singleton = 1`
      ).get()
      database.close()
      expect(totals).toEqual({
        decisionCount: 1,
        decisionBytes: utf8ByteLength(handoff.id) + utf8ByteLength(JSON.stringify(handoff))
      })

      const queryPlanDatabase = new DatabaseSync(store.path)
      const queryPlan = queryPlanDatabase.prepare(
        `EXPLAIN QUERY PLAN
         SELECT record FROM work_decision_handoffs
         WHERE lane_id = ?
         ORDER BY occurred_at ASC, handoff_id ASC`
      ).all("goal-packages")
      queryPlanDatabase.close()
      expect(queryPlan.some((row) => String(row.detail).includes("work_decision_handoffs_lane_time"))).toBe(true)

      for (const head of ["a".repeat(41), "a".repeat(63)]) {
        expect(yield* Effect.result(Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, head }))).toMatchObject({
          failure: {}
        })
      }
      for (const worktree of ["/..", "/repo/..", "//repo", "/repo//nested"]) {
        expect(yield* Effect.result(Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree }))).toMatchObject({
          failure: {}
        })
      }
      for (const branch of ["/main", "main/", "foo..bar", "foo.lock", ".hidden", "HEAD"]) {
        expect(yield* Effect.result(Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, branch }))).toMatchObject({
          failure: {}
        })
      }
      for (const branch of ["main", "head", "feat/durable-work"]) {
        expect(yield* Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, branch })).toMatchObject({ branch })
      }
      expect(
        yield* Effect.result(
          Schema.decodeUnknownEffect(WorkLaneClaim)({
            ...claim,
            expectedRevision: Number.MAX_SAFE_INTEGER
          })
        )
      ).toMatchObject({ failure: {} })
      expect(
        yield* Schema.decodeUnknownEffect(WorkLaneClaimed)({
          ...claim,
          expectedRevision: Number.MAX_SAFE_INTEGER - 1,
          revision: Number.MAX_SAFE_INTEGER
        })
      ).toMatchObject({ expectedRevision: Number.MAX_SAFE_INTEGER - 1, revision: Number.MAX_SAFE_INTEGER })
      for (const worktree of ["C:\\repo\\worktree", "C:/repo/worktree"]) {
        expect(yield* Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree })).toMatchObject({ worktree })
      }
      for (const worktree of ["/repo/\uD800", "/repo/\uDC00", "C:\\repo\\\uD800", "C:\\repo\\\uDC00"]) {
        expect(yield* Effect.result(Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree }))).toMatchObject({
          failure: {}
        })
      }
      for (const worktree of ["/repo/\uFFFD", "/repo/CON.txt", "C:\\repo\\content.txt"]) {
        expect(yield* Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree })).toMatchObject({ worktree })
      }
      for (
        const worktree of [
          "C:\\repo\\bad*name",
          "C:\\repo\\bad?name",
          "C:\\repo\\bad.",
          "C:\\repo\\bad "
        ]
      ) {
        expect(yield* Effect.result(Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree }))).toMatchObject({
          failure: {}
        })
      }
      for (const worktree of ["C:\\repo\\CON.txt", "C:\\repo\\nul", "C:\\repo\\Com1.log", "C:\\repo\\LPT9.data"]) {
        expect(yield* Effect.result(Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree }))).toMatchObject({
          failure: {}
        })
      }
      expect(
        yield* Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree: "/repo/bad*name" })
      ).toMatchObject({ worktree: "/repo/bad*name" })
      for (const worktree of ["C:\\repo\\..\\other", "C:/repo/../other"]) {
        expect(yield* Effect.result(Schema.decodeUnknownEffect(WorkLaneClaim)({ ...claim, worktree }))).toMatchObject({
          failure: {}
        })
      }
      const invalidRevisions: ReadonlyArray<readonly [number, number]> = [[3, 3], [3, 5]]
      for (const [expectedRevision, revision] of invalidRevisions) {
        expect(
          yield* Effect.result(
            Schema.decodeUnknownEffect(WorkLaneClaimed)({
              ...claim,
              expectedRevision,
              revision
            })
          )
        ).toMatchObject({ failure: {} })
      }
      expect(
        yield* Schema.decodeUnknownEffect(WorkLaneClaimed)({
          ...claim,
          expectedRevision: 3,
          revision: 4
        })
      ).toMatchObject({ expectedRevision: 3, revision: 4 })
    }).pipe(provideNodeServices))

  it.effect("reads an exact coordinator session handoff after restart", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-coordinator-restart-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const first = yield* openScopedStore(path)
      const handoff: WorkDecisionHandoff = {
        blockers: [{ id: "review", detail: "Fresh exact-head review required" }],
        contextDelta: "Continue from the durable package checkpoint",
        decision: "handoff",
        dispatchIds: ["dispatch-417"],
        evidenceRefs: [{ id: "head", kind: "commit", reference: "a".repeat(40) }],
        expectedRevision: 1,
        goalId: "goal-package",
        id: "handoff-restart",
        laneId: "lane-package",
        occurredAt: 1,
        owner: { id: "owner-packages", name: "Package owner" },
        sessionId: "session-restart",
        summary: "Continue from the durable package checkpoint",
        version: "herdr.work.decision.v2"
      }
      const firstService = yield* makeWorkService(first.store)
      yield* firstService.claim(laneClaim(handoff.laneId, handoff.goalId))
      yield* firstService.handoff(handoff)
      first.close()

      const reopened = yield* openScopedStore(path)
      const service = yield* makeWorkService(reopened.store)
      expect(yield* service.coordinatorHandoff(handoff.sessionId)).toEqual(Option.some(handoff))
      expect(yield* service.handoff(handoff)).toEqual(handoff)
      expect(yield* Effect.result(service.handoff({ ...handoff, blockers: [] }))).toMatchObject({
        failure: { _tag: "WorkCoordinatorHandoffConflictError", sessionId: handoff.sessionId }
      })
    }).pipe(provideNodeServices))

  it.effect("persists bounded handoff context at the accepted lane revision", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-handoff-context-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const first = yield* openScopedStore(path)
      const service = yield* makeWorkService(first.store)
      const lane = yield* service.claim(laneClaim("lane:handoff-context", "goal:handoff-context"))
      const input = {
        blockers: [],
        contextDelta: "Carry the failed Luna evidence into the Sol worker.",
        decision: "handoff",
        dispatchIds: ["dispatch:luna-context"],
        evidenceRefs: [{ id: "luna-failure", kind: "review", reference: "dispatch:luna-context" }],
        expectedRevision: lane.revision,
        goalId: lane.goalId,
        id: "handoff:context",
        laneId: lane.laneId,
        occurredAt: 1,
        owner: lane.owner,
        sessionId: "session:context",
        summary: "Escalate with bounded recovered context",
        version: "herdr.work.decision.v2"
      }
      const handoff = yield* Schema.decodeUnknownEffect(WorkDecisionHandoff)(input)
      expect(handoff).toMatchObject({
        contextDelta: input.contextDelta,
        expectedRevision: lane.revision,
        version: "herdr.work.decision.v2"
      })
      for (const contextDelta of ["", "x".repeat(4_097)]) {
        expect(
          yield* Effect.result(Schema.decodeUnknownEffect(WorkDecisionHandoff)({ ...input, contextDelta }))
        ).toMatchObject({ failure: {} })
      }
      expect(
        yield* Effect.result(service.handoff({ ...handoff, expectedRevision: lane.revision - 1 }))
      ).toMatchObject({
        failure: {
          _tag: "WorkDecisionRevisionConflictError",
          actualRevision: lane.revision,
          expectedRevision: lane.revision - 1,
          laneId: lane.laneId
        }
      })
      expect(yield* service.handoff(handoff)).toEqual(handoff)
      first.close()

      const reopened = yield* openScopedStore(path)
      const restarted = yield* makeWorkService(reopened.store)
      expect(yield* restarted.coordinatorHandoff(handoff.sessionId)).toEqual(Option.some(handoff))
    }).pipe(provideNodeServices))

  it.effect("rejects malformed surrogate text in coordinator handoffs", () =>
    Effect.gen(function*() {
      const handoff: WorkDecisionHandoff = {
        blockers: [],
        contextDelta: "Valid text \uFFFD",
        decision: "handoff",
        dispatchIds: [],
        evidenceRefs: [],
        expectedRevision: 1,
        goalId: "goal-text",
        id: "handoff-text",
        laneId: "lane-text",
        occurredAt: 1,
        owner: { id: "owner-packages", name: "Package owner" },
        sessionId: "session-text",
        summary: "Valid text \uFFFD",
        version: "herdr.work.decision.v2"
      }
      expect(yield* Schema.decodeUnknownEffect(WorkDecisionHandoff)(handoff)).toEqual(handoff)
      for (const malformed of ["\uD800", "\uDC00"]) {
        expect(
          yield* Effect.result(Schema.decodeUnknownEffect(WorkDecisionHandoff)({ ...handoff, summary: malformed }))
        ).toMatchObject({ failure: {} })
        expect(
          yield* Effect.result(
            Schema.decodeUnknownEffect(WorkDecisionHandoff)({
              ...handoff,
              owner: { ...handoff.owner, name: malformed }
            })
          )
        ).toMatchObject({ failure: {} })
      }
    }))

  it.effect("rejects denormalized handoff identity drift and preserves decision ordering", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-decision-denormalized-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const store = yield* openScopedStore(path)
      store.close()
      const first: WorkDecisionHandoff = {
        blockers: [],
        contextDelta: "First handoff",
        decision: "handoff",
        dispatchIds: [],
        evidenceRefs: [],
        expectedRevision: 1,
        goalId: "goal-decision-identity",
        id: "handoff-record-1",
        laneId: "goal-decision-identity",
        occurredAt: 1,
        owner: { id: "owner-packages", name: "Package owner" },
        sessionId: "session-record-1",
        summary: "First handoff",
        version: "herdr.work.decision.v2"
      }
      const database = new DatabaseSync(path)
      database.prepare(
        `INSERT INTO work_decision_handoffs
           (handoff_id, session_id, lane_id, occurred_at, record)
         VALUES (?, ?, ?, ?, ?)`
      ).run("handoff-row-1", first.sessionId, first.laneId, 2, JSON.stringify(first))
      database.close()

      expect(yield* safelyOpenResult(path)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.handoff-identity" },
          operation: "open.database"
        }
      })
      const repairedFirst = new DatabaseSync(path)
      repairedFirst.prepare(
        "UPDATE work_decision_handoffs SET handoff_id = ?, occurred_at = ? WHERE handoff_id = ?"
      ).run(first.id, first.occurredAt, "handoff-row-1")
      repairedFirst.close()

      const replay = {
        ...first,
        goalId: "goal-decision-replay",
        id: "handoff-replay",
        laneId: "goal-decision-replay",
        occurredAt: 3,
        sessionId: "session-replay"
      }
      const replaySeed = new DatabaseSync(path)
      replaySeed.prepare(
        `INSERT INTO work_decision_handoffs
           (handoff_id, session_id, lane_id, occurred_at, record)
         VALUES (?, ?, ?, ?, ?)`
      ).run(replay.id, replay.sessionId, "foreign-lane", 4, JSON.stringify(replay))
      replaySeed.close()
      expect(yield* safelyOpenResult(path)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.handoff-identity" },
          operation: "open.database"
        }
      })

      const repairedReplay = new DatabaseSync(path)
      repairedReplay.prepare(
        "UPDATE work_decision_handoffs SET lane_id = ?, occurred_at = ? WHERE handoff_id = ?"
      ).run(replay.laneId, replay.occurredAt, replay.id)
      repairedReplay.close()
      const replayedStore = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => replayedStore.close()))
      const replayedService = yield* makeWorkService(replayedStore)
      expect(yield* replayedService.handoff(replay)).toEqual(replay)

      const repaired = new DatabaseSync(path)
      const second = {
        ...first,
        id: "handoff-record-2",
        occurredAt: 2,
        sessionId: "session-record-2",
        summary: "Second handoff"
      }
      repaired.prepare(
        `INSERT INTO work_decision_handoffs
           (handoff_id, session_id, lane_id, occurred_at, record)
         VALUES (?, ?, ?, ?, ?)`
      ).run(second.id, second.sessionId, second.laneId, second.occurredAt, JSON.stringify(second))
      repaired.close()

      const orderedStore = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => orderedStore.close()))
      const orderedService = yield* makeWorkService(orderedStore)
      expect(yield* orderedService.decisions(first.laneId)).toEqual([first, second])
    }).pipe(provideNodeServices))

  it.effect("bounds durable lane claims by count and encoded bytes", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-lane-capacity-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const claim: WorkLaneClaim = {
        branch: "feat/durable-work",
        expectedRevision: 0,
        goalId: "goal-lane-cap",
        head: "0123456789012345678901234567890123456789",
        laneId: "goal-lane-cap",
        operationId: "operation-lane-cap",
        owner: { id: "owner-packages", name: "Package owner" },
        parent: null,
        phase: "implementation",
        worktree: "/home/konopkov/Work/dev/knpkv.dev/worktrees/npm/feat-durable-work"
      }
      yield* Effect.acquireUseRelease(
        WorkStore.open(path),
        (store) =>
          Effect.gen(function*() {
            const service = yield* makeWorkService(store)
            yield* service.claim(claim)
          }),
        (store) => Effect.sync(() => store.close())
      )

      const database = new DatabaseSync(path)
      const insert = database.prepare(
        `INSERT INTO work_lane_claims
           (lane_id, goal_id, operation_id, phase, revision, record)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (let index = 0; index < workSnapshotMaxGoals - 1; index++) {
        const laneId = `goal-lane-seed-${index}`
        const seeded = { ...claim, goalId: laneId, laneId, operationId: `operation-lane-seed-${index}`, revision: 1 }
        insert.run(laneId, seeded.goalId, seeded.operationId, seeded.phase, 1, JSON.stringify(seeded))
      }
      database.close()

      yield* Effect.acquireUseRelease(
        WorkStore.open(path),
        (store) =>
          Effect.gen(function*() {
            const service = yield* makeWorkService(store)
            expect(
              yield* Effect.result(service.claim({
                ...claim,
                goalId: "goal-lane-overflow",
                laneId: "goal-lane-overflow",
                operationId: "operation-lane-overflow"
              }))
            ).toMatchObject({
              failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
            })
            expect(
              yield* service.claim({
                ...claim,
                expectedRevision: 1,
                operationId: "operation-lane-cap-update",
                phase: "validation"
              })
            ).toMatchObject({
              laneId: claim.laneId,
              phase: "validation",
              revision: 2
            })
          }),
        (store) => Effect.sync(() => store.close())
      )

      const countDatabase = new DatabaseSync(path)
      const count = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(
        countDatabase.prepare("SELECT COUNT(*) AS count FROM work_lane_claims").get()
      ).count
      countDatabase.close()
      expect(count).toBe(workSnapshotMaxGoals)

      const bytesDirectory = mkdtempSync(join(tmpdir(), "herdr-work-lane-bytes-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(bytesDirectory, { force: true, recursive: true })))
      const bytesPath = join(bytesDirectory, "work.sqlite")
      yield* Effect.acquireUseRelease(
        WorkStore.open(bytesPath),
        () => Effect.void,
        (store) => Effect.sync(() => store.close())
      )
      const bytesDatabase = new DatabaseSync(bytesPath)
      const bytesInsert = bytesDatabase.prepare(
        `INSERT INTO work_lane_claims
           (lane_id, goal_id, operation_id, phase, revision, record)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      const largeOwner = { id: "owner-packages", name: "x".repeat(4_096) }
      for (let index = 0; index < 500; index++) {
        const laneId = `goal-lane-bytes-${index}`
        const seeded = {
          ...claim,
          goalId: laneId,
          laneId,
          operationId: `operation-lane-bytes-${index}`,
          owner: largeOwner,
          revision: 1
        }
        bytesInsert.run(
          laneId,
          seeded.goalId,
          seeded.operationId,
          seeded.phase,
          1,
          JSON.stringify(seeded)
        )
      }
      bytesDatabase.close()

      yield* Effect.acquireUseRelease(
        WorkStore.open(bytesPath),
        (store) =>
          Effect.gen(function*() {
            const service = yield* makeWorkService(store)
            expect(
              yield* Effect.result(service.claim({
                ...claim,
                goalId: "goal-lane-bytes-overflow",
                laneId: "goal-lane-bytes-overflow",
                operationId: "operation-lane-bytes-overflow"
              }))
            ).toMatchObject(
              {
                failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
              }
            )
          }),
        (store) => Effect.sync(() => store.close())
      )
    }).pipe(provideNodeServices))

  it.effect("bounds lane operation replay history while preserving old replay", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-operation-bytes-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const claim: WorkLaneClaim = {
        branch: "feat/durable-work",
        expectedRevision: 0,
        goalId: "goal-operation-cap",
        head: "0123456789012345678901234567890123456789",
        laneId: "lane-operation-cap",
        operationId: "operation-cap-first",
        owner: { id: "owner-packages", name: "Package owner" },
        parent: null,
        phase: "implementation",
        worktree: "/repo/worktree"
      }
      const first = yield* openScopedStore(path)
      const firstService = yield* makeWorkService(first.store)
      yield* firstService.claim(claim)
      first.close()

      const database = new DatabaseSync(path)
      const insert = database.prepare(
        `INSERT INTO work_lane_operations
           (operation_id, lane_id, goal_id, phase, revision, record)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      const totals = () =>
        Schema.decodeUnknownSync(
          Schema.Struct({ operationBytes: Schema.Number })
        )(
          database.prepare(
            `SELECT operation_bytes AS operationBytes
           FROM work_lane_operation_totals WHERE singleton = 1`
          ).get()
        ).operationBytes
      let operationBytes = totals()
      for (let index = 0;; index += 1) {
        const operationId = `operation-cap-seed-${index}`
        const laneId = `lane-cap-seed-${index}`
        const seeded = {
          ...claim,
          expectedRevision: 0,
          goalId: `goal-cap-seed-${index}`,
          laneId,
          operationId,
          owner: { id: "owner-packages", name: "x".repeat(4_096) },
          revision: 1
        }
        const record = JSON.stringify(seeded)
        const entryBytes = utf8ByteLength(operationId) + utf8ByteLength(record)
        if (operationBytes + entryBytes > __herdrWorkLaneOperationMaxBytesForTest) break
        insert.run(operationId, laneId, seeded.goalId, seeded.phase, seeded.revision, record)
        operationBytes += entryBytes
      }
      database.close()

      const reopened = yield* openScopedStore(path)
      const service = yield* makeWorkService(reopened.store)
      expect(yield* service.claim(claim)).toMatchObject({ operationId: claim.operationId, revision: 1 })
      const overflow = {
        ...claim,
        expectedRevision: 1,
        operationId: "operation-cap-overflow",
        owner: { id: "owner-packages", name: "x".repeat(4_096) },
        phase: "validation",
        worktree: `/${"w".repeat(2_047)}`
      }
      expect(yield* Effect.result(service.claim(overflow))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
      })
      expect(yield* service.currentClaim(claim.laneId)).toEqual(
        Option.some({ ...claim, revision: 1 })
      )
    }).pipe(provideNodeServices))

  it.effect("reads a durable lane claim after reopening the store", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-lane-restart-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const claim: WorkLaneClaim = {
        branch: "feat/durable-work",
        expectedRevision: 0,
        goalId: "goal-restart",
        head: "a".repeat(64),
        laneId: "goal-restart",
        operationId: "operation-restart",
        owner: { id: "owner-packages", name: "Package owner" },
        parent: null,
        phase: "validation",
        worktree: "/home/konopkov/Work/dev/knpkv.dev/worktrees/npm/feat-durable-work"
      }
      const claimed = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* WorkStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
          const service = yield* makeWorkService(store)
          return yield* service.claim(claim)
        })
      )
      const current = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* WorkStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
          const service = yield* makeWorkService(store)
          const byLane = yield* service.currentClaim(claim.laneId)
          const byGoal = yield* service.activeGoalClaim(claim.goalId)
          const replay = yield* service.claim(claim)
          return { byGoal, byLane, replay }
        })
      )
      expect(current.byLane).toEqual(Option.some(claimed))
      expect(current.byGoal).toEqual(Option.some(claimed))
      expect(current.replay).toEqual(claimed)
      const unknown = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* WorkStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
          const service = yield* makeWorkService(store)
          return yield* service.currentClaim("unknown-lane")
        })
      )
      expect(Option.isNone(unknown)).toBe(true)

      const database = new DatabaseSync(path)
      const insertClaim = database.prepare(
        `INSERT INTO work_lane_claims
           (lane_id, goal_id, operation_id, phase, revision, record)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      insertClaim.run(
        "goal-key",
        "goal-key",
        "operation-key",
        claim.phase,
        1,
        JSON.stringify({
          ...claim,
          goalId: "goal-key",
          laneId: "goal-record",
          operationId: "operation-key",
          revision: 1
        })
      )
      insertClaim.run(
        "goal-revision",
        "goal-revision",
        "operation-revision",
        claim.phase,
        1,
        JSON.stringify({
          ...claim,
          expectedRevision: 1,
          goalId: "goal-revision",
          laneId: "goal-revision",
          operationId: "operation-revision",
          revision: 2
        })
      )
      insertClaim.run(
        "goal-malformed",
        "goal-malformed",
        "operation-malformed",
        claim.phase,
        1,
        "not-json"
      )
      database.close()
      const mismatch = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* WorkStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
          const service = yield* makeWorkService(store)
          return yield* Effect.result(service.currentClaim("goal-key"))
        })
      )
      expect(mismatch).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "claim.read.identity-mismatch" }
      })
      const writeMismatches = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* WorkStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
          const service = yield* makeWorkService(store)
          return yield* Effect.all([
            Effect.result(service.claim({
              ...claim,
              goalId: "goal-key",
              laneId: "goal-key",
              operationId: "operation-write-key",
              expectedRevision: 1
            })),
            Effect.result(service.claim({
              ...claim,
              goalId: "goal-revision",
              laneId: "goal-revision",
              operationId: "operation-write-revision",
              expectedRevision: 1
            })),
            Effect.result(service.claim({
              ...claim,
              goalId: "goal-malformed",
              laneId: "goal-malformed",
              operationId: "operation-write-malformed",
              expectedRevision: 1
            }))
          ])
        })
      )
      expect(writeMismatches).toMatchObject([
        { failure: { _tag: "WorkStoreError", operation: "claim.write.identity-mismatch" } },
        { failure: { _tag: "WorkStoreError" } },
        { failure: { _tag: "WorkStoreError" } }
      ])
    }).pipe(provideNodeServices))

  it.effect("rejects every incomplete coordinator schema before creating Work tables", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-partial-coordinator-schema-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const coordinatorTables = [
        "orchestrator_dispatches",
        "orchestrator_events",
        "orchestrator_dispatch_metadata"
      ]
      for (let mask = 1; mask < 7; mask += 1) {
        const path = join(directory, `partial-${mask}.sqlite`)
        const database = new DatabaseSync(path)
        for (const [index, table] of coordinatorTables.entries()) {
          if ((mask & (1 << index)) !== 0) database.exec(`CREATE TABLE ${table} (id TEXT)`)
        }
        database.close()

        expect(yield* safelyOpenResult(path)).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: "open.migrate.schema" },
            operation: "open.database"
          }
        })
        const unchanged = new DatabaseSync(path)
        const createdWorkTable = unchanged.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'work_decision_handoffs'"
        ).get()
        unchanged.close()
        expect(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(createdWorkTable).count).toBe(0)
      }
    }).pipe(provideNodeServices))

  it.effect("transactionally migrates the previous lane and handoff schema", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-legacy-authority-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const legacyClaim = {
        branch: "feat/legacy-work",
        expectedRevision: 0,
        head: "0123456789012345678901234567890123456789",
        laneId: "goal:legacy",
        owner: { id: "owner:legacy", name: "Legacy owner" },
        parent: null,
        phase: "implementation",
        revision: 1,
        worktree: "/worktrees/legacy"
      }
      const legacyHandoff = {
        decision: "handoff",
        goalId: "goal:legacy",
        id: "handoff:legacy",
        laneId: "goal:legacy",
        occurredAt: 1,
        owner: legacyClaim.owner,
        summary: "Legacy decision",
        version: "herdr.work.decision.v1"
      }
      const database = new DatabaseSync(path)
      database.exec(`
        CREATE TABLE work_lane_claims (
          lane_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE work_decision_handoffs (
          handoff_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE work_dispatch_handoffs (
          dispatch_request_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL UNIQUE, lane_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL, lineage TEXT NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE work_agent_bindings (
          dispatch_request_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
          revision INTEGER NOT NULL, agent_id TEXT NOT NULL, host TEXT NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE orchestrator_dispatch_metadata (
          dispatch_request_id TEXT PRIMARY KEY, route TEXT, work_link TEXT
        );
      `)
      database.prepare("INSERT INTO work_lane_claims VALUES (?, ?, ?)")
        .run(legacyClaim.laneId, legacyClaim.revision, JSON.stringify(legacyClaim))
      database.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?)")
        .run(legacyHandoff.id, legacyHandoff.laneId, legacyHandoff.occurredAt, JSON.stringify(legacyHandoff))
      const parentDispatchRequestId = "dispatch:legacy-luna"
      const lineage = [parentDispatchRequestId]
      const legacyBinding = migrationBinding(
        "dispatch:legacy-sol",
        Schema.decodeUnknownSync(WorkLaneClaimed)({
          ...legacyClaim,
          expectedRevision: legacyClaim.expectedRevision,
          goalId: legacyHandoff.goalId,
          operationId: "dispatch:legacy-sol",
          revision: legacyClaim.revision
        }),
        legacyHandoff.occurredAt
      )
      persistMigrationBindingCompanions(database, legacyBinding)
      database.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "dispatch:legacy-sol",
          legacyHandoff.id,
          legacyHandoff.laneId,
          legacyHandoff.occurredAt,
          JSON.stringify(lineage),
          JSON.stringify(legacyHandoff)
        )
      database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "dispatch:legacy-sol",
        legacyHandoff.laneId,
        legacyBinding.request.expectedRevision,
        legacyBinding.lane.revision,
        legacyBinding.request.worker.agentId,
        legacyBinding.request.worker.host,
        JSON.stringify(legacyBinding)
      )
      database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "dispatch:unrelated-binding",
        legacyHandoff.laneId,
        0,
        1,
        "agent:unrelated",
        "SER8",
        "not-json"
      )
      database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)")
        .run(
          "dispatch:legacy-sol",
          JSON.stringify(migrationSolRoute(null)),
          JSON.stringify({ handoff: legacyHandoff, lineage })
        )
      database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, NULL, NULL)")
        .run("dispatch:unrelated-metadata")
      persistCoordinatorLifecycle(
        database,
        "dispatch:legacy-sol",
        legacyBinding.checkpoint.occurredAt,
        "running",
        "work"
      )
      database.close()

      const rewoundLegacyPath = join(directory, "rewound-legacy-lane.sqlite")
      copyFileSync(path, rewoundLegacyPath)
      const rewoundLegacy = new DatabaseSync(rewoundLegacyPath)
      const rewoundBinding = migrationBinding(
        "dispatch:legacy-sol",
        Schema.decodeUnknownSync(WorkLaneClaimed)({
          ...legacyClaim,
          expectedRevision: legacyClaim.revision,
          goalId: legacyHandoff.goalId,
          operationId: "dispatch:legacy-sol",
          revision: legacyClaim.revision + 1
        }),
        legacyHandoff.occurredAt
      )
      rewoundLegacy.prepare(
        `UPDATE work_agent_bindings
         SET expected_revision = ?, revision = ?, agent_id = ?, host = ?, record = ?
         WHERE dispatch_request_id = ?`
      ).run(
        rewoundBinding.request.expectedRevision,
        rewoundBinding.lane.revision,
        rewoundBinding.request.worker.agentId,
        rewoundBinding.request.worker.host,
        JSON.stringify(rewoundBinding),
        rewoundBinding.request.dispatchRequestId
      )
      rewoundLegacy.prepare(
        `UPDATE work_lane_operations
         SET lane_id = ?, goal_id = ?, phase = ?, revision = ?, record = ?
         WHERE operation_id = ?`
      ).run(
        rewoundBinding.lane.laneId,
        rewoundBinding.lane.goalId,
        rewoundBinding.lane.phase,
        rewoundBinding.lane.revision,
        JSON.stringify(rewoundBinding.lane),
        rewoundBinding.lane.operationId
      )
      rewoundLegacy.close()
      expect(yield* safelyOpenResult(rewoundLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.legacy-handoff-lane-revision" },
          operation: "open.database"
        }
      })
      const rewoundLegacyRolledBack = new DatabaseSync(rewoundLegacyPath)
      expect(
        rewoundLegacyRolledBack.prepare("PRAGMA table_info(work_decision_handoffs)").all()
          .some((column) =>
            Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(column).name === "session_id"
          )
      ).toBe(false)
      rewoundLegacyRolledBack.close()

      const duplicateMetadataPath = join(directory, "duplicate-legacy-metadata.sqlite")
      copyFileSync(path, duplicateMetadataPath)
      const duplicateMetadata = new DatabaseSync(duplicateMetadataPath)
      duplicateMetadata.exec(`
        ALTER TABLE orchestrator_dispatch_metadata RENAME TO orchestrator_dispatch_metadata_unique;
          CREATE TABLE orchestrator_dispatch_metadata (
          dispatch_request_id TEXT NOT NULL, route TEXT, work_link TEXT
        );
        INSERT INTO orchestrator_dispatch_metadata
          SELECT * FROM orchestrator_dispatch_metadata_unique;
        INSERT INTO orchestrator_dispatch_metadata
          SELECT * FROM orchestrator_dispatch_metadata_unique;
        DROP TABLE orchestrator_dispatch_metadata_unique;
      `)
      duplicateMetadata.close()
      expect(yield* safelyOpenResult(duplicateMetadataPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
          operation: "open.database"
        }
      })
      const duplicateMetadataRolledBack = new DatabaseSync(duplicateMetadataPath)
      expect(
        duplicateMetadataRolledBack.prepare(
          `SELECT COUNT(*) AS count FROM orchestrator_dispatch_metadata
           WHERE dispatch_request_id = 'dispatch:legacy-sol'`
        ).get()
      ).toEqual({ count: 2 })
      duplicateMetadataRolledBack.close()

      const queuedLegacyPath = join(directory, "queued-legacy-lifecycle.sqlite")
      copyFileSync(path, queuedLegacyPath)
      const queuedLegacy = new DatabaseSync(queuedLegacyPath)
      queuedLegacy.prepare("DELETE FROM orchestrator_events WHERE type = 'running'").run()
      queuedLegacy.prepare("UPDATE orchestrator_dispatches SET status = 'queued'").run()
      queuedLegacy.close()
      expect(yield* safelyOpenResult(queuedLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.legacy-agent-binding.lifecycle" },
          operation: "open.database"
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

      const runningLegacyPath = join(directory, "running-legacy-lifecycle.sqlite")
      copyFileSync(path, runningLegacyPath)
      const runningLegacyOpened = yield* openScopedStore(runningLegacyPath)
      runningLegacyOpened.close()

      const missingMetadataLegacyPath = join(directory, "missing-metadata-legacy.sqlite")
      copyFileSync(path, missingMetadataLegacyPath)
      const missingMetadataLegacy = new DatabaseSync(missingMetadataLegacyPath)
      missingMetadataLegacy.exec("DROP TABLE orchestrator_dispatch_metadata")
      missingMetadataLegacy.close()
      expect(yield* safelyOpenResult(missingMetadataLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.schema" },
          operation: "open.database"
        }
      })

      const unroutedLegacyPath = join(directory, "unrouted-legacy.sqlite")
      copyFileSync(path, unroutedLegacyPath)
      const unroutedLegacy = new DatabaseSync(unroutedLegacyPath)
      unroutedLegacy.prepare("UPDATE orchestrator_dispatches SET is_routed = 0").run()
      unroutedLegacy.close()
      expect(yield* safelyOpenResult(unroutedLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
          operation: "open.database"
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

      const missingParentLegacyPath = join(directory, "missing-parent-legacy.sqlite")
      copyFileSync(path, missingParentLegacyPath)
      const missingParentLegacy = new DatabaseSync(missingParentLegacyPath)
      missingParentLegacy.prepare(
        "UPDATE orchestrator_dispatch_metadata SET route = ? WHERE dispatch_request_id = ?"
      ).run(JSON.stringify(migrationSolRoute(parentDispatchRequestId)), "dispatch:legacy-sol")
      missingParentLegacy.close()
      expect(yield* safelyOpenResult(missingParentLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.legacy-metadata-authority.parent" },
          operation: "open.database"
        }
      })

      const failedParentLegacyPath = join(directory, "failed-parent-legacy.sqlite")
      copyFileSync(path, failedParentLegacyPath)
      const failedParentLegacy = new DatabaseSync(failedParentLegacyPath)
      persistCoordinatorLifecycle(failedParentLegacy, parentDispatchRequestId, 10, "task_failed", "consult")
      failedParentLegacy.prepare(
        "UPDATE orchestrator_dispatch_metadata SET route = ? WHERE dispatch_request_id = ?"
      ).run(JSON.stringify(migrationSolRoute(parentDispatchRequestId)), "dispatch:legacy-sol")
      failedParentLegacy.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, NULL)")
        .run(parentDispatchRequestId, JSON.stringify(migrationLunaRoute))
      failedParentLegacy.close()
      const failedParentLegacyOpened = yield* openScopedStore(failedParentLegacyPath)
      failedParentLegacyOpened.close()

      const duplicateLegacyPath = join(directory, "duplicate-legacy-dispatch.sqlite")
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
        legacyHandoff.id,
        legacyHandoff.laneId,
        legacyHandoff.occurredAt,
        JSON.stringify(lineage),
        JSON.stringify(legacyHandoff)
      )
      duplicateLegacy.close()
      expect(yield* safelyOpenResult(duplicateLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.legacy-dispatch-cardinality" },
          operation: "open.database"
        }
      })
      const duplicateLegacyRolledBack = new DatabaseSync(duplicateLegacyPath)
      const retainedDuplicateLegacy = duplicateLegacyRolledBack.prepare(
        "SELECT record FROM work_dispatch_handoffs WHERE handoff_id = ?"
      ).all(legacyHandoff.id)
      duplicateLegacyRolledBack.close()
      expect(retainedDuplicateLegacy).toHaveLength(2)

      const oversizedLegacyPath = join(directory, "oversized-legacy.sqlite")
      copyFileSync(path, oversizedLegacyPath)
      const oversizedLegacy = new DatabaseSync(oversizedLegacyPath)
      for (let index = 0; index < 260; index++) {
        const occurredAt = index + 10
        const handoff = {
          ...legacyHandoff,
          id: `handoff:legacy-capacity:${String(index)}`,
          occurredAt,
          summary: "x".repeat(4_096)
        }
        const dispatchRequestId = `dispatch:legacy-capacity:${String(index)}`
        const dispatchLineage = [`dispatch:legacy-luna:${String(index)}`]
        const binding = migrationBinding(
          dispatchRequestId,
          Schema.decodeUnknownSync(WorkLaneClaimed)({
            ...legacyClaim,
            expectedRevision: legacyClaim.expectedRevision,
            goalId: handoff.goalId,
            operationId: dispatchRequestId,
            revision: legacyClaim.revision
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
            JSON.stringify(migrationSolRoute(`dispatch:legacy-luna:${String(index)}`)),
            JSON.stringify({ handoff, lineage: dispatchLineage })
          )
      }
      oversizedLegacy.exec(`
        DROP TABLE orchestrator_dispatch_metadata;
        DROP TABLE orchestrator_events;
        DROP TABLE orchestrator_dispatches;
      `)
      oversizedLegacy.close()
      expect(yield* safelyOpenResult(oversizedLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.handoff-capacity" },
          operation: "open.database"
        }
      })
      const oversizedRolledBack = new DatabaseSync(oversizedLegacyPath)
      const oversizedColumns = oversizedRolledBack.prepare("PRAGMA table_info(work_decision_handoffs)").all()
      const oversizedRetained = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        oversizedRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(legacyHandoff.id)
      )
      oversizedRolledBack.close()
      expect(
        oversizedColumns.some((column) =>
          Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(column).name === "session_id"
        )
      ).toBe(false)
      expect(JSON.parse(oversizedRetained.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const unboundLegacyPath = join(directory, "unbound-legacy.sqlite")
      copyFileSync(path, unboundLegacyPath)
      const unboundLegacy = new DatabaseSync(unboundLegacyPath)
      const advancedLegacyClaim = {
        ...legacyClaim,
        expectedRevision: legacyClaim.revision,
        revision: legacyClaim.revision + 1
      }
      unboundLegacy.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
        .run("dispatch:legacy-sol")
      unboundLegacy.prepare("UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?")
        .run(advancedLegacyClaim.revision, JSON.stringify(advancedLegacyClaim), advancedLegacyClaim.laneId)
      unboundLegacy.close()

      const concurrentHandoff = {
        ...legacyHandoff,
        id: "handoff:concurrent",
        occurredAt: 2,
        summary: "Concurrent legacy decision"
      }
      const concurrentDispatchRequestId = `dispatch:${concurrentHandoff.id}`
      const concurrentBinding = migrationBinding(
        concurrentDispatchRequestId,
        Schema.decodeUnknownSync(WorkLaneClaimed)({
          ...legacyClaim,
          expectedRevision: legacyClaim.expectedRevision,
          goalId: concurrentHandoff.goalId,
          operationId: concurrentDispatchRequestId,
          revision: legacyClaim.revision
        }),
        concurrentHandoff.occurredAt
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
  .run(dispatchRequestId, "idempotency:" + dispatchRequestId, activityIdempotencyKey, JSON.stringify({
    activityIdempotencyKey, actor: "coordinator", kind: "fleet.job",
    payload: { kind: "agent.delegate", mode: "work", prompt: "Migrate", repository: "/repo" }
  }), Math.max(0, handoff.occurredAt - 2))
const insertEvent = database.prepare("INSERT INTO orchestrator_events VALUES (?, ?, ?, ?, ?, ?, ?)")
insertEvent.run(dispatchRequestId, 0, "accepted", activityIdempotencyKey,
  Math.max(0, handoff.occurredAt - 2), null, null)
insertEvent.run(dispatchRequestId, 1, "queued", activityIdempotencyKey,
  Math.max(0, handoff.occurredAt - 1), null, null)
insertEvent.run(dispatchRequestId, 2, "running", activityIdempotencyKey, handoff.occurredAt, null, null)
process.stdout.write("locked\\n")
await new Promise((resolve) => setTimeout(resolve, 250))
database.exec("COMMIT")
database.close()`,
          path,
          JSON.stringify(concurrentHandoff),
          String(legacyClaim.expectedRevision),
          JSON.stringify(concurrentBinding)
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => writer.kill()))
      yield* Effect.callback<void, LockHolderError>((resume) => {
        let completed = false
        const complete = (result: Effect.Effect<void, LockHolderError>) => {
          if (completed) {
            return
          }
          completed = true
          resume(result)
        }
        writer.stdout.setEncoding("utf8")
        writer.stdout.once("data", () => complete(Effect.void))
        writer.once("error", (cause) => complete(Effect.fail(new LockHolderError({ cause: String(cause) }))))
        writer.once("exit", (code, signal) =>
          complete(
            Effect.fail(new LockHolderError({ cause: `lock holder exited before readiness: ${code ?? signal}` }))
          ))
      })

      const opened = yield* openScopedStore(path)
      const service = yield* makeWorkService(opened.store)
      expect(yield* service.currentClaim(legacyClaim.laneId)).toMatchObject({
        value: { goalId: legacyClaim.laneId, operationId: legacyClaim.laneId, revision: 1 }
      })
      expect(yield* service.coordinatorHandoff(legacyHandoff.id)).toMatchObject({
        value: {
          contextDelta: legacyHandoff.summary,
          dispatchIds: lineage,
          expectedRevision: legacyClaim.expectedRevision,
          id: legacyHandoff.id,
          sessionId: legacyHandoff.id,
          version: "herdr.work.decision.v2"
        }
      })
      expect(yield* service.coordinatorHandoff(concurrentHandoff.id)).toMatchObject({
        value: { id: concurrentHandoff.id, sessionId: concurrentHandoff.id }
      })
      opened.close()
      const migrated = new DatabaseSync(path)
      const dispatchRecord = migrated.prepare(
        "SELECT record FROM work_dispatch_handoffs WHERE dispatch_request_id = ?"
      ).get("dispatch:legacy-sol")
      const metadataRecord = migrated.prepare(
        "SELECT work_link AS workLink FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?"
      ).get("dispatch:legacy-sol")
      migrated.close()
      expect(Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(dispatchRecord).record)
        .toContain(lineage[0])
      expect(Schema.decodeUnknownSync(Schema.Struct({ workLink: Schema.String }))(metadataRecord).workLink)
        .toContain(lineage[0])

      expect(yield* safelyOpenResult(unboundLegacyPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.legacy-handoff-revision" },
          operation: "open.database"
        }
      })
      const unboundLegacyRolledBack = new DatabaseSync(unboundLegacyPath)
      const retainedLegacy = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        unboundLegacyRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(legacyHandoff.id)
      )
      const retainedLegacyColumns = unboundLegacyRolledBack.prepare(
        "PRAGMA table_info(work_decision_handoffs)"
      ).all()
      unboundLegacyRolledBack.close()
      expect(JSON.parse(retainedLegacy.record)).toMatchObject({ version: "herdr.work.decision.v1" })
      expect(
        retainedLegacyColumns.some((column) =>
          Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(column).name === "session_id"
        )
      ).toBe(false)

      const corruptedPath = join(directory, "corrupted.sqlite")
      const corrupted = new DatabaseSync(corruptedPath)
      corrupted.exec("CREATE TABLE work_lane_claims (lane_id TEXT PRIMARY KEY, revision INTEGER, record TEXT)")
      corrupted.prepare("INSERT INTO work_lane_claims VALUES (?, ?, ?)").run("goal:corrupt", 1, "not-json")
      corrupted.close()
      expect(yield* safelyOpenResult(corruptedPath)).toMatchObject({ failure: { _tag: "WorkStoreError" } })
      const unchanged = new DatabaseSync(corruptedPath)
      const columns = unchanged.prepare("PRAGMA table_info(work_lane_claims)").all()
      unchanged.close()
      expect(
        columns.some((column) =>
          Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(column).name === "goal_id"
        )
      )
        .toBe(false)
    }).pipe(provideNodeServices))

  it.effect("migrates v1 handoffs already stored in the current schema", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-current-handoff-migration-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const owner = { id: "owner:current-migration", name: "Current migration owner" }
      const lane = {
        branch: "feat/current-migration",
        expectedRevision: 1,
        goalId: "goal:current-migration",
        head: "0123456789012345678901234567890123456789",
        laneId: "goal:current-migration",
        operationId: "dispatch:current-migration",
        owner,
        parent: null,
        phase: "implementation",
        revision: 2,
        worktree: "/worktrees/current-migration"
      }
      const previousHandoff = {
        blockers: [],
        decision: "handoff",
        dispatchIds: ["dispatch:failed-luna", "dispatch:earlier"],
        evidenceRefs: [],
        goalId: lane.goalId,
        id: "handoff:current-migration",
        laneId: lane.laneId,
        occurredAt: 1,
        owner,
        sessionId: "session:current-migration",
        summary: "Current schema decision",
        version: "herdr.work.decision.v1"
      }
      const currentHandoff = {
        ...previousHandoff,
        contextDelta: "Already current",
        expectedRevision: lane.revision,
        id: "handoff:already-current",
        occurredAt: 2,
        sessionId: "session:already-current",
        version: "herdr.work.decision.v2"
      }
      const database = new DatabaseSync(path)
      database.exec(`
        CREATE TABLE work_lane_claims (
          lane_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
          phase TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE work_decision_handoffs (
          handoff_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, lane_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE work_dispatch_handoffs (
          dispatch_request_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL UNIQUE, lane_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL, lineage TEXT NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE work_agent_bindings (
          dispatch_request_id TEXT PRIMARY KEY, lane_id TEXT NOT NULL, expected_revision INTEGER NOT NULL,
          revision INTEGER NOT NULL, agent_id TEXT NOT NULL, host TEXT NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE orchestrator_dispatch_metadata (
          dispatch_request_id TEXT PRIMARY KEY, route TEXT NOT NULL, work_link TEXT
        );
      `)
      database.prepare("INSERT INTO work_lane_claims VALUES (?, ?, ?, ?, ?, ?)").run(
        lane.laneId,
        lane.goalId,
        lane.operationId,
        lane.phase,
        lane.revision,
        JSON.stringify(lane)
      )
      const insertDecision = database.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?, ?)")
      insertDecision.run(
        previousHandoff.id,
        previousHandoff.sessionId,
        previousHandoff.laneId,
        previousHandoff.occurredAt,
        JSON.stringify(previousHandoff)
      )
      insertDecision.run(
        currentHandoff.id,
        currentHandoff.sessionId,
        currentHandoff.laneId,
        currentHandoff.occurredAt,
        JSON.stringify(currentHandoff)
      )
      const parentDispatchRequestId = "dispatch:failed-luna"
      const lineage = [parentDispatchRequestId]
      const binding = migrationBinding("dispatch:current-migration", lane, 2)
      persistMigrationBindingCompanions(database, binding)
      database.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)").run(
        "dispatch:current-migration",
        previousHandoff.id,
        previousHandoff.laneId,
        previousHandoff.occurredAt,
        JSON.stringify(lineage),
        JSON.stringify(previousHandoff)
      )
      database.prepare("INSERT INTO work_agent_bindings VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "dispatch:current-migration",
        lane.laneId,
        binding.request.expectedRevision,
        binding.lane.revision,
        binding.request.worker.agentId,
        binding.request.worker.host,
        JSON.stringify(binding)
      )
      database.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)").run(
        "dispatch:current-migration",
        JSON.stringify(migrationSolRoute(null)),
        JSON.stringify({ handoff: previousHandoff, lineage })
      )
      persistCoordinatorLifecycle(
        database,
        "dispatch:current-migration",
        binding.checkpoint.occurredAt,
        "running",
        "work"
      )
      database.close()

      const standalonePath = join(directory, "standalone-v1.sqlite")
      copyFileSync(path, standalonePath)
      const standalone = new DatabaseSync(standalonePath)
      standalone.exec(`
        DROP TABLE orchestrator_dispatch_metadata;
        DROP TABLE orchestrator_events;
        DROP TABLE orchestrator_dispatches;
      `)
      standalone.close()
      const standaloneOpened = yield* openScopedStore(standalonePath)
      const standaloneService = yield* makeWorkService(standaloneOpened.store)
      expect(yield* standaloneService.coordinatorHandoff(previousHandoff.sessionId)).toMatchObject({
        value: { expectedRevision: 1, version: "herdr.work.decision.v2" }
      })
      standaloneOpened.close()

      const rewoundLanePath = join(directory, "rewound-v1-lane.sqlite")
      copyFileSync(path, rewoundLanePath)
      const rewoundLane = new DatabaseSync(rewoundLanePath)
      rewoundLane.prepare("UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?").run(
        lane.revision - 1,
        JSON.stringify({ ...lane, expectedRevision: lane.expectedRevision - 1, revision: lane.revision - 1 }),
        lane.laneId
      )
      rewoundLane.close()
      expect(yield* safelyOpenResult(rewoundLanePath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.handoff-lane-revision" },
          operation: "open.database"
        }
      })
      const rewoundLaneRolledBack = new DatabaseSync(rewoundLanePath)
      expect(
        rewoundLaneRolledBack.prepare(
          "SELECT revision FROM work_lane_claims WHERE lane_id = ?"
        ).get(lane.laneId)
      ).toEqual({ revision: lane.revision - 1 })
      rewoundLaneRolledBack.close()

      const advancedLanePath = join(directory, "advanced-v1-lane.sqlite")
      copyFileSync(path, advancedLanePath)
      const advancedLaneDatabase = new DatabaseSync(advancedLanePath)
      const forwardLane = { ...lane, expectedRevision: lane.revision, revision: lane.revision + 1 }
      advancedLaneDatabase.prepare(
        "UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?"
      ).run(forwardLane.revision, JSON.stringify(forwardLane), lane.laneId)
      advancedLaneDatabase.close()
      const advancedOpened = yield* openScopedStore(advancedLanePath)
      const advancedService = yield* makeWorkService(advancedOpened.store)
      expect(yield* advancedService.currentClaim(lane.laneId)).toMatchObject({
        value: { revision: forwardLane.revision }
      })
      expect(yield* advancedService.coordinatorHandoff(previousHandoff.sessionId)).toMatchObject({
        value: { version: "herdr.work.decision.v2" }
      })
      advancedOpened.close()

      const queuedLifecyclePath = join(directory, "queued-lifecycle.sqlite")
      copyFileSync(path, queuedLifecyclePath)
      const queuedLifecycle = new DatabaseSync(queuedLifecyclePath)
      queuedLifecycle.prepare("DELETE FROM orchestrator_events WHERE type = 'running'").run()
      queuedLifecycle.prepare("UPDATE orchestrator_dispatches SET status = 'queued'").run()
      queuedLifecycle.close()
      expect(yield* safelyOpenResult(queuedLifecyclePath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.agent-binding.lifecycle" },
          operation: "open.database"
        }
      })
      const queuedLifecycleRolledBack = new DatabaseSync(queuedLifecyclePath)
      const retainedQueuedLifecycle = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        queuedLifecycleRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(previousHandoff.id)
      )
      queuedLifecycleRolledBack.close()
      expect(JSON.parse(retainedQueuedLifecycle.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const runningLifecyclePath = join(directory, "running-lifecycle.sqlite")
      copyFileSync(path, runningLifecyclePath)
      const runningOpened = yield* openScopedStore(runningLifecyclePath)
      const runningService = yield* makeWorkService(runningOpened.store)
      expect(yield* runningService.coordinatorHandoff(previousHandoff.sessionId)).toMatchObject({
        value: { expectedRevision: 1, version: "herdr.work.decision.v2" }
      })
      runningOpened.close()

      const rewoundCurrentLanePath = join(directory, "rewound-current-v2-lane.sqlite")
      copyFileSync(runningLifecyclePath, rewoundCurrentLanePath)
      const rewoundCurrentLane = new DatabaseSync(rewoundCurrentLanePath)
      rewoundCurrentLane.prepare(
        "UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?"
      ).run(
        lane.revision - 1,
        JSON.stringify({ ...lane, expectedRevision: lane.expectedRevision - 1, revision: lane.revision - 1 }),
        lane.laneId
      )
      rewoundCurrentLane.close()
      expect(yield* safelyOpenResult(rewoundCurrentLanePath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: {
            _tag: "WorkStoreError",
            operation: "open.migrate.current-agent-binding.lane-revision"
          },
          operation: "open.database"
        }
      })

      const advancedCurrentLanePath = join(directory, "advanced-current-v2-lane.sqlite")
      copyFileSync(runningLifecyclePath, advancedCurrentLanePath)
      const advancedCurrentLane = new DatabaseSync(advancedCurrentLanePath)
      const advancedCurrentClaim = { ...lane, expectedRevision: lane.revision, revision: lane.revision + 1 }
      advancedCurrentLane.prepare(
        "UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?"
      ).run(
        advancedCurrentClaim.revision,
        JSON.stringify(advancedCurrentClaim),
        advancedCurrentClaim.laneId
      )
      advancedCurrentLane.close()
      const advancedCurrentOpened = yield* openScopedStore(advancedCurrentLanePath)
      advancedCurrentOpened.close()

      const mixedDuplicateMetadataPath = join(directory, "mixed-duplicate-current-metadata.sqlite")
      copyFileSync(runningLifecyclePath, mixedDuplicateMetadataPath)
      const mixedDuplicateMetadata = new DatabaseSync(mixedDuplicateMetadataPath)
      mixedDuplicateMetadata.exec(`
        ALTER TABLE orchestrator_dispatch_metadata RENAME TO orchestrator_dispatch_metadata_unique;
        CREATE TABLE orchestrator_dispatch_metadata (
          dispatch_request_id TEXT NOT NULL, route TEXT NOT NULL, work_link TEXT
        );
        INSERT INTO orchestrator_dispatch_metadata
          SELECT * FROM orchestrator_dispatch_metadata_unique;
        INSERT INTO orchestrator_dispatch_metadata
          SELECT dispatch_request_id, route, NULL FROM orchestrator_dispatch_metadata_unique;
        DROP TABLE orchestrator_dispatch_metadata_unique;
      `)
      mixedDuplicateMetadata.close()
      expect(yield* safelyOpenResult(mixedDuplicateMetadataPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
          operation: "open.database"
        }
      })
      const mixedDuplicateMetadataRolledBack = new DatabaseSync(mixedDuplicateMetadataPath)
      expect(
        mixedDuplicateMetadataRolledBack.prepare(
          "SELECT COUNT(*) AS count FROM orchestrator_dispatch_metadata"
        ).get()
      ).toEqual({ count: 2 })
      mixedDuplicateMetadataRolledBack.close()

      const missingSolWorkLinkPath = join(directory, "missing-sol-work-link.sqlite")
      copyFileSync(runningLifecyclePath, missingSolWorkLinkPath)
      const missingSolWorkLink = new DatabaseSync(missingSolWorkLinkPath)
      missingSolWorkLink.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      missingSolWorkLink.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      missingSolWorkLink.prepare("DELETE FROM work_decision_handoffs WHERE handoff_id = ?")
        .run(previousHandoff.id)
      missingSolWorkLink.prepare(
        "UPDATE orchestrator_dispatch_metadata SET work_link = NULL WHERE dispatch_request_id = ?"
      ).run("dispatch:current-migration")
      missingSolWorkLink.close()
      expect(yield* safelyOpenResult(missingSolWorkLinkPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
          operation: "open.database"
        }
      })

      const lunaNullWorkLinkPath = join(directory, "luna-null-work-link.sqlite")
      copyFileSync(runningLifecyclePath, lunaNullWorkLinkPath)
      const lunaNullWorkLink = new DatabaseSync(lunaNullWorkLinkPath)
      persistCoordinatorLifecycle(lunaNullWorkLink, "dispatch:luna-null-work-link", 20, "queued", "consult")
      lunaNullWorkLink.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, NULL)")
        .run("dispatch:luna-null-work-link", JSON.stringify(migrationLunaRoute))
      lunaNullWorkLink.close()
      const lunaNullOpened = yield* openScopedStore(lunaNullWorkLinkPath)
      lunaNullOpened.close()

      for (
        const { name, workLink } of [
          { name: "object", workLink: "{}" },
          { name: "invalid-json", workLink: "{" }
        ]
      ) {
        const malformedLunaWorkLinkPath = join(directory, `luna-${name}-work-link.sqlite`)
        copyFileSync(lunaNullWorkLinkPath, malformedLunaWorkLinkPath)
        const malformedLunaWorkLink = new DatabaseSync(malformedLunaWorkLinkPath)
        malformedLunaWorkLink.prepare(
          "UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?"
        ).run(workLink, "dispatch:luna-null-work-link")
        malformedLunaWorkLink.close()
        expect(yield* safelyOpenResult(malformedLunaWorkLinkPath)).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
            operation: "open.database"
          }
        })
      }

      const lunaHistoryPath = join(directory, "luna-history-above-work-cap.sqlite")
      copyFileSync(runningLifecyclePath, lunaHistoryPath)
      const lunaHistory = new DatabaseSync(lunaHistoryPath)
      lunaHistory.prepare(
        `WITH RECURSIVE history(value) AS (
           VALUES(1) UNION ALL SELECT value + 1 FROM history WHERE value < 16385
         )
         INSERT INTO orchestrator_dispatches
           (dispatch_request_id, idempotency_key, activity_idempotency_key, command,
            accepted_at, is_routed, status)
         SELECT 'dispatch:luna-history:' || value, 'idempotency:luna-history:' || value,
           'activity:luna-history:' || value, '{}', 20, 1, 'queued'
         FROM history`
      ).run()
      lunaHistory.prepare(
        `WITH RECURSIVE history(value) AS (
           VALUES(1) UNION ALL SELECT value + 1 FROM history WHERE value < 16385
         )
         INSERT INTO orchestrator_dispatch_metadata
         SELECT 'dispatch:luna-history:' || value, ?, NULL FROM history`
      ).run(JSON.stringify(migrationLunaRoute))
      lunaHistory.close()
      const lunaHistoryOpened = yield* openScopedStore(lunaHistoryPath)
      lunaHistoryOpened.close()

      const routedWithoutMetadataPath = join(directory, "routed-without-metadata.sqlite")
      copyFileSync(runningLifecyclePath, routedWithoutMetadataPath)
      const routedWithoutMetadata = new DatabaseSync(routedWithoutMetadataPath)
      routedWithoutMetadata.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      routedWithoutMetadata.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      routedWithoutMetadata.prepare("DELETE FROM work_decision_handoffs WHERE handoff_id = ?")
        .run(previousHandoff.id)
      routedWithoutMetadata.prepare(
        "DELETE FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?"
      ).run("dispatch:current-migration")
      routedWithoutMetadata.close()
      expect(yield* safelyOpenResult(routedWithoutMetadataPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.routed-metadata" },
          operation: "open.database"
        }
      })

      const v2OnlyPartialSchemaPath = join(directory, "v2-only-partial-coordinator-schema.sqlite")
      copyFileSync(runningLifecyclePath, v2OnlyPartialSchemaPath)
      const v2OnlyPartialSchema = new DatabaseSync(v2OnlyPartialSchemaPath)
      v2OnlyPartialSchema.exec("DROP TABLE orchestrator_dispatch_metadata")
      v2OnlyPartialSchema.close()
      expect(yield* safelyOpenResult(v2OnlyPartialSchemaPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.schema" },
          operation: "open.database"
        }
      })

      const v2OnlyMissingMetadataPath = join(directory, "v2-only-missing-metadata.sqlite")
      copyFileSync(runningLifecyclePath, v2OnlyMissingMetadataPath)
      const v2OnlyMissingMetadata = new DatabaseSync(v2OnlyMissingMetadataPath)
      v2OnlyMissingMetadata.prepare(
        "DELETE FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?"
      ).run("dispatch:current-migration")
      v2OnlyMissingMetadata.close()
      expect(yield* safelyOpenResult(v2OnlyMissingMetadataPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-authority" },
          operation: "open.database"
        }
      })

      const v2CommandModeMismatchPath = join(directory, "v2-command-mode-mismatch.sqlite")
      copyFileSync(runningLifecyclePath, v2CommandModeMismatchPath)
      const v2CommandModeMismatch = new DatabaseSync(v2CommandModeMismatchPath)
      v2CommandModeMismatch.prepare(
        `UPDATE orchestrator_dispatches
         SET command = json_set(command, '$.payload.mode', 'transition_summary')
         WHERE dispatch_request_id = ?`
      ).run("dispatch:current-migration")
      const mismatchedCommandBefore = Schema.decodeUnknownSync(Schema.Struct({
        command: Schema.String,
        record: Schema.String
      }))(
        v2CommandModeMismatch.prepare(
          `SELECT dispatch.command, decision.record
           FROM orchestrator_dispatches dispatch
           JOIN work_dispatch_handoffs handoff USING (dispatch_request_id)
           JOIN work_decision_handoffs decision USING (handoff_id)
           WHERE dispatch.dispatch_request_id = ?`
        ).get("dispatch:current-migration")
      )
      v2CommandModeMismatch.close()
      expect(yield* safelyOpenResult(v2CommandModeMismatchPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-authority" },
          operation: "open.database"
        }
      })
      const v2CommandModeMismatchRolledBack = new DatabaseSync(v2CommandModeMismatchPath)
      const mismatchedCommandAfter = Schema.decodeUnknownSync(Schema.Struct({
        command: Schema.String,
        record: Schema.String
      }))(
        v2CommandModeMismatchRolledBack.prepare(
          `SELECT dispatch.command, decision.record
           FROM orchestrator_dispatches dispatch
           JOIN work_dispatch_handoffs handoff USING (dispatch_request_id)
           JOIN work_decision_handoffs decision USING (handoff_id)
           WHERE dispatch.dispatch_request_id = ?`
        ).get("dispatch:current-migration")
      )
      v2CommandModeMismatchRolledBack.close()
      expect(mismatchedCommandAfter).toEqual(mismatchedCommandBefore)

      for (
        const integrityCase of [
          {
            expectedOperation: "open.migrate.metadata-authority",
            name: "v2-channelled-sol-command",
            mutate: (candidate: DatabaseSync) =>
              candidate.prepare(
                `UPDATE orchestrator_dispatches
                 SET command = json_set(command, '$.payload.channel', 'coordinator_chat')
                 WHERE dispatch_request_id = ?`
              ).run("dispatch:current-migration")
          },
          {
            expectedOperation: "open.migrate.metadata-authority",
            name: "v2-command-activity-key-mismatch",
            mutate: (candidate: DatabaseSync) =>
              candidate.prepare(
                `UPDATE orchestrator_dispatches
                 SET command = json_set(command, '$.activityIdempotencyKey', 'activity:outsider')
                 WHERE dispatch_request_id = ?`
              ).run("dispatch:current-migration")
          },
          {
            expectedOperation: "open.migrate.current-agent-binding",
            name: "v2-missing-running-binding",
            mutate: (candidate: DatabaseSync) =>
              candidate.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
                .run("dispatch:current-migration")
          },
          {
            expectedOperation: "open.migrate.dispatch-decision",
            name: "v2-orphan-dispatch",
            mutate: (candidate: DatabaseSync) =>
              candidate.prepare("DELETE FROM work_decision_handoffs WHERE handoff_id = ?")
                .run(previousHandoff.id)
          },
          {
            expectedOperation: "open.migrate.metadata-decision",
            name: "v2-orphan-metadata",
            mutate: (candidate: DatabaseSync) => {
              candidate.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
                .run("dispatch:current-migration")
              candidate.prepare("DELETE FROM work_decision_handoffs WHERE handoff_id = ?")
                .run(previousHandoff.id)
            }
          }
        ]
      ) {
        const integrityPath = join(directory, `${integrityCase.name}.sqlite`)
        copyFileSync(runningLifecyclePath, integrityPath)
        const candidate = new DatabaseSync(integrityPath)
        integrityCase.mutate(candidate)
        candidate.close()
        expect(yield* safelyOpenResult(integrityPath)).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: integrityCase.expectedOperation },
            operation: "open.database"
          }
        })
      }

      for (
        const terminal of ["queued", "delivery_failed"] satisfies ReadonlyArray<
          "queued" | "delivery_failed"
        >
      ) {
        const bindingFreePath = join(directory, `v2-binding-free-${terminal}.sqlite`)
        copyFileSync(runningLifecyclePath, bindingFreePath)
        const bindingFree = new DatabaseSync(bindingFreePath)
        bindingFree.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
          .run("dispatch:current-migration")
        bindingFree.prepare("DELETE FROM orchestrator_events WHERE type = 'running'").run()
        if (terminal === "delivery_failed") {
          bindingFree.prepare(
            `INSERT INTO orchestrator_events
               (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
             VALUES (?, 2, 'delivery_failed', ?, 2, 'delivery failed before worker start', NULL)`
          ).run("dispatch:current-migration", "activity:dispatch:current-migration")
        }
        bindingFree.prepare("UPDATE orchestrator_dispatches SET status = ? WHERE dispatch_request_id = ?")
          .run(terminal, "dispatch:current-migration")
        bindingFree.close()
        const opened = yield* openScopedStore(bindingFreePath)
        opened.close()
      }

      const missingMetadataPath = join(directory, "missing-metadata-current.sqlite")
      copyFileSync(path, missingMetadataPath)
      const missingMetadata = new DatabaseSync(missingMetadataPath)
      missingMetadata.exec("DROP TABLE orchestrator_dispatch_metadata")
      missingMetadata.close()
      expect(yield* safelyOpenResult(missingMetadataPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.schema" },
          operation: "open.database"
        }
      })

      const unroutedPath = join(directory, "unrouted-current.sqlite")
      copyFileSync(path, unroutedPath)
      const unrouted = new DatabaseSync(unroutedPath)
      unrouted.prepare("UPDATE orchestrator_dispatches SET is_routed = 0").run()
      unrouted.close()
      expect(yield* safelyOpenResult(unroutedPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
          operation: "open.database"
        }
      })
      const unroutedRolledBack = new DatabaseSync(unroutedPath)
      const unroutedDecision = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        unroutedRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(previousHandoff.id)
      )
      unroutedRolledBack.close()
      expect(JSON.parse(unroutedDecision.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const missingParentPath = join(directory, "missing-parent-current.sqlite")
      copyFileSync(path, missingParentPath)
      const missingParent = new DatabaseSync(missingParentPath)
      missingParent.prepare("UPDATE orchestrator_dispatch_metadata SET route = ?")
        .run(JSON.stringify(migrationSolRoute(parentDispatchRequestId)))
      missingParent.close()
      expect(yield* safelyOpenResult(missingParentPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-authority.parent" },
          operation: "open.database"
        }
      })

      const failedParentPath = join(directory, "failed-parent-current.sqlite")
      copyFileSync(path, failedParentPath)
      const failedParent = new DatabaseSync(failedParentPath)
      persistCoordinatorLifecycle(failedParent, parentDispatchRequestId, 10, "delivery_failed", "consult")
      failedParent.prepare("UPDATE orchestrator_dispatch_metadata SET route = ?")
        .run(JSON.stringify(migrationSolRoute(parentDispatchRequestId)))
      failedParent.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, NULL)")
        .run(parentDispatchRequestId, JSON.stringify(migrationLunaRoute))
      failedParent.close()
      const failedParentOpened = yield* openScopedStore(failedParentPath)
      failedParentOpened.close()

      const incompleteTerminalPath = join(directory, "incomplete-terminal-lifecycle.sqlite")
      copyFileSync(path, incompleteTerminalPath)
      const incompleteTerminal = new DatabaseSync(incompleteTerminalPath)
      incompleteTerminal.prepare("UPDATE orchestrator_dispatches SET status = 'settled'").run()
      incompleteTerminal.close()
      expect(yield* safelyOpenResult(incompleteTerminalPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.agent-binding.lifecycle" },
          operation: "open.database"
        }
      })
      const incompleteTerminalRolledBack = new DatabaseSync(incompleteTerminalPath)
      const retainedIncompleteTerminal = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        incompleteTerminalRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(previousHandoff.id)
      )
      incompleteTerminalRolledBack.close()
      expect(JSON.parse(retainedIncompleteTerminal.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const completeTerminalPath = join(directory, "complete-terminal-lifecycle.sqlite")
      copyFileSync(path, completeTerminalPath)
      const completeTerminal = new DatabaseSync(completeTerminalPath)
      completeTerminal.prepare(
        `INSERT INTO orchestrator_events
           (dispatch_request_id, sequence, type, activity_idempotency_key, occurred_at, detail, result)
         SELECT dispatch_request_id, 3, 'settled', activity_idempotency_key, ? + 1, NULL, 'done'
         FROM orchestrator_dispatches WHERE dispatch_request_id = ?`
      ).run(binding.checkpoint.occurredAt, "dispatch:current-migration")
      completeTerminal.prepare("UPDATE orchestrator_dispatches SET status = 'settled'").run()
      completeTerminal.close()
      const completeTerminalOpened = yield* openScopedStore(completeTerminalPath)
      completeTerminalOpened.close()

      const mismatchedGoalPath = join(directory, "mismatched-binding-goal.sqlite")
      copyFileSync(path, mismatchedGoalPath)
      const mismatchedGoal = new DatabaseSync(mismatchedGoalPath)
      const otherGoalHandoff = { ...previousHandoff, goalId: "goal:other" }
      mismatchedGoal.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(otherGoalHandoff), previousHandoff.id)
      mismatchedGoal.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify(otherGoalHandoff), "dispatch:current-migration")
      mismatchedGoal.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify({ handoff: otherGoalHandoff, lineage }), "dispatch:current-migration")
      mismatchedGoal.close()
      expect(yield* safelyOpenResult(mismatchedGoalPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.agent-binding.goal" },
          operation: "open.database"
        }
      })

      for (
        const invalidRoute of [
          {
            expectedOperation: "open.migrate.metadata-decision",
            name: "luna-route",
            route: {
              action: "dispatch",
              linkedRequestId: null,
              model: "gpt-5.6-luna",
              protocol: "hostd.coordinator.route.v1",
              reason: "Invalid Work-linked Luna route",
              reasoningEffort: "medium"
            }
          },
          {
            expectedOperation: "open.migrate.metadata-authority",
            name: "outsider-sol-route",
            route: migrationSolRoute("dispatch:outsider")
          }
        ]
      ) {
        const invalidRoutePath = join(directory, `${invalidRoute.name}.sqlite`)
        copyFileSync(path, invalidRoutePath)
        const candidate = new DatabaseSync(invalidRoutePath)
        candidate.prepare("UPDATE orchestrator_dispatch_metadata SET route = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify(invalidRoute.route), "dispatch:current-migration")
        candidate.close()
        expect(yield* safelyOpenResult(invalidRoutePath)).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: invalidRoute.expectedOperation },
            operation: "open.database"
          }
        })
      }

      const multipleDispatchPath = join(directory, "multiple-dispatches.sqlite")
      copyFileSync(path, multipleDispatchPath)
      const multipleDispatches = new DatabaseSync(multipleDispatchPath)
      multipleDispatches.exec(`
        ALTER TABLE work_dispatch_handoffs RENAME TO previous_work_dispatch_handoffs;
        CREATE TABLE work_dispatch_handoffs (
          dispatch_request_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL, lane_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL, lineage TEXT NOT NULL, record TEXT NOT NULL
        );
      `)
      multipleDispatches.prepare("INSERT INTO work_dispatch_handoffs VALUES (?, ?, ?, ?, ?, ?)").run(
        "dispatch:unbound-current-migration",
        previousHandoff.id,
        previousHandoff.laneId,
        previousHandoff.occurredAt,
        JSON.stringify(lineage),
        JSON.stringify(previousHandoff)
      )
      multipleDispatches.exec(`
        INSERT INTO work_dispatch_handoffs
        SELECT * FROM previous_work_dispatch_handoffs;
        DROP TABLE previous_work_dispatch_handoffs;
      `)
      multipleDispatches.prepare("INSERT INTO orchestrator_dispatch_metadata VALUES (?, ?, ?)").run(
        "dispatch:unbound-current-migration",
        JSON.stringify(migrationSolRoute("dispatch:failed-luna")),
        JSON.stringify({ handoff: previousHandoff, lineage })
      )
      persistCoordinatorLifecycle(
        multipleDispatches,
        "dispatch:unbound-current-migration",
        previousHandoff.occurredAt,
        "running",
        "work"
      )
      multipleDispatches.close()

      expect(yield* safelyOpenResult(multipleDispatchPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.dispatch-cardinality" },
          operation: "open.database"
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

      const opened = yield* openScopedStore(path)
      const service = yield* makeWorkService(opened.store)
      expect(yield* service.coordinatorHandoff(previousHandoff.sessionId)).toMatchObject({
        value: {
          contextDelta: previousHandoff.summary,
          expectedRevision: 1,
          version: "herdr.work.decision.v2"
        }
      })
      expect(yield* service.coordinatorHandoff(currentHandoff.sessionId)).toMatchObject({ value: currentHandoff })
      opened.close()

      const migrated = new DatabaseSync(path)
      const copies = Schema.decodeUnknownSync(Schema.Struct({
        record: Schema.String,
        workLink: Schema.String
      }))(
        migrated.prepare(
          `SELECT dispatch.record, metadata.work_link AS workLink
         FROM work_dispatch_handoffs dispatch
         JOIN orchestrator_dispatch_metadata metadata USING (dispatch_request_id)
         WHERE dispatch.handoff_id = ?`
        ).get(previousHandoff.id)
      )
      const retainedCurrent = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        migrated.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(currentHandoff.id)
      )
      migrated.close()
      expect(retainedCurrent.record).toBe(JSON.stringify(currentHandoff))
      expect(JSON.parse(copies.record)).toMatchObject({ expectedRevision: 1, version: "herdr.work.decision.v2" })
      expect(JSON.parse(copies.workLink)).toMatchObject({
        handoff: { expectedRevision: 1, version: "herdr.work.decision.v2" },
        lineage
      })

      for (
        const invalid of [
          {
            name: "unknown-handoff-version",
            operation: "open.migrate.invalid-handoff",
            record: JSON.stringify({ ...currentHandoff, version: "herdr.work.decision.v3" })
          },
          {
            name: "malformed-current-handoff",
            operation: "open.migrate.invalid-handoff",
            record: JSON.stringify({ ...currentHandoff, expectedRevision: "not-a-revision" })
          },
          {
            name: "current-handoff-indexed-lane-mismatch",
            operation: "open.migrate.handoff-identity",
            record: JSON.stringify({ ...currentHandoff, laneId: "lane:other" })
          }
        ]
      ) {
        const invalidPath = join(directory, `${invalid.name}.sqlite`)
        copyFileSync(path, invalidPath)
        const candidate = new DatabaseSync(invalidPath)
        candidate.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(invalid.record, currentHandoff.id)
        candidate.close()

        expect(yield* safelyOpenResult(invalidPath)).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: invalid.operation },
            operation: "open.database"
          }
        })
        const rolledBack = new DatabaseSync(invalidPath)
        const retained = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
          rolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
            .get(currentHandoff.id)
        )
        rolledBack.close()
        expect(retained.record).toBe(invalid.record)
      }

      const malformedPath = join(directory, "malformed-v1-handoff.sqlite")
      copyFileSync(path, malformedPath)
      const malformedV1 = new DatabaseSync(malformedPath)
      malformedV1.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify({ ...previousHandoff, dispatchIds: "not-an-array" }), previousHandoff.id)
      malformedV1.close()
      expect(yield* safelyOpenResult(malformedPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.invalid-handoff" },
          operation: "open.database"
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

      const outsiderPath = join(directory, "outsider-lineage.sqlite")
      copyFileSync(path, outsiderPath)
      const outsider = new DatabaseSync(outsiderPath)
      outsider.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      outsider.prepare("UPDATE work_dispatch_handoffs SET lineage = ?, record = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify(["dispatch:outsider"]), JSON.stringify(previousHandoff), "dispatch:current-migration")
      outsider.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
        .run(
          JSON.stringify({ handoff: previousHandoff, lineage: ["dispatch:outsider"] }),
          "dispatch:current-migration"
        )
      outsider.close()
      expect(yield* safelyOpenResult(outsiderPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.dispatch-authority" },
          operation: "open.database"
        }
      })
      const outsiderRolledBack = new DatabaseSync(outsiderPath)
      const retainedOutsider = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        outsiderRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(previousHandoff.id)
      )
      outsiderRolledBack.close()
      expect(JSON.parse(retainedOutsider.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const corruptBindingPath = join(directory, "corrupt-binding.sqlite")
      copyFileSync(path, corruptBindingPath)
      const corruptBinding = new DatabaseSync(corruptBindingPath)
      corruptBinding.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      corruptBinding.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify(previousHandoff), "dispatch:current-migration")
      corruptBinding.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify({ handoff: previousHandoff, lineage }), "dispatch:current-migration")
      corruptBinding.prepare("UPDATE work_agent_bindings SET expected_revision = ? WHERE dispatch_request_id = ?")
        .run(binding.request.expectedRevision + 1, "dispatch:current-migration")
      corruptBinding.close()
      expect(yield* safelyOpenResult(corruptBindingPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.agent-binding.identity-mismatch" },
          operation: "open.database"
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
            expectedOperation: "open.migrate.agent-binding.missing-companion",
            name: "missing-lane-companion",
            mutate: (candidate: DatabaseSync) =>
              candidate.prepare("DELETE FROM work_lane_operations WHERE operation_id = ?")
                .run(binding.lane.operationId)
          },
          {
            expectedOperation: "open.migrate.agent-binding.companion-identity-mismatch",
            name: "mismatched-checkpoint-companion",
            mutate: (candidate: DatabaseSync) =>
              candidate.prepare("UPDATE work_goal_events SET goal_id = ? WHERE event_id = ?")
                .run("goal:outsider", binding.checkpoint.eventId)
          }
        ]
      ) {
        const companionPath = join(directory, `${companion.name}.sqlite`)
        copyFileSync(path, companionPath)
        const candidate = new DatabaseSync(companionPath)
        candidate.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
          .run(JSON.stringify(previousHandoff), previousHandoff.id)
        candidate.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify(previousHandoff), "dispatch:current-migration")
        candidate.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
          .run(JSON.stringify({ handoff: previousHandoff, lineage }), "dispatch:current-migration")
        companion.mutate(candidate)
        candidate.close()

        expect(yield* safelyOpenResult(companionPath)).toMatchObject({
          failure: {
            _tag: "WorkStoreError",
            cause: { _tag: "WorkStoreError", operation: companion.expectedOperation },
            operation: "open.database"
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

      const unboundDecisionPath = join(directory, "unbound-decision.sqlite")
      copyFileSync(path, unboundDecisionPath)
      const unboundDecision = new DatabaseSync(unboundDecisionPath)
      const advancedLane = {
        ...lane,
        expectedRevision: lane.revision,
        revision: lane.revision + 1
      }
      unboundDecision.prepare("UPDATE work_lane_claims SET revision = ?, record = ? WHERE lane_id = ?")
        .run(advancedLane.revision, JSON.stringify(advancedLane), advancedLane.laneId)
      unboundDecision.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      unboundDecision.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      unboundDecision.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      unboundDecision.prepare("DELETE FROM orchestrator_dispatch_metadata WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      unboundDecision.close()
      expect(yield* safelyOpenResult(unboundDecisionPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.handoff-revision" },
          operation: "open.database"
        }
      })
      const unboundDecisionRolledBack = new DatabaseSync(unboundDecisionPath)
      const retainedUnboundDecision = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        unboundDecisionRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(previousHandoff.id)
      )
      unboundDecisionRolledBack.close()
      expect(JSON.parse(retainedUnboundDecision.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const divergentPath = join(directory, "divergent.sqlite")
      copyFileSync(path, divergentPath)
      const divergent = new DatabaseSync(divergentPath)
      divergent.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      divergent.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify({ ...previousHandoff, summary: "Divergent replica" }), "dispatch:current-migration")
      divergent.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify({ handoff: previousHandoff, lineage }), "dispatch:current-migration")
      divergent.close()
      expect(yield* safelyOpenResult(divergentPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.dispatch-authority" },
          operation: "open.database"
        }
      })
      const divergentRolledBack = new DatabaseSync(divergentPath)
      const retainedReplicas = Schema.decodeUnknownSync(Schema.Struct({
        decision: Schema.String,
        dispatch: Schema.String,
        workLink: Schema.String
      }))(
        divergentRolledBack.prepare(
          `SELECT decision.record AS decision, dispatch.record AS dispatch,
             metadata.work_link AS workLink
           FROM work_decision_handoffs decision
           JOIN work_dispatch_handoffs dispatch USING (handoff_id)
           JOIN orchestrator_dispatch_metadata metadata USING (dispatch_request_id)
           WHERE decision.handoff_id = ?`
        ).get(previousHandoff.id)
      )
      divergentRolledBack.close()
      expect(JSON.parse(retainedReplicas.decision)).toMatchObject({
        summary: previousHandoff.summary,
        version: "herdr.work.decision.v1"
      })
      expect(JSON.parse(retainedReplicas.dispatch)).toMatchObject({
        summary: "Divergent replica",
        version: "herdr.work.decision.v1"
      })
      expect(JSON.parse(retainedReplicas.workLink)).toMatchObject({
        handoff: { version: "herdr.work.decision.v1" }
      })

      const unboundPath = join(directory, "unbound.sqlite")
      copyFileSync(path, unboundPath)
      const unbound = new DatabaseSync(unboundPath)
      unbound.prepare("DELETE FROM work_agent_bindings WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      unbound.prepare("UPDATE work_lane_claims SET revision = ? WHERE lane_id = ?")
        .run(lane.revision + 1, lane.laneId)
      unbound.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      unbound.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify(previousHandoff), "dispatch:current-migration")
      unbound.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify({ handoff: previousHandoff, lineage }), "dispatch:current-migration")
      unbound.close()
      expect(yield* safelyOpenResult(unboundPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.handoff-revision" },
          operation: "open.database"
        }
      })
      const unboundRolledBack = new DatabaseSync(unboundPath)
      const retainedUnbound = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        unboundRolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(previousHandoff.id)
      )
      unboundRolledBack.close()
      expect(JSON.parse(retainedUnbound.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const nullMetadataPath = join(directory, "null-metadata.sqlite")
      copyFileSync(path, nullMetadataPath)
      const nullMetadata = new DatabaseSync(nullMetadataPath)
      nullMetadata.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      nullMetadata.prepare("UPDATE work_dispatch_handoffs SET record = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify(previousHandoff), "dispatch:current-migration")
      nullMetadata.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = NULL WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      nullMetadata.close()
      expect(yield* safelyOpenResult(nullMetadataPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
          operation: "open.database"
        }
      })
      const nullMetadataRolledBack = new DatabaseSync(nullMetadataPath)
      const retainedNullMetadata = Schema.decodeUnknownSync(Schema.Struct({
        record: Schema.String,
        workLink: Schema.Null
      }))(
        nullMetadataRolledBack.prepare(
          `SELECT decision.record, metadata.work_link AS workLink
           FROM work_decision_handoffs decision
           JOIN work_dispatch_handoffs dispatch USING (handoff_id)
           JOIN orchestrator_dispatch_metadata metadata USING (dispatch_request_id)
           WHERE decision.handoff_id = ?`
        ).get(previousHandoff.id)
      )
      nullMetadataRolledBack.close()
      expect(JSON.parse(retainedNullMetadata.record)).toMatchObject({ version: "herdr.work.decision.v1" })
      expect(retainedNullMetadata.workLink).toBeNull()

      const orphanMetadataPath = join(directory, "orphan-metadata.sqlite")
      copyFileSync(path, orphanMetadataPath)
      const orphanMetadata = new DatabaseSync(orphanMetadataPath)
      orphanMetadata.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      orphanMetadata.prepare("DELETE FROM work_dispatch_handoffs WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      orphanMetadata.prepare("UPDATE orchestrator_dispatch_metadata SET work_link = ? WHERE dispatch_request_id = ?")
        .run(JSON.stringify({ handoff: previousHandoff, lineage }), "dispatch:current-migration")
      orphanMetadata.close()
      expect(yield* safelyOpenResult(orphanMetadataPath)).toMatchObject({
        failure: {
          _tag: "WorkStoreError",
          cause: { _tag: "WorkStoreError", operation: "open.migrate.metadata-decision" },
          operation: "open.database"
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
        ).get(previousHandoff.id, "dispatch:current-migration")
      )
      orphanMetadataRolledBack.close()
      expect(JSON.parse(retainedOrphanMetadata.record)).toMatchObject({ version: "herdr.work.decision.v1" })
      expect(JSON.parse(retainedOrphanMetadata.workLink)).toMatchObject({
        handoff: { version: "herdr.work.decision.v1" }
      })

      const malformed = new DatabaseSync(path)
      malformed.prepare("UPDATE work_decision_handoffs SET record = ? WHERE handoff_id = ?")
        .run(JSON.stringify(previousHandoff), previousHandoff.id)
      malformed.prepare("UPDATE work_dispatch_handoffs SET lineage = '{}' WHERE dispatch_request_id = ?")
        .run("dispatch:current-migration")
      malformed.close()
      expect(yield* safelyOpenResult(path)).toMatchObject({ failure: { _tag: "WorkStoreError" } })
      const rolledBack = new DatabaseSync(path)
      const rolledBackDecision = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        rolledBack.prepare("SELECT record FROM work_decision_handoffs WHERE handoff_id = ?")
          .get(previousHandoff.id)
      )
      rolledBack.close()
      expect(JSON.parse(rolledBackDecision.record)).toMatchObject({ version: "herdr.work.decision.v1" })

      const oversizedPath = join(directory, "oversized.sqlite")
      const oversized = new DatabaseSync(oversizedPath)
      oversized.exec(`
        CREATE TABLE work_lane_claims (
          lane_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
          phase TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL
        );
        CREATE TABLE work_decision_handoffs (
          handoff_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, lane_id TEXT NOT NULL,
          occurred_at INTEGER NOT NULL, record TEXT NOT NULL
        );
      `)
      oversized.prepare("INSERT INTO work_lane_claims VALUES (?, ?, ?, ?, ?, ?)").run(
        lane.laneId,
        lane.goalId,
        lane.operationId,
        lane.phase,
        lane.revision,
        JSON.stringify(lane)
      )
      const insertOversized = oversized.prepare("INSERT INTO work_decision_handoffs VALUES (?, ?, ?, ?, ?)")
      for (let index = 0; index < 400; index += 1) {
        const handoff = {
          ...previousHandoff,
          dispatchIds: [],
          id: `handoff:oversized:${index}`,
          occurredAt: index,
          sessionId: `session:oversized:${index}`,
          summary: "x".repeat(4_096)
        }
        insertOversized.run(handoff.id, handoff.sessionId, handoff.laneId, handoff.occurredAt, JSON.stringify(handoff))
      }
      oversized.close()
      expect(yield* safelyOpenResult(oversizedPath)).toMatchObject({ failure: { _tag: "WorkStoreError" } })
      const overflowRolledBack = new DatabaseSync(oversizedPath)
      const retainedV1 = Schema.decodeUnknownSync(Schema.Struct({ record: Schema.String }))(
        overflowRolledBack.prepare("SELECT record FROM work_decision_handoffs LIMIT 1").get()
      )
      overflowRolledBack.close()
      expect(JSON.parse(retainedV1.record)).toMatchObject({ version: "herdr.work.decision.v1" })
    }).pipe(provideNodeServices))

  it.effect("fails closed when denormalized lane authority hides an active claim", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-lane-authority-drift-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const claim = laneClaim("lane-authority", "goal-authority")
      const first = yield* openScopedStore(path)
      const firstService = yield* makeWorkService(first.store)
      yield* firstService.claim(claim)
      first.close()

      const database = new DatabaseSync(path)
      database.prepare(
        "UPDATE work_lane_claims SET goal_id = ?, phase = 'shipped' WHERE lane_id = ?"
      ).run("goal-hidden", claim.laneId)
      database.close()

      const reopened = yield* openScopedStore(path)
      const service = yield* makeWorkService(reopened.store)
      expect(yield* Effect.result(service.activeGoalClaim(claim.goalId))).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "claim.goal.identity-mismatch" }
      })
      expect(
        yield* Effect.result(service.claim({
          ...laneClaim("lane-competing-authority", claim.goalId),
          operationId: "operation-competing-authority"
        }))
      ).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "claim.write.identity-mismatch" }
      })
      const count = new DatabaseSync(path)
      expect(count.prepare("SELECT COUNT(*) AS count FROM work_lane_claims").get()).toEqual({ count: 1 })
      count.close()
    }).pipe(provideNodeServices))

  it.effect("rejects cross-history inconsistencies before durable mutation", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-invariant-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)

      const missingCreation = checkpointForGoal("goal-late", "event-late", 2, 1)
      expect(yield* Effect.result(service.record(missingCreation))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "inconsistent_history" }
      })
      expect(yield* store.list()).toEqual([])

      yield* service.record(history[0])
      const changedCreation = {
        ...history[1],
        goal: { ...history[1].goal, createdAt: 1 }
      }
      expect(yield* Effect.result(service.record(changedCreation))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "inconsistent_history" }
      })
      expect(yield* store.list()).toEqual([history[0]])

      yield* service.record(history[1])
      expect((yield* service.snapshots(history[1].occurredAt)).now.goals[0]?.updatedAt).toBe(
        history[1].occurredAt
      )
    }).pipe(provideNodeServices))

  it.effect(
    "keeps the largest projectable event history writable and rejects the next event",
    () =>
      Effect.gen(function*() {
        const directory = mkdtempSync(join(tmpdir(), "herdr-work-event-capacity-"))
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
        const path = join(directory, "work.sqlite")
        const events = Array.from(
          { length: workHistoryMaxEvents },
          (_, index) => checkpointForGoal("goal-capacity", `event-${index}`, index, 0)
        )
        yield* Effect.sync(() => seedWorkDatabase(path, events))
        const store = yield* WorkStore.open(path)
        yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
        const service = yield* makeWorkService(store)

        expect((yield* service.snapshots(workHistoryMaxEvents)).now.goals).toHaveLength(1)
        const overflow = checkpointForGoal(
          "goal-capacity",
          `event-${workHistoryMaxEvents}`,
          workHistoryMaxEvents,
          0
        )
        expect(yield* Effect.result(service.record(overflow))).toMatchObject({
          failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
        })
        expect(yield* store.list()).toHaveLength(workHistoryMaxEvents)
      }).pipe(provideNodeServices),
    30_000
  )

  it.effect("keeps the largest snapshot projectable and rejects a new goal", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-goal-capacity-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const events = Array.from({ length: workSnapshotMaxGoals }, (_, index) =>
        checkpointForGoal(`goal-${index}`, `event-${index}`, index, index))
      yield* Effect.sync(() =>
        seedWorkDatabase(path, events)
      )
      const store = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)

      expect((yield* service.snapshots(workSnapshotMaxGoals)).now.goals).toHaveLength(
        workSnapshotMaxGoals
      )
      const overflow = checkpointForGoal(
        `goal-${workSnapshotMaxGoals}`,
        `event-${workSnapshotMaxGoals}`,
        workSnapshotMaxGoals,
        workSnapshotMaxGoals
      )
      expect(yield* Effect.result(service.record(overflow))).toMatchObject({
        failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
      })
      expect(yield* store.list()).toHaveLength(workSnapshotMaxGoals)
    }).pipe(provideNodeServices), 30_000)

  it.effect("rejects maximum-text goals before snapshots exceed the response budget", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-work-byte-capacity-"))
    const path = join(root, "work.sqlite")
    return Effect.acquireUseRelease(
      WorkStore.open(path),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeWorkService(store)
          for (let index = 0; index < 10; index += 1) {
            yield* Effect.result(service.record(maximumTextCheckpoint(index)))
          }
          const persistedBeforeFinalAttempt = yield* store.list()
          expect(
            yield* Effect.result(service.record(maximumTextCheckpoint(10)))
          ).toMatchObject({
            failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
          })
          expect(yield* store.list()).toEqual(persistedBeforeFinalAttempt)
          expect(persistedBeforeFinalAttempt.length).toBeLessThan(11)
          const snapshots = yield* service.snapshots(30 * day)
          expect(Buffer.byteLength(JSON.stringify(snapshots))).toBeLessThanOrEqual(
            fleetResponseBodyMaxBytes
          )
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("groups superseded goals under their canonical while preserving blockers, review, and activity", () =>
    Effect.gen(function*() {
      const original: WorkGoalCheckpointType = {
        ...checkpointForGoal("goal-connect-v1", "event-v1-created", 0, 0),
        goal: {
          ...checkpointForGoal("goal-connect-v1", "event-v1-created", 0, 0).goal,
          blocker: { since: 0, summary: "Original blocker" },
          review: { state: "changes_requested", summary: "Original review", updatedAt: 0, url: null },
          activity: [{ id: "activity-original", kind: "note", occurredAt: 0, summary: "Original activity" }],
          state: "blocked",
          title: "Connect terminal special keys v1"
        }
      }
      const v2: WorkGoalCheckpointType = {
        ...checkpointForGoal("goal-connect-v2", "event-v2-created", 0, 0),
        goal: {
          ...checkpointForGoal("goal-connect-v2", "event-v2-created", 0, 0).goal,
          blocker: { since: 0, summary: "V2 blocker" },
          review: { state: "requested", summary: "V2 review", updatedAt: 0, url: null },
          state: "blocked",
          title: "Connect terminal special keys v2"
        }
      }
      const v3 = checkpointForGoal("goal-connect-v3", "event-v3-created", 0, 0)
      const relationAt = 5 * day
      const canonicalV3 = familyCheckpoint(v3, "event-v3-canonical", relationAt, "goal-connect-v3", "canonical")
      const supersededV1 = familyCheckpoint(
        original,
        "event-v1-superseded",
        relationAt,
        "goal-connect-v3",
        "superseded"
      )
      const supersededV2 = familyCheckpoint(v2, "event-v2-superseded", relationAt, "goal-connect-v3", "superseded")
      const events = [original, v2, v3, canonicalV3, supersededV1, supersededV2]
      const snapshots = yield* projectWorkSnapshots(events, relationAt + 1)
      expect(snapshots.now.goals.map(({ id }) => id)).toEqual(["goal-connect-v3"])
      expect(snapshots.now.families).toHaveLength(1)
      const group = snapshots.now.families?.[0]
      expect(group?.canonicalGoalId).toBe("goal-connect-v3")
      expect(group?.canonical.id).toBe("goal-connect-v3")
      expect(group?.superseded.map(({ id }) => id).toSorted()).toEqual([
        "goal-connect-v1",
        "goal-connect-v2"
      ])
      expect(group?.superseded.find(({ id }) => id === "goal-connect-v1")?.blocker?.summary).toBe(
        "Original blocker"
      )
      expect(group?.superseded.find(({ id }) => id === "goal-connect-v1")?.review?.summary).toBe(
        "Original review"
      )
      expect(group?.superseded.find(({ id }) => id === "goal-connect-v1")?.activity).toEqual(
        [{ id: "activity-original", kind: "note", occurredAt: 0, summary: "Original activity" }]
      )
      expect(group?.superseded.find(({ id }) => id === "goal-connect-v2")?.blocker?.summary).toBe(
        "V2 blocker"
      )
      expect(snapshots.now.goals.some(({ id }) => id === "goal-connect-v1")).toBe(false)
      expect(snapshots.day.goals.map(({ id }) => id).toSorted()).toEqual([
        "goal-connect-v1",
        "goal-connect-v2",
        "goal-connect-v3"
      ])
      expect(snapshots.now.goals[0]?.id).toBe("goal-connect-v3")
    }))

  it.effect("orders superseded and canonical ties deterministically", () =>
    Effect.gen(function*() {
      const canonical = familyCheckpoint(
        checkpointForGoal("goal-canonical", "event-canonical-created", 0, 0),
        "event-canonical",
        10,
        "goal-canonical",
        "canonical"
      )
      const a = familyCheckpoint(
        {
          ...checkpointForGoal("goal-alpha", "event-alpha-created", 0, 0),
          goal: { ...checkpointForGoal("goal-alpha", "event-alpha-created", 0, 0).goal, title: "Alpha" }
        },
        "event-alpha-superseded",
        10,
        "goal-canonical",
        "superseded"
      )
      const b = familyCheckpoint(
        {
          ...checkpointForGoal("goal-beta", "event-beta-created", 0, 0),
          goal: { ...checkpointForGoal("goal-beta", "event-beta-created", 0, 0).goal, title: "Beta" }
        },
        "event-beta-superseded",
        10,
        "goal-canonical",
        "superseded"
      )
      const c = familyCheckpoint(
        {
          ...checkpointForGoal("goal-alpha-2", "event-alpha-2-created", 0, 0),
          goal: { ...checkpointForGoal("goal-alpha-2", "event-alpha-2-created", 0, 0).goal, title: "Alpha" }
        },
        "event-alpha-2-superseded",
        10,
        "goal-canonical",
        "superseded"
      )
      const reversed = [canonical, c, b, a]
      const snapshots = yield* projectWorkSnapshots(
        [
          checkpointForGoal("goal-canonical", "event-canonical-created", 0, 0),
          checkpointForGoal("goal-alpha", "event-alpha-created", 0, 0),
          checkpointForGoal("goal-beta", "event-beta-created", 0, 0),
          checkpointForGoal("goal-alpha-2", "event-alpha-2-created", 0, 0),
          ...reversed
        ],
        11
      )
      const supersededIds = snapshots.now.families?.[0]?.superseded.map(({ id }) => id)
      expect(supersededIds).toEqual(["goal-alpha", "goal-alpha-2", "goal-beta"])

      const unrelatedA: WorkGoalCheckpointType = {
        ...checkpointForGoal("goal-unrelated-b", "event-unrelated-b", 5, 5),
        goal: {
          ...checkpointForGoal("goal-unrelated-b", "event-unrelated-b", 5, 5).goal,
          title: "Unrelated B",
          updatedAt: 5
        }
      }
      const unrelatedB: WorkGoalCheckpointType = {
        ...checkpointForGoal("goal-unrelated-a", "event-unrelated-a", 5, 5),
        goal: {
          ...checkpointForGoal("goal-unrelated-a", "event-unrelated-a", 5, 5).goal,
          title: "Unrelated A",
          updatedAt: 5
        }
      }
      const snapshotsTie = yield* projectWorkSnapshots([unrelatedA, unrelatedB], 6)
      expect(snapshotsTie.now.goals.map(({ id }) => id)).toEqual(["goal-unrelated-a", "goal-unrelated-b"])
    }))

  it.effect("leaves unrelated goals unchanged when family grouping applies elsewhere", () =>
    Effect.gen(function*() {
      const unrelated = checkpointForGoal("goal-unrelated", "event-unrelated", 1, 1)
      const canonical = familyCheckpoint(
        checkpointForGoal("goal-canonical-2", "event-canonical-2-created", 0, 0),
        "event-canonical-2",
        2,
        "goal-canonical-2",
        "canonical"
      )
      const superseded = familyCheckpoint(
        checkpointForGoal("goal-old", "event-old-created", 0, 0),
        "event-old-superseded",
        2,
        "goal-canonical-2",
        "superseded"
      )
      const events = [
        checkpointForGoal("goal-canonical-2", "event-canonical-2-created", 0, 0),
        checkpointForGoal("goal-old", "event-old-created", 0, 0),
        unrelated,
        canonical,
        superseded
      ]
      const snapshots = yield* projectWorkSnapshots(events, 3)
      expect(snapshots.now.goals.map(({ id }) => id).toSorted()).toEqual(
        ["goal-canonical-2", "goal-unrelated"]
      )
      expect(snapshots.now.families).toHaveLength(1)
      expect(snapshots.now.families?.[0]?.canonicalGoalId).toBe("goal-canonical-2")
      expect(snapshots.now.goals.some(({ id }) => id === "goal-old")).toBe(false)
      expect(snapshots.now.goals.some(({ id }) => id === "goal-unrelated")).toBe(true)
      expect(snapshots.now.goals.find(({ id }) => id === "goal-unrelated")?.title).toBe("goal-unrelated")
    }))

  it.effect("orders active goals, families, and superseded members by code-point rather than locale", () =>
    Effect.gen(function*() {
      const canonical = familyCheckpoint(
        checkpointForGoal("goal-canonical", "event-canonical-created", 0, 0),
        "event-canonical",
        10,
        "goal-canonical",
        "canonical"
      )
      const supersededZ = familyCheckpoint(
        {
          ...checkpointForGoal("goal-z", "event-z-created", 0, 0),
          goal: { ...checkpointForGoal("goal-z", "event-z-created", 0, 0).goal, title: "z", updatedAt: 10 }
        },
        "event-z-superseded",
        10,
        "goal-canonical",
        "superseded"
      )
      const supersededAuml = familyCheckpoint(
        {
          ...checkpointForGoal("goal-auml", "event-auml-created", 0, 0),
          goal: { ...checkpointForGoal("goal-auml", "event-auml-created", 0, 0).goal, title: "ä", updatedAt: 10 }
        },
        "event-auml-superseded",
        10,
        "goal-canonical",
        "superseded"
      )
      const snapshots = yield* projectWorkSnapshots(
        [
          checkpointForGoal("goal-canonical", "event-canonical-created", 0, 0),
          checkpointForGoal("goal-z", "event-z-created", 0, 0),
          checkpointForGoal("goal-auml", "event-auml-created", 0, 0),
          canonical,
          supersededAuml,
          supersededZ
        ],
        11
      )
      expect(snapshots.now.families?.[0]?.superseded.map(({ title }) => title)).toEqual(["z", "ä"])
      expect(snapshots.now.families?.[0]?.superseded.map(({ id }) => id)).toEqual(["goal-z", "goal-auml"])

      // Family groups ordered by canonical title code-point
      const familyOrderingEvents = [
        checkpointForGoal("goal-canonical-z", "event-canonical-z-created", 0, 0),
        checkpointForGoal("goal-canonical-auml", "event-canonical-auml-created", 0, 0),
        checkpointForGoal("goal-old-z", "event-old-z-created", 0, 0),
        checkpointForGoal("goal-old-auml", "event-old-auml-created", 0, 0),
        familyCheckpoint(
          {
            ...checkpointForGoal("goal-canonical-z", "event-canonical-z-created", 0, 0),
            goal: {
              ...checkpointForGoal("goal-canonical-z", "event-canonical-z-created", 0, 0).goal,
              title: "z",
              updatedAt: 20
            }
          },
          "event-canonical-z",
          20,
          "goal-canonical-z",
          "canonical"
        ),
        familyCheckpoint(
          {
            ...checkpointForGoal("goal-canonical-auml", "event-canonical-auml-created", 0, 0),
            goal: {
              ...checkpointForGoal("goal-canonical-auml", "event-canonical-auml-created", 0, 0).goal,
              title: "ä",
              updatedAt: 20
            }
          },
          "event-canonical-auml",
          20,
          "goal-canonical-auml",
          "canonical"
        ),
        familyCheckpoint(
          checkpointForGoal("goal-old-z", "event-old-z-created", 0, 0),
          "event-old-z-superseded",
          20,
          "goal-canonical-z",
          "superseded"
        ),
        familyCheckpoint(
          checkpointForGoal("goal-old-auml", "event-old-auml-created", 0, 0),
          "event-old-auml-superseded",
          20,
          "goal-canonical-auml",
          "superseded"
        )
      ]
      const familyOrderingSnapshots = yield* projectWorkSnapshots(familyOrderingEvents, 21)
      expect(familyOrderingSnapshots.now.families?.map(({ canonical }) => canonical.title)).toEqual(["z", "ä"])

      const activeZ: WorkGoalCheckpointType = {
        ...checkpointForGoal("goal-active-z", "event-active-z", 5, 5),
        goal: { ...checkpointForGoal("goal-active-z", "event-active-z", 5, 5).goal, title: "z", updatedAt: 5 }
      }
      const activeAuml: WorkGoalCheckpointType = {
        ...checkpointForGoal("goal-active-auml", "event-active-auml", 5, 5),
        goal: { ...checkpointForGoal("goal-active-auml", "event-active-auml", 5, 5).goal, title: "ä", updatedAt: 5 }
      }
      const activeSnapshots = yield* projectWorkSnapshots([activeAuml, activeZ], 6)
      expect(activeSnapshots.now.goals.map(({ title }) => title)).toEqual(["z", "ä"])
    }))

  it.effect("maximumSnapshotBytes covers encoded family overhead including escaped canonicalGoalId", () =>
    Effect.gen(function*() {
      const escapedId = "\u0001".repeat(256)
      const canonicalBaseRaw = checkpointForGoal(escapedId, "event-canonical-max-created", 0, 0)
      const canonicalBase: WorkGoalCheckpointType = {
        ...canonicalBaseRaw,
        goal: {
          ...canonicalBaseRaw.goal,
          title: "Canonical max goal",
          summary: "Canonical max summary",
          detail: "Canonical max detail"
        }
      }
      const canonical: WorkGoalCheckpointType = {
        ...canonicalBase,
        eventId: "event-canonical-max",
        occurredAt: 10,
        goal: { ...canonicalBase.goal, goalFamily: { canonicalGoalId: escapedId, role: "canonical" }, updatedAt: 10 }
      }
      const supersededBase = checkpointForGoal("goal-superseded", "event-superseded-created", 0, 0)
      const superseded: WorkGoalCheckpointType = {
        ...supersededBase,
        eventId: "event-superseded",
        occurredAt: 10,
        goal: { ...supersededBase.goal, goalFamily: { canonicalGoalId: escapedId, role: "superseded" }, updatedAt: 10 }
      }
      const events = [canonicalBase, supersededBase, canonical, superseded]
      const snapshots = yield* projectWorkSnapshots(events, 11)
      const actualBytes = Buffer.byteLength(JSON.stringify(snapshots))
      const history = events.slice(0, -1)
      const candidate = events[events.length - 1]!
      const estimated = __herdrWorkMaximumSnapshotBytesForTest(history, candidate)
      expect(estimated).toBeGreaterThanOrEqual(actualBytes)
      const encodedIdBytes = __herdrWorkEncodedBytesForTest(escapedId)
      expect(encodedIdBytes).toBe(1_538)
      // Fixed 64-byte overhead would undercount this family: prove estimate includes escaped id bound
      const fixedOverheadEstimate = 64
      expect(encodedIdBytes + 64).toBeGreaterThan(fixedOverheadEstimate)
      expect(estimated).toBeGreaterThan(actualBytes - 1)

      const unrelatedEvents = Array.from(
        { length: 3 },
        (_, index) => checkpointForGoal(`goal-unrelated-${index}`, `event-unrelated-${index}`, index, index)
      )
      const unrelatedSnapshots = yield* projectWorkSnapshots(unrelatedEvents, 10)
      const unrelatedActual = Buffer.byteLength(JSON.stringify(unrelatedSnapshots))
      const unrelatedEstimated = __herdrWorkMaximumSnapshotBytesForTest(
        unrelatedEvents.slice(0, -1),
        unrelatedEvents[unrelatedEvents.length - 1]!
      )
      expect(unrelatedEstimated).toBeGreaterThanOrEqual(unrelatedActual)
    }))

  it.effect("allows valid append with long unrelated ID and small family groups", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-long-unrelated-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const service = yield* makeWorkService(store)

      const escapedId = "\u0001".repeat(256)
      const longUnrelated: WorkGoalCheckpointType = {
        ...checkpointForGoal(escapedId, "event-long-created", 0, 0),
        goal: {
          ...checkpointForGoal(escapedId, "event-long-created", 0, 0).goal,
          title: "long unrelated",
          summary: "long unrelated summary",
          detail: "long unrelated detail"
        }
      }
      const smallCount = 138
      const smallGoals = Array.from(
        { length: smallCount },
        (_, index) => checkpointForGoal(`goal-small-${index}`, `event-small-${index}`, index + 1, index + 1)
      )
      const canonicalBase = checkpointForGoal("goal-family-canonical", "event-canonical-base", 0, 0)
      const supersededBase = checkpointForGoal("goal-family-superseded", "event-superseded-base", 0, 0)
      const canonical = familyCheckpoint(
        canonicalBase,
        "event-canonical",
        10_000,
        "goal-family-canonical",
        "canonical"
      )
      const superseded = familyCheckpoint(
        supersededBase,
        "event-superseded",
        10_000,
        "goal-family-canonical",
        "superseded"
      )

      const history = [...smallGoals, longUnrelated, canonicalBase, supersededBase, canonical]
      for (const event of history) yield* store.append(event)

      const snapshotsBefore = yield* service.snapshots(20_000)
      expect(Buffer.byteLength(JSON.stringify(snapshotsBefore))).toBeLessThanOrEqual(
        fleetResponseBodyMaxBytes
      )

      const estimated = __herdrWorkMaximumSnapshotBytesForTest(history, superseded)
      const snapshotsAfter = yield* projectWorkSnapshots([...history, superseded], 20_001)
      const actualAfter = Buffer.byteLength(JSON.stringify(snapshotsAfter))
      expect(estimated).toBeGreaterThanOrEqual(actualAfter)
      expect(estimated).toBeLessThanOrEqual(fleetResponseBodyMaxBytes)

      // Must remain appendable despite long unrelated ID inflating previous max*size bound
      yield* store.append(superseded)
      expect(yield* store.list()).toHaveLength(history.length + 1)

      // Prove previous max*size amplification would have rejected this valid history
      const maximumGoalBytes = new Map<string, number>()
      for (const { goal } of [...history, superseded]) {
        const bytes = __herdrWorkEncodedBytesForTest(goal)
        maximumGoalBytes.set(goal.id, Math.max(maximumGoalBytes.get(goal.id) ?? 0, bytes))
      }
      const encodedGoals = [...maximumGoalBytes.values()].reduce((total, bytes) => total + bytes, 0)
      const separators = Math.max(0, maximumGoalBytes.size - 1)
      const maxEncodedId = Math.max(
        0,
        ...Array.from(maximumGoalBytes.keys(), (id) => __herdrWorkEncodedBytesForTest(id))
      )
      const oldFamiliesPerWindow = 2 * encodedGoals + separators +
        (maxEncodedId + 64) * Math.max(1, maximumGoalBytes.size)
      const oldEstimated = __herdrWorkSnapshotEnvelopeMaxBytesForTest +
        4 * Math.max(encodedGoals + separators, oldFamiliesPerWindow)
      expect(oldEstimated).toBeGreaterThan(fleetResponseBodyMaxBytes)
      expect(oldEstimated).toBeGreaterThan(estimated)
    }).pipe(provideNodeServices), 30_000)

  it.effect("rejects family snapshots where the canonical payload diverges from the active goal", () =>
    Effect.gen(function*() {
      const base = checkpointForGoal("goal-canonical-diverge", "event-base-diverge", 0, 0)
      const old = checkpointForGoal("goal-old-diverge", "event-old-diverge", 0, 0)
      const canonical = familyCheckpoint(
        base,
        "event-canonical-diverge",
        10,
        "goal-canonical-diverge",
        "canonical"
      )
      const superseded = familyCheckpoint(
        old,
        "event-superseded-diverge",
        10,
        "goal-canonical-diverge",
        "superseded"
      )
      const valid = yield* projectWorkSnapshots([base, old, canonical, superseded], 11)
      expect(Schema.decodeUnknownResult(WorkSnapshots)(valid)._tag).toBe("Success")
      // Legacy snapshot without families remains valid
      const { families: _legacyFamilies, ...legacyNow } = valid.now
      expect(Schema.decodeUnknownResult(WorkSnapshot)(legacyNow)._tag).toBe("Success")
      // Invalid: same id but different canonical payload (title) must be rejected
      const divergentCanonical = { ...valid.now.families![0]!.canonical, title: "stale title" }
      const divergentSnapshot = {
        ...valid.now,
        families: [{ ...valid.now.families![0]!, canonical: divergentCanonical }]
      }
      expect(Schema.decodeUnknownResult(WorkSnapshot)(divergentSnapshot)._tag).toBe("Failure")
      expect(
        Schema.decodeUnknownResult(WorkSnapshots)({ ...valid, now: divergentSnapshot })._tag
      ).toBe("Failure")
      // Invalid: family canonical id not in goals must also be rejected (id-only check)
      const orphanCanonical = {
        ...valid.now.families![0]!,
        canonicalGoalId: "goal-missing",
        canonical: { ...valid.now.families![0]!.canonical, id: "goal-missing", title: "goal-missing" }
      }
      const orphanSnapshot = { ...valid.now, families: [orphanCanonical] }
      expect(Schema.decodeUnknownResult(WorkSnapshot)(orphanSnapshot)._tag).toBe("Failure")
    }))

  it("rejects snapshot families that exceed the distinct goal union bound", () => {
    const canonicalBase = checkpointForGoal("goal-canonical-union", "event-canonical-union-base", 0, 0)
    const canonicalGoal: WorkGoal = {
      ...canonicalBase.goal,
      goalFamily: { canonicalGoalId: canonicalBase.goal.id, role: "canonical" }
    }
    const makeSuperseded = (index: number): WorkGoal => {
      const base = checkpointForGoal(`goal-superseded-${index}`, `event-superseded-${index}`, 0, 0)
      return {
        ...base.goal,
        goalFamily: { canonicalGoalId: canonicalGoal.id, role: "superseded" }
      }
    }
    const supersededMax = Array.from({ length: workSnapshotMaxGoals }, (_, index) => makeSuperseded(index))
    const snapshotTooLarge = {
      window: "now",
      observedAt: 0,
      asOf: 0,
      goals: [canonicalGoal],
      families: [{ canonicalGoalId: canonicalGoal.id, canonical: canonicalGoal, superseded: supersededMax }]
    }
    expect(Schema.decodeUnknownResult(WorkSnapshot)(snapshotTooLarge)._tag).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(WorkSnapshots)({
        observedAt: 0,
        now: snapshotTooLarge,
        day: { window: "day", observedAt: 0, asOf: 0, goals: [canonicalGoal] },
        week: { window: "week", observedAt: 0, asOf: 0, goals: [canonicalGoal] },
        month: { window: "month", observedAt: 0, asOf: 0, goals: [canonicalGoal] }
      })._tag
    ).toBe("Failure")

    const supersededWithin = Array.from(
      { length: workSnapshotMaxGoals - 1 },
      (_, index) => makeSuperseded(index)
    )
    const snapshotWithin = {
      window: "now",
      observedAt: 0,
      asOf: 0,
      goals: [canonicalGoal],
      families: [{ canonicalGoalId: canonicalGoal.id, canonical: canonicalGoal, superseded: supersededWithin }]
    }
    expect(Schema.decodeUnknownResult(WorkSnapshot)(snapshotWithin)._tag).toBe("Success")

    const legacyGoals = Array.from({ length: workSnapshotMaxGoals }, (_, index) => {
      const base = checkpointForGoal(`goal-legacy-${index}`, `event-legacy-${index}`, index, index)
      return base.goal
    })
    const legacySnapshot = {
      window: "now",
      observedAt: 0,
      asOf: 0,
      goals: legacyGoals
    }
    expect(Schema.decodeUnknownResult(WorkSnapshot)(legacySnapshot)._tag).toBe("Success")

    const emptyFamiliesSnapshot = {
      window: "now",
      observedAt: 0,
      asOf: 0,
      goals: [canonicalGoal],
      families: []
    }
    expect(Schema.decodeUnknownResult(WorkSnapshot)(emptyFamiliesSnapshot)._tag).toBe("Success")
  })

  it("rejects duplicate active goal IDs in snapshot", () => {
    const base = checkpointForGoal("goal-dup", "event-dup-base", 0, 0)
    const goalA: WorkGoal = { ...base.goal, title: "Alpha" }
    const goalB: WorkGoal = { ...base.goal, title: "Beta" }
    const duplicateSnapshot = {
      window: "now",
      observedAt: 0,
      asOf: 0,
      goals: [goalA, goalB]
    }
    expect(Schema.decodeUnknownResult(WorkSnapshot)(duplicateSnapshot)._tag).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(WorkSnapshots)({
        observedAt: 0,
        now: duplicateSnapshot,
        day: { window: "day", observedAt: 0, asOf: 0, goals: [goalA] },
        week: { window: "week", observedAt: 0, asOf: 0, goals: [goalA] },
        month: { window: "month", observedAt: 0, asOf: 0, goals: [goalA] }
      })._tag
    ).toBe("Failure")

    const canonicalBase = checkpointForGoal("goal-canonical-dup", "event-canonical-dup-base", 0, 0)
    const canonicalGoal: WorkGoal = {
      ...canonicalBase.goal,
      goalFamily: { canonicalGoalId: canonicalBase.goal.id, role: "canonical" }
    }
    const canonicalDupA: WorkGoal = { ...canonicalGoal, title: "Canonical Alpha" }
    const canonicalDupB: WorkGoal = { ...canonicalGoal, title: "Canonical Beta" }
    const duplicateCanonicalSnapshot = {
      window: "now",
      observedAt: 0,
      asOf: 0,
      goals: [canonicalDupA, canonicalDupB],
      families: [{ canonicalGoalId: canonicalGoal.id, canonical: canonicalDupB, superseded: [] }]
    }
    expect(Schema.decodeUnknownResult(WorkSnapshot)(duplicateCanonicalSnapshot)._tag).toBe("Failure")

    const distinctBase = checkpointForGoal("goal-distinct", "event-distinct-base", 0, 0)
    const distinctGoal: WorkGoal = { ...distinctBase.goal }
    const validSnapshot = {
      window: "now",
      observedAt: 0,
      asOf: 0,
      goals: [goalA, distinctGoal]
    }
    expect(Schema.decodeUnknownResult(WorkSnapshot)(validSnapshot)._tag).toBe("Success")
  })

  it("rejects empty superseded family groups", () => {
    const canonicalBase = checkpointForGoal("goal-canonical-empty", "event-canonical-empty-base", 0, 0)
    const canonicalGoal: WorkGoal = {
      ...canonicalBase.goal,
      goalFamily: { canonicalGoalId: canonicalBase.goal.id, role: "canonical" }
    }
    const emptyGroup = {
      canonicalGoalId: canonicalGoal.id,
      canonical: canonicalGoal,
      superseded: []
    }
    expect(Schema.decodeUnknownResult(WorkGoalFamilyGroup)(emptyGroup)._tag).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(WorkSnapshot)({
        window: "now",
        observedAt: 0,
        asOf: 0,
        goals: [canonicalGoal],
        families: [emptyGroup]
      })._tag
    ).toBe("Failure")
    const supersededBase = checkpointForGoal("goal-superseded-empty", "event-superseded-empty-base", 0, 0)
    const supersededGoal: WorkGoal = {
      ...supersededBase.goal,
      goalFamily: { canonicalGoalId: canonicalGoal.id, role: "superseded" }
    }
    const validGroup = {
      canonicalGoalId: canonicalGoal.id,
      canonical: canonicalGoal,
      superseded: [supersededGoal]
    }
    expect(Schema.decodeUnknownResult(WorkGoalFamilyGroup)(validGroup)._tag).toBe("Success")
    expect(
      Schema.decodeUnknownResult(WorkSnapshot)({
        window: "now",
        observedAt: 0,
        asOf: 0,
        goals: [canonicalGoal],
        families: [validGroup]
      })._tag
    ).toBe("Success")
    expect(
      Schema.decodeUnknownResult(WorkSnapshot)({
        window: "now",
        observedAt: 0,
        asOf: 0,
        goals: [supersededGoal]
      })._tag
    ).toBe("Failure")
  })
})
