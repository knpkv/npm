import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import { WorkProjectionError } from "./errors.js"
import { workHistoryError } from "./internal/history-validation.js"
import {
  isTerminalWorkState,
  type WorkGoal,
  WorkGoalCheckpoint,
  type WorkGoalFamilyGroup,
  workHistoryMaxEvents,
  type WorkSnapshot,
  workSnapshotMaxGoals,
  WorkSnapshots,
  type WorkSnapshotWindow
} from "./model.js"

const windowOffset = {
  now: 0,
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  month: 30 * 24 * 60 * 60 * 1_000
} satisfies Readonly<Record<WorkSnapshotWindow, number>>

const compareString = (left: string, right: string): number => {
  let li = 0
  let ri = 0
  const leftLength = left.length
  const rightLength = right.length
  while (li < leftLength && ri < rightLength) {
    const leftCode = left.codePointAt(li)
    const rightCode = right.codePointAt(ri)
    if (leftCode === undefined || rightCode === undefined) break
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1
    li += leftCode > 0xffff ? 2 : 1
    ri += rightCode > 0xffff ? 2 : 1
  }
  if (li >= leftLength && ri >= rightLength) return 0
  return li >= leftLength ? -1 : 1
}

const projectionError = (
  reason: WorkProjectionError["reason"],
  detail: string,
  cause: unknown
) => new WorkProjectionError({ cause, detail, reason })

const validateHistory = Effect.fn("HerdrWork.validateHistory")(function*(
  input: ReadonlyArray<WorkGoalCheckpoint>
) {
  const events = yield* Schema.decodeUnknownEffect(
    Schema.Array(WorkGoalCheckpoint).check(Schema.isMaxLength(workHistoryMaxEvents))
  )(input).pipe(
    Effect.mapError((cause) => projectionError("malformed", "work checkpoint history is malformed", cause))
  )
  const historyError = workHistoryError(events)
  if (historyError !== undefined) return yield* historyError
  return events
})

const familiesFor = (latest: ReadonlyMap<string, WorkGoal>): ReadonlyArray<WorkGoalFamilyGroup> => {
  const canonicalById = new Map<string, WorkGoal>()
  for (const goal of latest.values()) {
    if (goal.goalFamily?.role === "canonical") canonicalById.set(goal.id, goal)
  }
  const groups: Array<WorkGoalFamilyGroup> = []
  for (const canonical of canonicalById.values()) {
    const superseded = [...latest.values()]
      .filter(
        (goal): goal is WorkGoal =>
          goal.goalFamily?.role === "superseded" &&
          goal.goalFamily.canonicalGoalId === canonical.id
      )
      .toSorted(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          compareString(left.title, right.title) ||
          compareString(left.id, right.id)
      )
    if (superseded.length === 0) continue
    groups.push({
      canonicalGoalId: canonical.id,
      canonical,
      superseded
    })
  }
  return groups.toSorted(
    (left, right) =>
      right.canonical.updatedAt - left.canonical.updatedAt ||
      compareString(left.canonical.title, right.canonical.title) ||
      compareString(left.canonicalGoalId, right.canonicalGoalId)
  )
}

const snapshotAt = (
  events: ReadonlyArray<WorkGoalCheckpoint>,
  observedAt: number,
  window: WorkSnapshotWindow
): WorkSnapshot => {
  const asOf = Math.max(0, observedAt - windowOffset[window])
  const latest = new Map<string, WorkGoal>()
  for (const event of events.toSorted((left, right) => left.occurredAt - right.occurredAt)) {
    if (event.occurredAt <= asOf) latest.set(event.goal.id, event.goal)
  }
  const families = familiesFor(latest)
  const goals = [...latest.values()]
    .filter((goal) => goal.goalFamily?.role !== "superseded")
    .toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        compareString(left.title, right.title) ||
        compareString(left.id, right.id)
    )
  if (families.length > 0) {
    return {
      window,
      observedAt,
      asOf,
      goals,
      families
    }
  }
  return {
    window,
    observedAt,
    asOf,
    goals
  }
}

/**
 * The encoded size the projected goals may take: the Fleet response limit, less
 * a quarter kept for the `now` window's observed facts and activity provenance,
 * which are added on top and trim themselves to what is left.
 */
export const workSnapshotGoalBudgetBytes = Math.floor(fleetResponseBodyMaxBytes * 3 / 4)

const utf8 = new TextEncoder()

const windows: ReadonlyArray<WorkSnapshotWindow> = ["now", "day", "week", "month"]
type Windows = { readonly [W in WorkSnapshotWindow]: WorkSnapshot }

const encodedBytes = (value: Windows | WorkGoal | WorkGoalFamilyGroup): number =>
  utf8.encode(JSON.stringify(value)).byteLength

/**
 * What can leave the snapshots together: a goal on its own, or a family's
 * canonical goal with its group, so a window never shows a group without its
 * canonical goal.
 */
interface OmissionUnit {
  readonly goalId: string
  readonly terminal: boolean
  readonly updatedAt: number
}

/**
 * Drops whole goals until every window holds at most `workSnapshotMaxGoals`
 * goals (counting superseded family members) and the windows together encode
 * within `budgetBytes`. Finished goals leave first, the least recently updated
 * first; family goals leave after every lone goal. Each window counts what it
 * lost in `goalsOmitted`. Size is bounded here, at read time, so recording a
 * goal never fails because the board has grown.
 */
