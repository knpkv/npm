/**
 * How long a limit window lasts at the current pace: the burn over the last hour of the window's
 * current reset cycle, carried forward to the limit or the reset, whichever comes first. The same
 * model the coordinator's `agent-limits` routes by, so the page and the router never disagree.
 *
 * **Mental model**
 *
 * - **A level holds until the next reading.** Readings arrive on change (claude-statusline) or on a
 *   poll, so the level at the hour's start is the last reading before it.
 * - **One cycle only.** Readings belong to a cycle by their reset time (a second of jitter apart is
 *   the same reset). A reading lower than the one before it starts a new cycle: a manual reset.
 * - **Unknown is not zero.** An old reading, a short history or no reset time gives no projection,
 *   never a time or a 0.
 *
 * Pure: the caller passes the series and `now`.
 *
 * @module
 */
import { Array as Arr, Option } from "effect"
import type { LimitReading } from "../core/Model.js"

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Readings this far apart in reset time belong to the same reset (the OAuth poll's jitter). */
const SAME_RESET_MILLIS = MINUTE

/** The least span of readings a pace is called from; a few minutes after a reset is noise. */
const MIN_SPAN_MILLIS = 15 * MINUTE

/** Why a window has no projection. */
export type ProjectionGap = "Stale" | "TooFewSamples" | "NoReset" | "Malformed" | "NoReading"

export type Projection =
  /** The limit is reached before the reset, at `at`. */
  | { readonly _tag: "RunsOut"; readonly at: number; readonly burnPerHour: number }
  /** The reset comes first; `atReset` is the share used by then at this pace. */
  | { readonly _tag: "LastsUntilReset"; readonly burnPerHour: number; readonly atReset: number }
  | { readonly _tag: "OutNow" }
  | { readonly _tag: "Unknown"; readonly reason: ProjectionGap }

/** How old a window's latest reading may be and still set a pace: an hour for weekly, else 15 min. */
export const projectionMaxAge = (windowMinutes: number | null): number => windowMinutes === 10_080 ? HOUR : HOUR / 4

interface Level {
  readonly at: number
  readonly usedPercent: number
  readonly resetsAt: number
}

const gap = (reason: ProjectionGap): Projection => ({ _tag: "Unknown", reason })

/** The readings of the latest one's cycle, oldest first, from its last drop on. */
const currentCycle = (levels: ReadonlyArray<Level>, current: Level): ReadonlyArray<Level> => {
  const cycle = levels.filter((level) => Math.abs(level.resetsAt - current.resetsAt) <= SAME_RESET_MILLIS)
  const drop = Arr.findLastIndex(cycle, (level, index) => {
    const previous = cycle[index - 1]
    return previous !== undefined && level.usedPercent < previous.usedPercent
  })
  return Option.match(drop, { onNone: () => cycle, onSome: (index) => cycle.slice(index) })
}

/**
 * Projects one window from its readings, oldest first, the latest last. `ceilingPercent` is where
 * the window counts as used up: 100, or less for a caller that keeps a reserve.
 */
export const projectWindow = (input: {
  readonly windowMinutes: number | null
  readonly points: ReadonlyArray<{ readonly at: number; readonly reading: LimitReading }>
  readonly now: number
  readonly ceilingPercent?: number
}): Projection => {
  const { now } = input
  const ceiling = input.ceilingPercent ?? 100
  const latest = input.points.at(-1)
  if (latest === undefined || latest.reading._tag === "Unknown") return gap("NoReading")
  const age = now - latest.at
  if (age < 0) return gap("Malformed")
  const { resetsAt, usedPercent } = latest.reading
  if (age > projectionMaxAge(input.windowMinutes) || (resetsAt !== null && resetsAt <= now)) return gap("Stale")
  if (usedPercent >= ceiling) return { _tag: "OutNow" }
  if (resetsAt === null) return gap("NoReset")

  const levels = input.points.flatMap((point): ReadonlyArray<Level> =>
    point.reading._tag === "Known" && point.reading.resetsAt !== null && point.at <= latest.at
      ? [{ at: point.at, usedPercent: point.reading.usedPercent, resetsAt: point.reading.resetsAt }]
      : []
  )
  const current: Level = { at: latest.at, usedPercent, resetsAt }
  const cycle = currentCycle(levels, current)
  const hourStart = now - HOUR
  const anchor = Option.getOrUndefined(Arr.findLast(cycle, (level) => level.at < hourStart))
  const first = anchor !== undefined && hourStart < current.at
    ? { ...anchor, at: hourStart }
    : cycle.find((level) => level.at >= hourStart)
  if (first === undefined || current.at - first.at < MIN_SPAN_MILLIS) return gap("TooFewSamples")

  const burnPerHour = Math.max(0, ((current.usedPercent - first.usedPercent) * HOUR) / (current.at - first.at))
  const crossing = burnPerHour === 0
    ? Number.POSITIVE_INFINITY
    : current.at + ((ceiling - current.usedPercent) / burnPerHour) * HOUR
  return crossing < resetsAt
    ? { _tag: "RunsOut", at: crossing, burnPerHour }
    : {
      _tag: "LastsUntilReset",
      burnPerHour,
      atReset: Math.min(100, current.usedPercent + (burnPerHour * (resetsAt - current.at)) / HOUR)
    }
}
