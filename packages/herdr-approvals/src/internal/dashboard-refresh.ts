/**
 * What the hub shows from its dashboard refresh: always a snapshot, and whether the last refresh
 * failed.
 *
 * The page is served with a bootstrapped snapshot, so there is always data to show. A failed
 * refresh keeps the last good snapshot — the previous success, or the bootstrap when the very
 * first refresh fails (the atom has no success of its own yet then) — instead of replacing the
 * app with an error.
 *
 * @module
 */
import * as AsyncResult from "effect/reactivity/AsyncResult"

export interface DashboardRefreshView<A> {
  readonly snapshot: A
  readonly refreshFailed: boolean
}

export const dashboardRefreshView = <A, E>(
  result: AsyncResult.AsyncResult<A, E>,
  bootstrap: A
): DashboardRefreshView<A> => {
  if (AsyncResult.isSuccess(result)) return { snapshot: result.value, refreshFailed: false }
  if (result._tag === "Failure") {
    return {
      snapshot: result.previousSuccess._tag === "Some" ? result.previousSuccess.value.value : bootstrap,
      refreshFailed: true
    }
  }
  return { snapshot: bootstrap, refreshFailed: false }
}

/** The clock time of the snapshot a failed refresh keeps showing, as the rest of the hub writes times. */
export const dashboardRefreshTime = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(timestamp)
