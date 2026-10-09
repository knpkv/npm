/**
 * This Machine's usage over a range, for the control socket's `usage` request: tokens per period,
 * agent and model, and the limit series, in a shape that may leave the Machine (see {@link UsageNow}).
 *
 * **Mental model**
 *
 * - **Encoded out at the source.** The reader never builds a usage report, so cost, Bookings,
 *   sessions and balances are not dropped later: they are never in the answer.
 * - **The asker's calendar.** Periods are local to the time zone the request names, so hosts asked
 *   with the same zone answer with the same period keys.
 * - **Bounded.** A month of five-minute limit polls is thousands of points per series; each series
 *   keeps at most {@link MAX_LIMIT_POINTS}, the highest reading per slice, so a peak is never lost.
 *   The price: an Unknown run shorter than a slice that shares it with a Known reading disappears
 *   (about 90 minutes at 30 days, 3 at 24 hours), so a brief failed poll may not show as a gap.
 *
 * @module
 */
import { Clock, Effect } from "effect"
import { buildLimitsReport, checkTimeZone, periodsOf, tokensByModel } from "../core/Report.js"
import type { UsageStore } from "../core/Store.js"
import type { LimitSeries, UsageNow, UsagePreset } from "../shared/contracts.js"
import { rangeOf } from "../usage/range.js"

/** At most this many points per limit series; a chart is never wider than this in pixels per row anyway. */
export const MAX_LIMIT_POINTS = 480

type Point = LimitSeries["points"][number]

/**
 * At most `max` points: the range is cut into `max` equal slices and each slice keeps its highest
 * Known reading, or its first point when none is Known. Fewer points pass through unchanged.
 */
export const thinPoints = (
  points: ReadonlyArray<Point>,
  range: { readonly from: number; readonly to: number },
  max: number = MAX_LIMIT_POINTS
): ReadonlyArray<Point> => {
  if (points.length <= max) return points
  const width = Math.max(1, (range.to - range.from) / max)
  const kept = new Map<number, Point>()
  for (const point of points) {
    const slice = Math.min(max - 1, Math.max(0, Math.floor((point.at - range.from) / width)))
    const held = kept.get(slice)
    const higher = point.reading._tag === "Known" &&
      (held === undefined || held.reading._tag !== "Known" || point.reading.usedPercent > held.reading.usedPercent)
    if (held === undefined || higher) kept.set(slice, point)
  }
  return [...kept.entries()].sort(([left], [right]) => left - right).map(([, point]) => point)
}

/** Reads this Machine's usage over the preset, as of now, in the asker's time zone. */
export const readUsageNow = Effect.fn("UsageNow.read")(function*(
  store: UsageStore["Service"],
  machine: string,
  preset: UsagePreset,
  timeZone: string
) {
  const zone = yield* checkTimeZone(timeZone)
  const now = yield* Clock.currentTimeMillis
  const range = rangeOf(preset, now, zone)
  const periods = periodsOf({ ...range, timeZone: zone })
  const [groups, snapshots] = yield* Effect.all([
    store.usageGroups({ from: range.from, to: range.to, machine }),
    store.limitSnapshots({ from: range.from, to: range.to, machine })
  ])
  const limits = buildLimitsReport(snapshots, range).series.map((series) => ({
    ...series,
    points: thinPoints(series.points, range)
  }))
  return {
    v: 1,
    machine,
    observedAt: now,
    range: { preset, timeZone: zone, from: range.from, to: range.to, bucket: range.bucket },
    periods,
    tokens: tokensByModel(groups, periods, range.to),
    limits
  } satisfies UsageNow
})
