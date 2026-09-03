import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  __herdrWorkEncodedBytesForTest,
  __herdrWorkMaximumSnapshotBytesForTest,
  __herdrWorkSnapshotEnvelopeMaxBytesForTest,
  makeWorkService,
  projectWorkSnapshots,
  type WorkGoal,
  WorkGoalCheckpoint,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  type WorkGoalFamily,
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
      const first = yield* WorkStore.open(path)
      for (const event of history) yield* first.append(event)
      first.close()
      const reopened = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => reopened.close()))
      expect(yield* reopened.list()).toEqual(history)
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
})