export const boundWorkSnapshotWindows = (projected: Windows, budgetBytes: number): Windows => {
  const latest = new Map<string, WorkGoal>()
  const familyIds = new Set<string>()
  for (const window of windows) {
    for (const goal of projected[window].goals) {
      const seen = latest.get(goal.id)
      if (seen === undefined || seen.updatedAt < goal.updatedAt) latest.set(goal.id, goal)
    }
    for (const group of projected[window].families ?? []) familyIds.add(group.canonicalGoalId)
  }
  const units: ReadonlyArray<OmissionUnit> = [...latest.values()]
    .map((goal) => ({ goalId: goal.id, terminal: isTerminalWorkState(goal.state), updatedAt: goal.updatedAt }))
    .toSorted((left, right) =>
      Number(familyIds.has(left.goalId)) - Number(familyIds.has(right.goalId)) ||
      Number(right.terminal) - Number(left.terminal) ||
      left.updatedAt - right.updatedAt ||
      compareString(left.goalId, right.goalId)
    )
  const without = (omitted: ReadonlySet<string>): Windows => {
    const bound = (snapshot: WorkSnapshot): WorkSnapshot => {
      const { families, goalsOmitted: _previous, ...rest } = snapshot
      const goals = snapshot.goals.filter(({ id }) => !omitted.has(id))
      const kept = (families ?? []).filter(({ canonicalGoalId }) => !omitted.has(canonicalGoalId))
      const lost = snapshot.goals.length - goals.length
      const base: WorkSnapshot = { ...rest, goals }
      const grouped: WorkSnapshot = kept.length > 0 ? { ...base, families: kept } : base
      return lost > 0 ? { ...grouped, goalsOmitted: lost } : grouped
    }
    return {
      now: bound(projected.now),
      day: bound(projected.day),
      week: bound(projected.week),
      month: bound(projected.month)
    }
  }
  const fits = (bounded: Windows): boolean =>
    windows.every((window) =>
      bounded[window].goals.length +
          (bounded[window].families ?? []).reduce((sum, group) => sum + group.superseded.length, 0) <=
        workSnapshotMaxGoals
    ) && encodedBytes(bounded) <= budgetBytes
  // Estimate from each goal's own encoding and each window's count, then
  // confirm against the real encoding and drop more if the estimate was short.
  const goalBytes = new Map<string, number>()
  const goalWindows = new Map<string, Array<WorkSnapshotWindow>>()
  const counts = new Map<WorkSnapshotWindow, number>()
  for (const window of windows) {
    const supersededCount = (projected[window].families ?? []).reduce((sum, group) => sum + group.superseded.length, 0)
    counts.set(window, projected[window].goals.length + supersededCount)
    for (const goal of projected[window].goals) {
      goalBytes.set(goal.id, (goalBytes.get(goal.id) ?? 0) + encodedBytes(goal) + 1)
      goalWindows.set(goal.id, [...(goalWindows.get(goal.id) ?? []), window])
    }
    for (const group of projected[window].families ?? []) {
      goalBytes.set(group.canonicalGoalId, (goalBytes.get(group.canonicalGoalId) ?? 0) + encodedBytes(group) + 1)
    }
  }
  const supersededOf = (window: WorkSnapshotWindow, goalId: string): number =>
    projected[window].families?.find(({ canonicalGoalId }) => canonicalGoalId === goalId)?.superseded.length ?? 0
  const overCount = (): boolean => windows.some((window) => (counts.get(window) ?? 0) > workSnapshotMaxGoals)
  const omitted = new Set<string>()
  let estimate = encodedBytes(projected)
  let next = 0
  let bounded = projected
  while (!fits(bounded) && next < units.length) {
    do {
      const unit = units[next]
      next += 1
      if (unit === undefined) break
      omitted.add(unit.goalId)
      estimate -= goalBytes.get(unit.goalId) ?? 0
      for (const window of goalWindows.get(unit.goalId) ?? []) {
        counts.set(window, (counts.get(window) ?? 0) - 1 - supersededOf(window, unit.goalId))
      }
    } while ((estimate > budgetBytes || overCount()) && next < units.length)
    bounded = without(omitted)
    estimate = encodedBytes(bounded)
  }
  return bounded
}

export const projectWorkSnapshots = Effect.fn("HerdrWork.projectSnapshots")(function*(
  input: ReadonlyArray<WorkGoalCheckpoint>,
  observedAt: number
) {
  const timestamp = yield* Schema.decodeUnknownEffect(WorkSnapshots.fields.observedAt)(observedAt).pipe(
    Effect.mapError((cause) => projectionError("malformed", "work observation timestamp is malformed", cause))
  )
  const events = yield* validateHistory(input)
  const bounded = boundWorkSnapshotWindows(
    {
      now: snapshotAt(events, timestamp, "now"),
      day: snapshotAt(events, timestamp, "day"),
      week: snapshotAt(events, timestamp, "week"),
      month: snapshotAt(events, timestamp, "month")
    },
    workSnapshotGoalBudgetBytes
  )
  return yield* Schema.decodeUnknownEffect(WorkSnapshots)({ observedAt: timestamp, ...bounded }).pipe(
    Effect.mapError((cause) => projectionError("malformed", "work snapshots could not be encoded", cause))
  )
})
