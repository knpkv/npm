import { Effect, Schema } from "effect"
import { WorkProjectionError } from "./errors.js"
import { validateGoalFamilyHistory } from "./goal-family.js"
import {
  type WorkGoal,
  WorkGoalCheckpoint,
  type WorkGoalFamilyGroup,
  workHistoryMaxEvents,
  type WorkSnapshot,
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
  const eventIds = new Set<string>()
  const goalTimes = new Set<string>()
  const createdAt = new Map<string, number>()
  const ordered = events.toSorted((left, right) => left.occurredAt - right.occurredAt)
  for (const event of ordered) {
    if (eventIds.has(event.eventId)) {
      return yield* projectionError("duplicate_event", `work event ${event.eventId} occurs more than once`, event)
    }
    eventIds.add(event.eventId)
    const timeKey = `${event.goal.id}\u0000${event.occurredAt}`
    if (goalTimes.has(timeKey)) {
      return yield* projectionError(
        "ambiguous_checkpoint",
        `goal ${event.goal.id} has more than one checkpoint at ${event.occurredAt}`,
        event
      )
    }
    goalTimes.add(timeKey)
    const firstCreatedAt = createdAt.get(event.goal.id)
    if (firstCreatedAt !== undefined && firstCreatedAt !== event.goal.createdAt) {
      return yield* projectionError(
        "inconsistent_history",
        `goal ${event.goal.id} changed its creation timestamp`,
        event
      )
    }
    createdAt.set(event.goal.id, event.goal.createdAt)
  }
  for (const [goalId, timestamp] of createdAt) {
    if (!events.some((event) => event.goal.id === goalId && event.occurredAt === timestamp)) {
      return yield* projectionError(
        "inconsistent_history",
        `goal ${goalId} has no checkpoint at its creation timestamp`,
        { goalId, timestamp }
      )
    }
  }
  const familyError = validateGoalFamilyHistory(events)
  if (familyError !== undefined) return yield* familyError
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

export const projectWorkSnapshots = Effect.fn("HerdrWork.projectSnapshots")(function*(
  input: ReadonlyArray<WorkGoalCheckpoint>,
  observedAt: number
) {
  const timestamp = yield* Schema.decodeUnknownEffect(WorkSnapshots.fields.observedAt)(observedAt).pipe(
    Effect.mapError((cause) => projectionError("malformed", "work observation timestamp is malformed", cause))
  )
  const events = yield* validateHistory(input)
  return yield* Schema.decodeUnknownEffect(WorkSnapshots)({
    observedAt: timestamp,
    now: snapshotAt(events, timestamp, "now"),
    day: snapshotAt(events, timestamp, "day"),
    week: snapshotAt(events, timestamp, "week"),
    month: snapshotAt(events, timestamp, "month")
  }).pipe(
    Effect.mapError((cause) => projectionError("malformed", "work snapshots could not be encoded", cause))
  )
})
