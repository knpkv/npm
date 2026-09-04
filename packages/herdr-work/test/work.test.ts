import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Effect, Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { execPath } from "node:process"
import { DatabaseSync } from "node:sqlite"
import {
  makeWorkService,
  projectWorkSnapshots,
  type WorkDecisionHandoff,
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
  __herdrWorkMaximumSnapshotBytesForTest,
  __herdrWorkSnapshotEnvelopeMaxBytesForTest
} from "../src/store.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const openScopedStore = (path: string) =>
  Effect.gen(function*() {
    const store = yield* WorkStore.open(path)
    let open = true
    const close = () => {
      if (open) {
        open = false
        store.close()
      }
    }
    yield* Effect.addFinalizer(() => Effect.sync(close))
    return { close, store }
  })

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

describe("durable Work projection", () => {
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
      const store = yield* WorkStore.open(path)
      store.close()

      const legacyEvents = history.slice(0, 2)
      const database = new DatabaseSync(path)
      database.prepare(
        "INSERT INTO work_goal_transactions (transaction_id, record) VALUES (?, ?)"
      ).run("transaction-legacy", JSON.stringify(legacyEvents))
      database.close()

      const missingStore = yield* WorkStore.open(path)
      const missingService = yield* makeWorkService(missingStore)
      expect(yield* Effect.result(missingService.recordMany("transaction-legacy", legacyEvents))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-legacy" }
      })
      expect(yield* missingStore.list()).toEqual([])
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

      const corruptedStore = yield* WorkStore.open(path)
      const corruptedService = yield* makeWorkService(corruptedStore)
      expect(yield* Effect.result(corruptedService.recordMany("transaction-legacy", legacyEvents))).toMatchObject({
        failure: { _tag: "WorkTransactionConflictError", transactionId: "transaction-legacy" }
      })
      corruptedStore.close()

      const restored = new DatabaseSync(path)
      restored.prepare(
        "UPDATE work_goal_events SET goal_id = ?, occurred_at = ? WHERE event_id = ?"
      ).run(driftedEvent.goal.id, driftedEvent.occurredAt, driftedEvent.eventId)
      restored.close()

      const completeStore = yield* WorkStore.open(path)
      const completeService = yield* makeWorkService(completeStore)
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
      expect(yield* completeStore.list()).toEqual(legacyEvents)
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
          head: "0123456789012345678901234567890123456789",
          laneId: "goal-busy-timeout",
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
      const store = yield* WorkStore.open(path)
      store.close()

      const handoff: WorkDecisionHandoff = {
        decision: "handoff",
        goalId: "goal-decision-cap",
        id: "handoff-overflow",
        laneId: "goal-decision-cap",
        occurredAt: 0,
        owner: { id: "owner-packages", name: "Package owner" },
        summary: "x".repeat(4_096),
        version: "herdr.work.decision.v1"
      }
      const database = new DatabaseSync(path)
      database.exec("BEGIN IMMEDIATE")
      const insert = database.prepare(
        "INSERT INTO work_decision_handoffs (handoff_id, lane_id, occurred_at, record) VALUES (?, ?, ?, ?)"
      )
      for (let index = 0; index < 500; index++) {
        const seeded = { ...handoff, id: `handoff-seed-${index}`, occurredAt: index }
        insert.run(seeded.id, seeded.laneId, seeded.occurredAt, JSON.stringify(seeded))
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
        decision: "handoff",
        goalId: "lane-\uFFFD",
        id: "handoff-replacement-lane",
        laneId: "lane-\uFFFD",
        occurredAt: 0,
        owner: { id: "owner-packages", name: "Package owner" },
        summary: "Replacement character remains a valid distinct lane",
        version: "herdr.work.decision.v1"
      }
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
        head: "0123456789012345678901234567890123456789",
        laneId: "goal-packages",
        owner: { id: "owner-packages", name: "Package owner" },
        parent: null,
        phase: "implementation",
        worktree: "/home/konopkov/Work/dev/knpkv.dev/worktrees/npm/feat-durable-work"
      }
      expect(yield* service.claim(claim)).toMatchObject({ revision: 1, head: claim.head })
      const current = yield* service.currentClaim(claim.laneId)
      expect(Option.isSome(current)).toBe(true)
      if (Option.isSome(current)) expect(current.value).toMatchObject({ revision: 1, head: claim.head })
      expect(yield* Effect.result(service.claim(claim))).toMatchObject({
        failure: { _tag: "WorkLaneClaimConflictError", actualRevision: 1 }
      })
      const next = yield* service.claim({ ...claim, expectedRevision: 1, phase: "validation" })
      expect(next.revision).toBe(2)
      const updated = yield* service.currentClaim(claim.laneId)
      expect(Option.isSome(updated)).toBe(true)
      if (Option.isSome(updated)) expect(updated.value).toMatchObject({ revision: 2, phase: "validation" })
      const handoff: WorkDecisionHandoff = {
        decision: "handoff",
        goalId: "goal-packages",
        id: "handoff-1",
        laneId: "goal-packages",
        occurredAt: 1,
        owner: claim.owner,
        summary: "Coordinator owns release verification",
        version: "herdr.work.decision.v1"
      }
      expect(yield* service.handoff(handoff)).toEqual(handoff)
      expect(yield* service.handoff(handoff)).toEqual(handoff)
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

  it.effect("rejects denormalized handoff identity drift and preserves decision ordering", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "herdr-work-decision-denormalized-"))
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(directory, { force: true, recursive: true })))
      const path = join(directory, "work.sqlite")
      const store = yield* WorkStore.open(path)
      store.close()
      const first: WorkDecisionHandoff = {
        decision: "handoff",
        goalId: "goal-decision-identity",
        id: "handoff-record-1",
        laneId: "goal-decision-identity",
        occurredAt: 1,
        owner: { id: "owner-packages", name: "Package owner" },
        summary: "First handoff",
        version: "herdr.work.decision.v1"
      }
      const database = new DatabaseSync(path)
      database.prepare(
        "INSERT INTO work_decision_handoffs (handoff_id, lane_id, occurred_at, record) VALUES (?, ?, ?, ?)"
      ).run("handoff-row-1", first.laneId, 2, JSON.stringify(first))
      database.close()

      const mismatchedStore = yield* WorkStore.open(path)
      const mismatchedService = yield* makeWorkService(mismatchedStore)
      expect(yield* Effect.result(mismatchedService.decisions(first.laneId))).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "decisions.decode.identity-mismatch" }
      })
      mismatchedStore.close()

      const replay = {
        ...first,
        goalId: "goal-decision-replay",
        id: "handoff-replay",
        laneId: "goal-decision-replay",
        occurredAt: 3
      }
      const replaySeed = new DatabaseSync(path)
      replaySeed.prepare(
        "INSERT INTO work_decision_handoffs (handoff_id, lane_id, occurred_at, record) VALUES (?, ?, ?, ?)"
      ).run(replay.id, "foreign-lane", 4, JSON.stringify(replay))
      replaySeed.close()
      const replayStore = yield* WorkStore.open(path)
      const replayService = yield* makeWorkService(replayStore)
      expect(yield* Effect.result(replayService.handoff(replay))).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "decision.decode.identity-mismatch" }
      })
      replayStore.close()

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
      repaired.prepare(
        "UPDATE work_decision_handoffs SET handoff_id = ?, occurred_at = ? WHERE handoff_id = ?"
      ).run(first.id, first.occurredAt, "handoff-row-1")
      const second = { ...first, id: "handoff-record-2", occurredAt: 2, summary: "Second handoff" }
      repaired.prepare(
        "INSERT INTO work_decision_handoffs (handoff_id, lane_id, occurred_at, record) VALUES (?, ?, ?, ?)"
      ).run(second.id, second.laneId, second.occurredAt, JSON.stringify(second))
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
        head: "0123456789012345678901234567890123456789",
        laneId: "goal-lane-cap",
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
        "INSERT INTO work_lane_claims (lane_id, revision, record) VALUES (?, ?, ?)"
      )
      for (let index = 0; index < workSnapshotMaxGoals - 1; index++) {
        const laneId = `goal-lane-seed-${index}`
        insert.run(laneId, 1, JSON.stringify({ ...claim, laneId, revision: 1 }))
      }
      database.close()

      yield* Effect.acquireUseRelease(
        WorkStore.open(path),
        (store) =>
          Effect.gen(function*() {
            const service = yield* makeWorkService(store)
            expect(yield* Effect.result(service.claim({ ...claim, laneId: "goal-lane-overflow" }))).toMatchObject({
              failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
            })
            expect(yield* service.claim({ ...claim, expectedRevision: 1, phase: "validation" })).toMatchObject({
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
        "INSERT INTO work_lane_claims (lane_id, revision, record) VALUES (?, ?, ?)"
      )
      const largeOwner = { id: "owner-packages", name: "x".repeat(4_096) }
      for (let index = 0; index < 500; index++) {
        const laneId = `goal-lane-bytes-${index}`
        bytesInsert.run(
          laneId,
          1,
          JSON.stringify({ ...claim, laneId, owner: largeOwner, revision: 1 })
        )
      }
      bytesDatabase.close()

      yield* Effect.acquireUseRelease(
        WorkStore.open(bytesPath),
        (store) =>
          Effect.gen(function*() {
            const service = yield* makeWorkService(store)
            expect(yield* Effect.result(service.claim({ ...claim, laneId: "goal-lane-bytes-overflow" }))).toMatchObject(
              {
                failure: { _tag: "WorkProjectionError", reason: "capacity_exceeded" }
              }
            )
          }),
        (store) => Effect.sync(() => store.close())
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
        head: "a".repeat(64),
        laneId: "goal-restart",
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
          return yield* service.currentClaim(claim.laneId)
        })
      )
      expect(Option.isSome(current)).toBe(true)
      if (Option.isSome(current)) expect(current.value).toEqual(claimed)
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
      database.prepare(
        "INSERT INTO work_lane_claims (lane_id, revision, record) VALUES (?, ?, ?)"
      ).run(
        "goal-key",
        1,
        JSON.stringify({ ...claim, laneId: "goal-record", revision: 1 })
      )
      database.prepare(
        "INSERT INTO work_lane_claims (lane_id, revision, record) VALUES (?, ?, ?)"
      ).run(
        "goal-revision",
        1,
        JSON.stringify({ ...claim, laneId: "goal-revision", expectedRevision: 1, revision: 2 })
      )
      database.prepare(
        "INSERT INTO work_lane_claims (lane_id, revision, record) VALUES (?, ?, ?)"
      ).run("goal-malformed", 1, "not-json")
      const mismatchedHandoff: WorkDecisionHandoff = {
        decision: "handoff",
        goalId: "goal-record",
        id: "handoff-mismatched-lane",
        laneId: "goal-record",
        occurredAt: 2,
        owner: claim.owner,
        summary: "Mismatched lane fixture",
        version: "herdr.work.decision.v1"
      }
      database.prepare(
        "INSERT INTO work_decision_handoffs (handoff_id, lane_id, occurred_at, record) VALUES (?, ?, ?, ?)"
      ).run(mismatchedHandoff.id, "goal-key", mismatchedHandoff.occurredAt, JSON.stringify(mismatchedHandoff))
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
        failure: { _tag: "WorkStoreError", operation: "claim.read.lane-mismatch" }
      })
      const writeMismatches = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* WorkStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
          const service = yield* makeWorkService(store)
          return yield* Effect.all([
            Effect.result(service.claim({ ...claim, laneId: "goal-key", expectedRevision: 1 })),
            Effect.result(service.claim({ ...claim, laneId: "goal-revision", expectedRevision: 1 })),
            Effect.result(service.claim({ ...claim, laneId: "goal-malformed", expectedRevision: 1 }))
          ])
        })
      )
      expect(writeMismatches).toMatchObject([
        { failure: { _tag: "WorkStoreError", operation: "claim.write.inconsistent" } },
        { failure: { _tag: "WorkStoreError" } },
        { failure: { _tag: "WorkStoreError" } }
      ])
      const decisionMismatch = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* WorkStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
          const service = yield* makeWorkService(store)
          return yield* Effect.result(service.decisions("goal-key"))
        })
      )
      expect(decisionMismatch).toMatchObject({
        failure: { _tag: "WorkStoreError", operation: "decisions.decode.lane-mismatch" }
      })
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
  })
})
