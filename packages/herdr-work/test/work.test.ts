import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  makeWorkService,
  projectWorkSnapshots,
  type WorkGoal,
  WorkGoalCheckpoint,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  workHistoryMaxEvents,
  workSnapshotMaxGoals,
  WorkStore
} from "../src/index.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const day = 24 * 60 * 60 * 1_000

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

describe("durable Work projection", () => {
  it.effect("secures a pre-existing state directory before opening SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-work-mode-test-"))
    const stateDirectory = join(root, "state")
    mkdirSync(stateDirectory, { mode: 0o755 })
    return Effect.acquireUseRelease(
      WorkStore.open(join(stateDirectory, "work.sqlite")),
      () =>
        Effect.sync(() => {
          if (platform() !== "win32") {
            expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
          }
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

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
      const first = yield* WorkStore.open(path)
      for (const event of history) yield* first.append(event)
      first.close()
      const reopened = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => reopened.close()))
      expect(yield* reopened.list()).toEqual(history)
    }).pipe(provideNodeServices))

  it.effect("fails a duplicate checkpoint without replacing the durable event", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-conflict-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const store = yield* WorkStore.open(join(directory, "work.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      yield* store.append(history[0])
      const duplicate = yield* Effect.result(store.append(history[0]))
      expect(duplicate).toMatchObject({
        failure: { _tag: "WorkCheckpointConflictError", eventId: "event-created" }
      })
      expect(yield* store.list()).toEqual([history[0]])
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
})
