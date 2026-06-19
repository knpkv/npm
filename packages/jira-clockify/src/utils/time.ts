/**
 * Shared time formatting and parsing utilities.
 *
 * @module
 */

/** Format seconds as `HH:MM:SS`. Negative input is clamped to 0. */
export function formatElapsed(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  const s = clamped % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/** Format seconds as human-readable duration (`1h 23m` or `45s`). */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

/**
 * Parse a duration string like `1h30m`, `2h`, `45m`, or `90m` into seconds.
 * Returns `null` when the input is empty or malformed (unlike the loose regex
 * that previously lived in the `log` command, which silently matched garbage).
 */
export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?$/)
  if (!match || (!match[1] && !match[2])) return null
  const hours = parseInt(match[1] ?? "0", 10)
  const minutes = parseInt(match[2] ?? "0", 10)
  return hours * 3600 + minutes * 60
}

/** Full ISO-8601 timestamp: `YYYY-MM-DDTHH:MM[:SS[.sss]][Z|±HH:MM]`. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/

/** True when `input` is a full ISO-8601 timestamp (carries its own date). */
export function isFullIsoTimestamp(input: string): boolean {
  return ISO_8601.test(input.trim())
}

/**
 * Parse a past start time. Accepts `HH:MM` (interpreted as that time today, in
 * local time, relative to `now`) or a full ISO-8601 timestamp. Returns `null`
 * when unparseable.
 *
 * Note: the `HH:MM` branch uses `setHours` on the local day, so across a DST
 * transition (a clock-time that is skipped or repeated locally) the resulting
 * instant can shift by an hour. Pass a full ISO timestamp to avoid the ambiguity.
 *
 * The ISO fallback deliberately requires a *full* timestamp; bare years (`"2024"`)
 * or locale strings (`"Jan 5"`) — which `new Date()` would otherwise accept — are
 * rejected as `null` so malformed input never becomes a surprising instant.
 */
export function parseStartTime(input: string, now: Date = new Date()): Date | null {
  const trimmed = input.trim()
  const hm = trimmed.match(/^(\d{1,2}):(\d{2})$/)
  if (hm) {
    const hours = parseInt(hm[1]!, 10)
    const minutes = parseInt(hm[2]!, 10)
    if (hours > 23 || minutes > 59) return null
    const d = new Date(now)
    d.setHours(hours, minutes, 0, 0)
    return d
  }
  if (!ISO_8601.test(trimmed)) return null
  const parsed = new Date(trimmed)
  return isNaN(parsed.getTime()) ? null : parsed
}
