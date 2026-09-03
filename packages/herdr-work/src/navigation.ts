import { Schema } from "effect"
import {
  WorkGoalId,
  type WorkGoalId as WorkGoalIdType,
  WorkSnapshotWindow,
  type WorkSnapshotWindow as WorkSnapshotWindowType
} from "./model.js"

export type WorkNavigationSelection = {
  readonly goalId: WorkGoalIdType | null
  readonly window: WorkSnapshotWindowType
}

/** Builds the same-origin URL used by the Work board for one selected goal. */
export const workNavigationHref = ({ goalId, window }: WorkNavigationSelection): string => {
  const parameters = new URLSearchParams({ tab: "work", window })
  if (goalId !== null) parameters.set("goal", goalId)
  return `/?${parameters.toString()}`
}

export const decodeWorkNavigationSelection = (search: string): WorkNavigationSelection => {
  const parameters = new URLSearchParams(search)
  const decodedWindow = Schema.decodeUnknownResult(WorkSnapshotWindow)(parameters.get("window") ?? "now")
  const goal = parameters.get("goal")
  const decodedGoal = goal === null ? null : Schema.decodeUnknownResult(WorkGoalId)(goal)
  return {
    goalId: decodedGoal !== null && decodedGoal._tag === "Success" ? decodedGoal.success : null,
    window: decodedWindow._tag === "Success" ? decodedWindow.success : "now"
  }
}
