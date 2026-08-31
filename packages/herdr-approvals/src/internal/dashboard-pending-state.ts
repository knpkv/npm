import type { FleetPendingApprovals, PendingApprovalContinuation } from "../dashboard-model.js"

export interface DashboardPendingState extends FleetPendingApprovals {
  readonly generation: number
}

export interface DashboardPendingRequest {
  readonly continuation: PendingApprovalContinuation
  readonly generation: number
}

const sameContinuation = (
  left: PendingApprovalContinuation,
  right: PendingApprovalContinuation
): boolean =>
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.cursor.createdAt === right.cursor.createdAt &&
  left.cursor.id === right.cursor.id

export const dashboardPendingState = (
  generation: number,
  page: FleetPendingApprovals
): DashboardPendingState => ({
  ...page,
  generation
})

export const mergeDashboardPendingPage = (
  state: DashboardPendingState,
  request: DashboardPendingRequest,
  page: FleetPendingApprovals
): DashboardPendingState => {
  if (state.generation !== request.generation) return state
  const index = state.nextCursors.findIndex((candidate) => sameContinuation(candidate, request.continuation))
  if (index < 0) return state
  return {
    failures: [...state.failures, ...page.failures],
    generation: state.generation,
    local: [...state.local, ...page.local],
    nextCursors: [
      ...state.nextCursors.slice(0, index),
      ...page.nextCursors,
      ...state.nextCursors.slice(index + 1)
    ],
    remote: [...state.remote, ...page.remote]
  }
}
