import { useState } from "react"
import type { DashboardSnapshot } from "../dashboard-model.js"
import { type DashboardPendingState, dashboardPendingState } from "./dashboard-pending-state.js"

/**
 * The page and its snapshot change together, before children can verify a queued decision.
 * A fresh read advances the continuation generation so late pages cannot reintroduce old requests.
 */
export const useDashboardPending = (snapshot: DashboardSnapshot) => {
  const [current, setCurrent] = useState(() => ({
    snapshot,
    pending: dashboardPendingState(0, snapshot.pendingApprovals)
  }))
  const pending = current.snapshot === snapshot
    ? current.pending
    : dashboardPendingState(current.pending.generation + 1, snapshot.pendingApprovals)
  if (current.snapshot !== snapshot) setCurrent({ snapshot, pending })
  const update = (transition: (state: DashboardPendingState) => DashboardPendingState): void => {
    setCurrent((state) => ({ ...state, pending: transition(state.pending) }))
  }
  return { state: pending, update }
}
