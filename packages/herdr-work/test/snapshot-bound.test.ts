import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import type { WorkGoal, WorkGoalCheckpoint, WorkSnapshot, WorkSnapshotWindow } from "../src/model.js"
import { boundWorkSnapshotWindows, projectWorkSnapshots } from "../src/projection.js"

const checkpoint = (
  id: string,
  updatedAt: number,
  state: WorkGoal["state"],
  goalFamily?: WorkGoal["goalFamily"]
): WorkGoalCheckpoint => {
  const goal: WorkGoal = {
    blocker: null,
    connectTarget: null,
    createdAt: 0,
    delivery: "local",
    detail: "detail",
    id,
    owner: { id: "owner", name: "Owner" },
    repository: { branch: "main", repository: "knpkv/npm" },
    spend: null,
    state,
    summary: "summary",
    title: id,
    updatedAt
  }
  return {
    eventId: `event-${id}-${String(updatedAt)}`,
    goal: goalFamily === undefined ? goal : { ...goal, goalFamily },
    occurredAt: updatedAt,
    version: "herdr.work.event.v1"
  }
}

const created = (id: string): WorkGoalCheckpoint => ({
  ...checkpoint(id, 0, "planned"),
  eventId: `event-${id}-created`
})

const projected = (events: ReadonlyArray<WorkGoalCheckpoint>) =>
  projectWorkSnapshots(events, 1_000).pipe(Effect.map(({ day, month, now, week }) => ({ day, month, now, week })))

const ids = (goals: ReadonlyArray<WorkGoal>) => goals.map(({ id }) => id)
const size = (windows: Parameters<typeof boundWorkSnapshotWindows>[0]) =>
  new TextEncoder().encode(JSON.stringify(windows)).byteLength

describe("boundWorkSnapshotWindows", () => {
  it.effect("leaves a snapshot within budget untouched", () =>
    Effect.gen(function*() {
      const windows = yield* projected([created("a"), checkpoint("a", 10, "working")])
      expect(boundWorkSnapshotWindows(windows, size(windows))).toEqual(windows)
    }))

  it.effect("drops finished goals before open ones, the least recently updated first, and counts them", () =>
    Effect.gen(function*() {
      const windows = yield* projected([
        created("open-old"),
        checkpoint("open-old", 10, "working"),
        created("done-new"),
        checkpoint("done-new", 30, "completed"),
        created("done-old"),
        checkpoint("done-old", 20, "abandoned")
      ])
      const oneLess = boundWorkSnapshotWindows(windows, size(windows) - 1)
      expect(ids(oneLess.now.goals)).toEqual(["done-new", "open-old"])
      expect(oneLess.now.goalsOmitted).toBe(1)
      const twoLess = boundWorkSnapshotWindows(windows, size(oneLess) - 1)
      expect(ids(twoLess.now.goals)).toEqual(["open-old"])
      expect(twoLess.now.goalsOmitted).toBe(2)
    }))

  it.effect("keeps a family whole and drops lone goals first; a family leaves with its canonical goal", () =>
    Effect.gen(function*() {
      // Every window as `now`, so the family is a family everywhere.
      const { now } = yield* projected([
        created("canonical"),
        created("superseded"),
        checkpoint("canonical", 5, "working", { canonicalGoalId: "canonical", role: "canonical" }),
        checkpoint("superseded", 6, "working", { canonicalGoalId: "canonical", role: "superseded" }),
        created("lone"),
        checkpoint("lone", 50, "working")
      ])
      const as = (window: WorkSnapshotWindow): WorkSnapshot => ({ ...now, window })
      const windows = { now, day: as("day"), week: as("week"), month: as("month") }
      const withoutLone = boundWorkSnapshotWindows(windows, size(windows) - 1)
      expect(ids(withoutLone.now.goals)).toEqual(["canonical"])
      expect(withoutLone.now.families?.map(({ canonicalGoalId }) => canonicalGoalId)).toEqual(["canonical"])
      const empty = boundWorkSnapshotWindows(windows, 1)
      expect(empty.now.goals).toEqual([])
      expect(empty.now.families).toBeUndefined()
      expect(empty.now.goalsOmitted).toBe(2)
    }))
})
