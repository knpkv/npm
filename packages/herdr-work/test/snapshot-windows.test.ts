import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  type WorkActivity,
  type WorkGoal,
  type WorkGoalCheckpoint,
  workSnapshotActivityMax,
  workSnapshotFinishedRetentionMs
} from "../src/model.js"
import { projectWorkSnapshots } from "../src/projection.js"

const HOUR = 60 * 60 * 1_000
const NOW = 40 * 24 * HOUR

const goalAt = (id: string, updatedAt: number, state: WorkGoal["state"]): WorkGoal => ({
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
})

const checkpoint = (goal: WorkGoal): WorkGoalCheckpoint => ({
  eventId: `event-${goal.id}-${String(goal.updatedAt)}`,
  goal,
  occurredAt: goal.updatedAt,
  version: "herdr.work.event.v1"
})

/** A goal created at 0 and moved to `state` at `updatedAt`. */
const history = (id: string, updatedAt: number, state: WorkGoal["state"]): ReadonlyArray<WorkGoalCheckpoint> => [
  checkpoint(goalAt(id, 0, "planned")),
  checkpoint(goalAt(id, updatedAt, state))
]

const activities = (count: number): ReadonlyArray<WorkActivity> =>
  Array.from({ length: count }, (_, index) => ({
    id: `activity-${String(index)}`,
    kind: "note",
    occurredAt: 1_000 + index,
    summary: `note ${String(index)}`
  }))

describe("snapshot windows", () => {
  it.effect("drop finished goals a day after they finished, counted per window; open and recent goals stay", () =>
    Effect.gen(function*() {
      const snapshots = yield* projectWorkSnapshots(
        [
          ...history("done-long-ago", NOW - workSnapshotFinishedRetentionMs - HOUR, "completed"),
          ...history("done-today", NOW - HOUR, "completed"),
          ...history("abandoned-long-ago", NOW - 3 * workSnapshotFinishedRetentionMs, "abandoned"),
          ...history("still-open", NOW - 10 * 24 * HOUR, "review")
        ],
        NOW
      )
      expect(snapshots.now.goals.map(({ id }) => id).toSorted()).toEqual(["done-today", "still-open"])
      expect(snapshots.now.finishedOmitted).toBe(2)
      // A day ago, "done-long-ago" had finished one hour before: still in that window.
      expect(snapshots.day.goals.map(({ id }) => id)).toContain("done-long-ago")
      expect(snapshots.day.finishedOmitted).toBe(1)
    }))

  it.effect("carry a goal's most recent activities, counting the rest, and keep its family valid", () =>
    Effect.gen(function*() {
      const canonical: WorkGoal = {
        ...goalAt("canonical", 10_000, "working"),
        activity: activities(workSnapshotActivityMax + 4),
        goalFamily: { canonicalGoalId: "canonical", role: "canonical" }
      }
      const superseded: WorkGoal = {
        ...goalAt("superseded", 10_001, "working"),
        goalFamily: { canonicalGoalId: "canonical", role: "superseded" }
      }
      const snapshots = yield* projectWorkSnapshots(
        [
          checkpoint(goalAt("canonical", 0, "planned")),
          checkpoint(goalAt("superseded", 0, "planned")),
          checkpoint(canonical),
          checkpoint(superseded)
        ],
        NOW
      )
      const listed = snapshots.now.goals.find(({ id }) => id === "canonical")
      expect(listed?.activity?.map(({ id }) => id)).toEqual(
        activities(workSnapshotActivityMax + 4).slice(4).map(({ id }) => id)
      )
      expect(snapshots.now.activityOmitted).toEqual({ canonical: 4 })
      // The group's canonical is the listed goal, trimmed the same way, so the snapshot still decodes.
      expect(snapshots.now.families?.[0]?.canonical).toEqual(listed)
    }))

  it.effect("say nothing when nothing was left out", () =>
    Effect.gen(function*() {
      const snapshots = yield* projectWorkSnapshots(history("open", NOW - HOUR, "working"), NOW)
      expect(snapshots.now.finishedOmitted).toBeUndefined()
      expect(snapshots.now.activityOmitted).toBeUndefined()
    }))
})
