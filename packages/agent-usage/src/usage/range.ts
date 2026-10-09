/**
 * The range presets, as instants in the viewer's zone: the last 24 hours by hour, or whole local
 * days ending with today.
 *
 * @module
 */
import type { Bucket } from "../shared/contracts.js"

export type Preset = "24h" | "7d" | "30d" | "90d"
export const PRESETS: ReadonlyArray<Preset> = ["24h", "7d", "30d", "90d"]

export interface ViewRange {
  readonly from: number
  readonly to: number
  readonly bucket: Bucket
}

const DAY_MILLIS = 86_400_000

const daysOf = { "7d": 7, "30d": 30, "90d": 90 } satisfies Record<Exclude<Preset, "24h">, number>

/** The offset of a zone from UTC at an instant, in milliseconds. */
const offsetAt = (instant: number, timeZone: string): number => {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)])
  )
  const asUtc = Date.UTC(
    parts.get("year") ?? 0,
    (parts.get("month") ?? 1) - 1,
    parts.get("day") ?? 1,
    parts.get("hour") ?? 0,
    parts.get("minute") ?? 0,
    parts.get("second") ?? 0
  )
  return asUtc - (instant - (instant % 1000))
}

const QUARTER_HOUR = 15 * 60 * 1000

/** The local calendar day of an instant, as a comparable UTC-midnight number. */
const localDay = (instant: number, timeZone: string): number => {
  const local = new Date(instant + offsetAt(instant, timeZone))
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
}

/**
 * The first instant of the local calendar day `days` after the one `instant` falls on. Usually local
 * midnight; where clocks jump forward at midnight (Santiago), the first instant that exists.
 */
const localMidnight = (instant: number, timeZone: string, days: number): number => {
  const local = new Date(instant + offsetAt(instant, timeZone))
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days)
  // The offset at the target midnight, not today's: a daylight-saving change may sit between.
  let candidate = wall - offsetAt(wall - offsetAt(wall, timeZone), timeZone)
  // A skipped midnight resolves to the evening before; step forward into the target day.
  while (localDay(candidate, timeZone) < wall) candidate += QUARTER_HOUR
  // Never past the day's first instant: step back while the previous quarter hour is still in it.
  while (localDay(candidate - QUARTER_HOUR, timeZone) === wall) candidate -= QUARTER_HOUR
  return candidate
}

export const rangeOf = (preset: Preset, now: number, timeZone: string): ViewRange => {
  if (preset === "24h") return { from: now - DAY_MILLIS, to: now, bucket: "hour" }
  const days = daysOf[preset]
  return {
    from: localMidnight(now, timeZone, -(days - 1)),
    to: localMidnight(now, timeZone, 1),
    bucket: "day"
  }
}
