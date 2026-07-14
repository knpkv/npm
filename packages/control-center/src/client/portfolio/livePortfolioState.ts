import type { PortfolioSnapshot } from "../../api/portfolio.js"
import type { EventCursor } from "../../domain/identifiers.js"

export type PortfolioLoadFailure = "blocked" | "session-expired" | "unavailable"

export type PortfolioConnectionState =
  | { readonly _tag: "connecting" }
  | { readonly _tag: "connected" }
  | { readonly _tag: "reconnecting"; readonly attempt: number }
  | { readonly _tag: "offline" }

export type PortfolioSnapshotLoadState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "loading"; readonly sessionKey: string }
  | {
    readonly _tag: "loaded"
    readonly awaitingResetSnapshot: boolean
    readonly connection: PortfolioConnectionState
    readonly isSnapshotStale: boolean
    readonly minimumRefreshCursor: EventCursor | null
    readonly sessionKey: string
    readonly snapshot: PortfolioSnapshot
  }
  | { readonly _tag: "failed"; readonly sessionKey: string; readonly failure: PortfolioLoadFailure }

export type PortfolioLiveStateAction =
  | { readonly _tag: "begin"; readonly sessionKey: string }
  | { readonly _tag: "initial-snapshot"; readonly sessionKey: string; readonly snapshot: PortfolioSnapshot }
  | { readonly _tag: "caught-up" }
  | { readonly _tag: "stream-snapshot"; readonly snapshot: PortfolioSnapshot }
  | { readonly _tag: "invalidated"; readonly eventCursor: EventCursor }
  | { readonly _tag: "reset-required"; readonly headCursor: EventCursor }
  | { readonly _tag: "reconnecting"; readonly attempt: number }
  | { readonly _tag: "offline" }
  | { readonly _tag: "failed"; readonly sessionKey: string; readonly failure: PortfolioLoadFailure }
  | { readonly _tag: "clear" }

const laterCursor = (left: EventCursor | null, right: EventCursor): EventCursor =>
  left === null || right > left ? right : left

/** Reduce portfolio transport facts without ever replacing a snapshot from an invalidation event. */
export const reducePortfolioLiveState = (
  state: PortfolioSnapshotLoadState,
  action: PortfolioLiveStateAction
): PortfolioSnapshotLoadState => {
  switch (action._tag) {
    case "clear":
      return { _tag: "idle" }
    case "begin":
      return { _tag: "loading", sessionKey: action.sessionKey }
    case "failed":
      return { _tag: "failed", sessionKey: action.sessionKey, failure: action.failure }
    case "initial-snapshot":
      return {
        _tag: "loaded",
        awaitingResetSnapshot: false,
        connection: { _tag: "connecting" },
        isSnapshotStale: false,
        minimumRefreshCursor: null,
        sessionKey: action.sessionKey,
        snapshot: action.snapshot
      }
    case "caught-up":
      if (state._tag !== "loaded") return state
      if (
        state.awaitingResetSnapshot ||
        (state.minimumRefreshCursor !== null && state.minimumRefreshCursor > state.snapshot.eventCursor)
      ) {
        return state
      }
      return {
        ...state,
        awaitingResetSnapshot: false,
        connection: { _tag: "connected" },
        isSnapshotStale: false,
        minimumRefreshCursor: null
      }
    case "stream-snapshot":
      if (state._tag !== "loaded") return state
      if (state.minimumRefreshCursor !== null && action.snapshot.eventCursor < state.minimumRefreshCursor) return state
      if (!state.awaitingResetSnapshot && action.snapshot.eventCursor < state.snapshot.eventCursor) return state
      return {
        ...state,
        awaitingResetSnapshot: false,
        connection: { _tag: "connected" },
        isSnapshotStale: false,
        minimumRefreshCursor: null,
        snapshot: action.snapshot
      }
    case "invalidated":
      if (
        state._tag !== "loaded" ||
        state.awaitingResetSnapshot ||
        action.eventCursor <= state.snapshot.eventCursor
      ) {
        return state
      }
      return {
        ...state,
        isSnapshotStale: true,
        minimumRefreshCursor: laterCursor(state.minimumRefreshCursor, action.eventCursor)
      }
    case "reset-required":
      if (state._tag !== "loaded") return state
      return {
        ...state,
        awaitingResetSnapshot: true,
        isSnapshotStale: true,
        minimumRefreshCursor: laterCursor(state.minimumRefreshCursor, action.headCursor)
      }
    case "reconnecting":
      if (state._tag !== "loaded") return state
      return {
        ...state,
        connection: { _tag: "reconnecting", attempt: action.attempt },
        isSnapshotStale: true
      }
    case "offline":
      if (state._tag !== "loaded") return state
      return {
        ...state,
        connection: { _tag: "offline" },
        isSnapshotStale: true
      }
  }
}

/** Read the only cursor safe to acknowledge when reconnecting. */
export const appliedPortfolioCursor = (state: PortfolioSnapshotLoadState): EventCursor | null =>
  state._tag === "loaded" ? state.snapshot.eventCursor : null
