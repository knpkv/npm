import { Duration, Match, Option } from "effect"

export const formatDate = (date: Date): string => {
  const d = date.getDate().toString().padStart(2, "0")
  const m = (date.getMonth() + 1).toString().padStart(2, "0")
  const y = date.getFullYear()
  return `${d}.${m}.${y}`
}

export const formatDateTime = (date: Date): string => {
  const dStr = formatDate(date)
  const tStr = date.toLocaleTimeString("en-GB", { hour12: false })
  return `${dStr} ${tStr}`
}

export const formatRelativeTime = (date: Date, now: Date, prefix = "Updated"): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))

  return Match.value(seconds).pipe(
    Match.when((s) => s < 60, (s) => `${prefix} ${s}s ago`),
    Match.when((s) => s < 3600, (s) => `${prefix} ${Math.floor(s / 60)}m ago`),
    Match.when((s) => s < 86400, (s) => `${prefix} ${Math.floor(s / 3600)}h ago`),
    Match.orElse(() => `${prefix} on ${formatDate(date)}`)
  )
}

// ---------------------------------------------------------------------------
// ISO Week Utilities
// ---------------------------------------------------------------------------

export interface WeekRange {
  readonly week: string // "2026-W09"
  readonly start: Date // Monday 00:00:00 UTC
  readonly end: Date // Next Monday 00:00:00 UTC (exclusive)
}

/**
 * Parse an ISO week string (e.g. "2026-W09") into a date range.
 * Returns None if the string is malformed.
 */
export const parseISOWeek = (week: string): Option.Option<WeekRange> => {
  const match = /^(\d{4})-W(\d{2})$/.exec(week)
  if (!match) return Option.none()
  const year = parseInt(match[1]!, 10)
  const weekNum = parseInt(match[2]!, 10)
  if (weekNum < 1 || weekNum > 53) return Option.none()

  // Jan 4 is always in week 1 (ISO 8601)
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const dayOfWeek = jan4.getUTCDay() || 7 // Monday=1 ... Sunday=7
  const monday = new Date(jan4.getTime() + ((weekNum - 1) * 7 - (dayOfWeek - 1)) * 86400000)
  const nextMonday = new Date(monday.getTime() + 7 * 86400000)

  return Option.some({ week, start: monday, end: nextMonday })
}

/**
 * Get the ISO week string for a given date.
 */
export const toISOWeek = (date: Date): string => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum) // Thursday of the week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${weekNum.toString().padStart(2, "0")}`
}

/**
 * Format a week range as a human-readable label.
 * e.g. "W09 2026 · Feb 24 – Mar 2"
 */
export const formatWeekLabel = (range: WeekRange): string => {
  const w = range.week.split("-W")
  const startMonth = range.start.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  const endMonth = range.end.toLocaleString("en-US", { month: "short", timeZone: "UTC" })
  const startDay = range.start.getUTCDate()
  const endDay = range.end.getUTCDate()
  const datePart = startMonth === endMonth
    ? `${startMonth} ${startDay} – ${endDay}`
    : `${startMonth} ${startDay} – ${endMonth} ${endDay}`
  return `W${w[1]} ${w[0]} · ${datePart}`
}

/**
 * Format duration in milliseconds to a human-readable string.
 */
export const formatDuration = (ms: number): string => {
  const d = Duration.millis(ms)
  const hours = Duration.toHours(d)
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 24) return `${Math.floor(hours)}h`
  const days = Math.round(hours / 24 * 10) / 10
  return `${days}d`
}

/**
 * Compute the median of a numeric array. Returns null for empty arrays.
 */
export const median = (arr: ReadonlyArray<number>): number | null => {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
