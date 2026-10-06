/**
 * Browser-safe reads of a snapshot's observed overlay, for the Work tab. Imports
 * types only, so a view can use them without pulling in the store or Fleet.
 */
import type { WorkDisplayState, WorkGoal, WorkGoalObserved, WorkSnapshot } from "./model.js"

/** The overlay entry for one goal, or null when nothing was observed about it (or the overlay is absent). */
export const observedFor = (snapshot: Pick<WorkSnapshot, "observed">, goalId: string): WorkGoalObserved | null =>
  snapshot.observed?.find((entry) => entry.goalId === goalId) ?? null

/** What the tab shows for a goal: the overlay's display state when there is one, otherwise the goal's own state. */
export const displayStateOf = (snapshot: Pick<WorkSnapshot, "observed">, goal: WorkGoal): WorkDisplayState =>
  observedFor(snapshot, goal.id)?.displayState ?? goal.state
