import { WorkProjectionError } from "../errors.js"
import { validateGoalFamilyHistory } from "../goal-family.js"
import type { WorkGoalCheckpoint } from "../model.js"

const projectionError = (
  reason: WorkProjectionError["reason"],
  detail: string,
  cause: unknown
) => new WorkProjectionError({ cause, detail, reason })

/** Checks invariants spanning the complete decoded Work checkpoint history. */
export const workHistoryError = (
  events: ReadonlyArray<WorkGoalCheckpoint>
): WorkProjectionError | undefined => {
  const eventIds = new Set<string>()
  const goalTimes = new Set<string>()
  const createdAt = new Map<string, number>()
  const ordered = events.toSorted((left, right) => left.occurredAt - right.occurredAt)
  for (const event of ordered) {
    if (eventIds.has(event.eventId)) {
      return projectionError("duplicate_event", `work event ${event.eventId} occurs more than once`, event)
    }
    eventIds.add(event.eventId)
    const timeKey = `${event.goal.id}\u0000${event.occurredAt}`
    if (goalTimes.has(timeKey)) {
      return projectionError(
        "ambiguous_checkpoint",
        `goal ${event.goal.id} has more than one checkpoint at ${event.occurredAt}`,
        event
      )
    }
    goalTimes.add(timeKey)
    const firstCreatedAt = createdAt.get(event.goal.id)
    if (firstCreatedAt !== undefined && firstCreatedAt !== event.goal.createdAt) {
      return projectionError(
        "inconsistent_history",
        `goal ${event.goal.id} changed its creation timestamp`,
        event
      )
    }
    createdAt.set(event.goal.id, event.goal.createdAt)
  }
  for (const [goalId, timestamp] of createdAt) {
    if (!events.some((event) => event.goal.id === goalId && event.occurredAt === timestamp)) {
      return projectionError(
        "inconsistent_history",
        `goal ${goalId} has no checkpoint at its creation timestamp`,
        { goalId, timestamp }
      )
    }
  }
  return validateGoalFamilyHistory(events)
}
