import { WorkProjectionError } from "./errors.js"
import type { WorkGoalCheckpoint, WorkGoalFamily } from "./model.js"

const inconsistency = (detail: string, cause: WorkGoalCheckpoint) =>
  new WorkProjectionError({ cause, detail, reason: "inconsistent_history" })

export const validateGoalFamilyHistory = (
  events: ReadonlyArray<WorkGoalCheckpoint>
): WorkProjectionError | undefined => {
  const familyByGoal = new Map<string, WorkGoalFamily>()
  const canonicalActivatedAt = new Map<string, number>()
  const ordered = events.toSorted((left, right) => left.occurredAt - right.occurredAt)
  for (const event of ordered) {
    const family = event.goal.goalFamily
    const previousFamily = familyByGoal.get(event.goal.id)
    if (
      previousFamily !== undefined && (
        family === undefined ||
        family.canonicalGoalId !== previousFamily.canonicalGoalId ||
        family.role !== previousFamily.role
      )
    ) {
      return inconsistency(`goal ${event.goal.id} changed or removed its goal-family relation`, event)
    }
    if (family !== undefined) {
      familyByGoal.set(event.goal.id, family)
      if (family.role === "canonical" && !canonicalActivatedAt.has(event.goal.id)) {
        canonicalActivatedAt.set(event.goal.id, event.occurredAt)
      }
    }
  }
  for (const event of ordered) {
    const family = event.goal.goalFamily
    if (family?.role !== "superseded") continue
    const canonicalAt = canonicalActivatedAt.get(family.canonicalGoalId)
    if (canonicalAt === undefined || canonicalAt > event.occurredAt) {
      return inconsistency(
        `goal ${event.goal.id} was superseded before canonical goal ${family.canonicalGoalId} was recorded`,
        event
      )
    }
  }
}
