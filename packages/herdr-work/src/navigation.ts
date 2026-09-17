import { Schema } from "effect"
import {
  WorkGoalId,
  type WorkGoalId as WorkGoalIdType,
  WorkSnapshotWindow,
  type WorkSnapshotWindow as WorkSnapshotWindowType,
  WorkState,
  type WorkState as WorkStateType
} from "./model.js"

// WorkGoalId is capped at 256 characters; 257 makes this transport namespace
// disjoint without reserving any otherwise-valid persisted goal identifier.
const workBoardNavigationGoalPrefix = "__work_board_v1__".padEnd(257, "_")
const WorkBoardNavigationStateParameters = Schema.Struct({
  detailsOpen: Schema.Literals(["0", "1"]),
  goalId: Schema.NullOr(WorkGoalId),
  statusFilter: Schema.Union([Schema.Literal("all"), WorkState]),
  visibleGoalCount: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 10, maximum: 2_048 })
  )
})

export interface WorkBoardNavigationState {
  readonly detailsOpen: boolean
  readonly goalId: WorkGoalIdType | null
  readonly statusFilter: "all" | WorkStateType
  readonly visibleGoalCount: number
}

export const encodeWorkBoardNavigationGoal = (state: WorkBoardNavigationState): string => {
  const parameters = new URLSearchParams({
    details: state.detailsOpen ? "1" : "0",
    status: state.statusFilter,
    visible: String(state.visibleGoalCount)
  })
  if (state.goalId !== null) parameters.set("goal", state.goalId)
  return `${workBoardNavigationGoalPrefix}${parameters.toString()}`
}

export const decodeWorkBoardNavigationGoal = (goalId: string | null): WorkBoardNavigationState | null => {
  if (goalId === null || !goalId.startsWith(workBoardNavigationGoalPrefix)) return null
  const parameters = new URLSearchParams(goalId.slice(workBoardNavigationGoalPrefix.length))
  const selectedGoalId = parameters.get("goal")
  const decoded = Schema.decodeUnknownResult(WorkBoardNavigationStateParameters)({
    detailsOpen: parameters.get("details"),
    goalId: selectedGoalId === "" ? null : selectedGoalId,
    statusFilter: parameters.get("status"),
    visibleGoalCount: parameters.get("visible")
  })
  return decoded._tag === "Success"
    ? { ...decoded.success, detailsOpen: decoded.success.detailsOpen === "1" }
    : null
}

export type WorkNavigationSelection = {
  readonly goalId: string | null
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
  const decodedBoardNavigation = decodeWorkBoardNavigationGoal(goal)
  const hasBoardNavigationPrefix = goal?.startsWith(workBoardNavigationGoalPrefix) ?? false
  return {
    goalId: decodedBoardNavigation !== null
      ? goal
      : hasBoardNavigationPrefix
      ? null
      : decodedGoal !== null && decodedGoal._tag === "Success"
      ? decodedGoal.success
      : null,
    window: decodedWindow._tag === "Success" ? decodedWindow.success : "now"
  }
}
