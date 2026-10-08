/**
 * The latest limits on this Machine, for the control socket's `limits` request: the same tiles the
 * page's "Limits now" shows, without the series behind its charts.
 *
 * @module
 */
import { Clock, Effect } from "effect"
import { buildLimitsReport } from "../core/Report.js"
import type { UsageStore } from "../core/Store.js"
import type { LimitsNow } from "../shared/contracts.js"

/**
 * A weekly window plus a day. A window with no snapshot in that span (none observed for eight days)
 * is left out rather than shown as an old reading: whatever it said has reset since.
 */
export const LIMITS_NOW_LOOKBACK_MILLIS = 8 * 24 * 60 * 60 * 1000

/**
 * Reads the newest snapshot of every limit series, as of now. Each request scans the eight-day span
 * (the page's own limits query does the same over its range); a request comes at most every 30
 * seconds per reader.
 */
export const readLimitsNow = Effect.fn("LimitsNow.read")(function*(store: UsageStore["Service"], machine: string) {
  const now = yield* Clock.currentTimeMillis
  const range = { from: now - LIMITS_NOW_LOOKBACK_MILLIS, to: now + 1 }
  const snapshots = yield* store.limitSnapshots({ ...range, machine })
  return { machine, observedAt: now, latest: buildLimitsReport(snapshots, range).latest } satisfies LimitsNow
})
