import type { JobRecord, PendingApprovalCursor } from "@knpkv/herdr-fleet/model"
import { type Cause, Exit } from "effect"
import type {
  DashboardHistoryPage,
  DashboardSnapshot,
  FleetPendingApprovals,
  PendingApprovalContinuation,
  PendingApprovalTarget
} from "../dashboard-model.js"

export interface DashboardPendingState extends FleetPendingApprovals {
  readonly generation: number
}

export interface DashboardPendingRequest {
  readonly continuation: PendingApprovalContinuation
  readonly generation: number
}

export type DashboardPendingLoadResult<E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<E> }

export type PendingApprovalTargetRevalidation =
  | { readonly _tag: "Found"; readonly target: PendingApprovalTarget }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Retry" }

export interface DashboardHistoryState {
  readonly generation: number
  readonly nextCursor: PendingApprovalCursor | null
  readonly records: ReadonlyArray<JobRecord>
}

export interface DashboardHistoryRequest {
  readonly cursor: PendingApprovalCursor
  readonly generation: number
}

const sameContinuation = (
  left: PendingApprovalContinuation,
  right: PendingApprovalContinuation
): boolean =>
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.cursor.createdAt === right.cursor.createdAt &&
  left.cursor.id === right.cursor.id

const sameCursor = (left: PendingApprovalCursor, right: PendingApprovalCursor): boolean =>
  left.createdAt === right.createdAt && left.id === right.id

const requestedIndex = (
  state: DashboardPendingState,
  request: DashboardPendingRequest
): number =>
  state.generation === request.generation
    ? state.nextCursors.findIndex((candidate) => sameContinuation(candidate, request.continuation))
    : -1

export const dashboardPendingState = (
  generation: number,
  page: FleetPendingApprovals
): DashboardPendingState => ({
  ...page,
  generation
})

export const dashboardHistoryState = (
  generation: number,
  records: ReadonlyArray<JobRecord>,
  nextCursor: PendingApprovalCursor | null
): DashboardHistoryState => ({ generation, nextCursor, records })

export const mergeDashboardHistoryPage = (
  state: DashboardHistoryState,
  request: DashboardHistoryRequest,
  page: DashboardHistoryPage
): DashboardHistoryState =>
  state.generation !== request.generation ||
    state.nextCursor === null ||
    !sameCursor(state.nextCursor, request.cursor)
    ? state
    : {
      ...state,
      nextCursor: page.nextCursor,
      records: [...state.records, ...page.records]
    }

export const dashboardPendingBadgeCount = (state: FleetPendingApprovals): number | null =>
  state.nextCursors.length === 0 ? state.local.length + state.remote.length : null

export const pendingApprovalTargetAfterRevalidation = (
  current: PendingApprovalTarget | null,
  result: PendingApprovalTargetRevalidation
): PendingApprovalTarget | null => result._tag === "Found" ? result.target : result._tag === "Missing" ? null : current

export const dashboardHasPendingApprovalTarget = (
  snapshot: DashboardSnapshot,
  target: { readonly host: string; readonly jobId: string }
): boolean =>
  snapshot.pendingApprovals.local.some(
    ({ id }) => id === target.jobId && snapshot.host.toLowerCase() === target.host.toLowerCase()
  ) ||
  snapshot.pendingApprovals.remote.some(
    ({ approval, host }) => approval.id === target.jobId && host.toLowerCase() === target.host.toLowerCase()
  )

export const withPendingApprovalTarget = (
  snapshot: DashboardSnapshot,
  target: PendingApprovalTarget | null
): DashboardSnapshot => {
  if (target === null) return snapshot
  if (target._tag === "local") {
    return snapshot.pendingApprovals.local.some(({ id }) => id === target.record.id)
      ? snapshot
      : {
        ...snapshot,
        pendingApprovals: {
          ...snapshot.pendingApprovals,
          local: [...snapshot.pendingApprovals.local, target.record]
        }
      }
  }
  return snapshot.pendingApprovals.remote.some(
      ({ approval, host }) =>
        approval.id === target.remote.approval.id && host.toLowerCase() === target.remote.host.toLowerCase()
    )
    ? snapshot
    : {
      ...snapshot,
      pendingApprovals: {
        ...snapshot.pendingApprovals,
        remote: [...snapshot.pendingApprovals.remote, target.remote]
      }
    }
}

export const mergeDashboardPendingPage = (
  state: DashboardPendingState,
  request: DashboardPendingRequest,
  page: FleetPendingApprovals
): DashboardPendingState => {
  const index = requestedIndex(state, request)
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

export const rotateFailedDashboardPendingPage = (
  state: DashboardPendingState,
  request: DashboardPendingRequest
): DashboardPendingState => {
  const index = requestedIndex(state, request)
  if (index < 0 || state.nextCursors.length < 2) return state
  const failed = state.nextCursors[index]
  if (failed === undefined) return state
  return {
    ...state,
    nextCursors: [
      ...state.nextCursors.slice(0, index),
      ...state.nextCursors.slice(index + 1),
      failed
    ]
  }
}

export const loadDashboardPendingPage = async <E>(
  observedState: DashboardPendingState,
  load: (continuation: PendingApprovalContinuation) => Promise<Exit.Exit<FleetPendingApprovals, E>>,
  update: (transition: (state: DashboardPendingState) => DashboardPendingState) => void
): Promise<DashboardPendingLoadResult<E>> => {
  const continuation = observedState.nextCursors.at(0)
  if (continuation === undefined) return { _tag: "Idle" }
  const request = { continuation, generation: observedState.generation }
  const exit = await load(continuation)
  if (Exit.isFailure(exit)) {
    update((state) => rotateFailedDashboardPendingPage(state, request))
    return { _tag: "Failure", cause: exit.cause }
  }
  update((state) => mergeDashboardPendingPage(state, request, exit.value))
  return { _tag: "Success" }
}
