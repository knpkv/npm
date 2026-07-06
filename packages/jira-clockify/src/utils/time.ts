/**
 * Shared time formatting and parsing utilities.
 *
 * @module
 */

/** Format a `Date` as local `HH:MM` — the canonical clock format for prompts and confirmations. */
export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

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

/** Bare `HH:MM` (no date) — the form that gets the "roll back to yesterday" treatment. */
const HH_MM = /^(\d{1,2}):(\d{2})$/

/**
 * `HH:MM` for times on `now`'s calendar day, else `HH:MM on YYYY-MM-DD`. Used in error
 * messages so a bare `HH:MM` that was rolled back to yesterday doesn't read as a nonsense
 * comparison (e.g. "16:00 is at or before the start 10:00" when 16:00 means *last night*).
 */
function formatClockDated(date: Date, now: Date): string {
  const sameDay = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return formatClock(date)
  const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${
    String(date.getDate()).padStart(2, "0")
  }`
  return `${formatClock(date)} on ${ymd}`
}

/** Outcome of resolving a user-supplied End Correction time. */
export type CorrectedEnd =
  | { readonly ok: true; readonly end: Date }
  | { readonly ok: false; readonly error: string }

/**
 * Resolve a corrected timer end for an End Correction — the user forgot to stop
 * and is pulling the end back to when work actually finished.
 *
 * Accepts the same grammar as {@link parseStartTime} — `HH:MM` (local, today) or
 * a full ISO-8601 timestamp — with one extra rule: a bare `HH:MM` that would land
 * *after* `now` is rolled back to the previous local day. That is the overnight
 * "forgot to stop" case: typing `18:00` at 09:00 means yesterday at 18:00. The
 * rollback moves the calendar day (not a raw −24h) so it stays on the intended
 * wall-clock time across a DST boundary. A full ISO timestamp carries its own
 * date and is never rolled back — it is the escape hatch for ends more than a
 * day ago.
 *
 * Enforces the End Correction bounds `start < end <= now`, returning a specific
 * reason on violation so callers can re-prompt. Never clamps a bad value.
 */
export function resolveCorrectedEnd(params: {
  readonly start: Date
  readonly input: string
  readonly now: Date
}): CorrectedEnd {
  const trimmed = params.input.trim()
  if (!trimmed) {
    return { ok: false, error: "Enter an end time as HH:MM (today) or a full ISO timestamp." }
  }

  let end: Date
  if (HH_MM.test(trimmed)) {
    const parsed = parseStartTime(trimmed, params.now)
    if (!parsed) return { ok: false, error: "Invalid time. Use HH:MM (24-hour), e.g. 17:30." }
    // Bare HH:MM lands on today by default; if that is still in the future the
    // user means the same clock time yesterday (they forgot overnight).
    if (parsed.getTime() > params.now.getTime()) parsed.setDate(parsed.getDate() - 1)
    end = parsed
  } else if (isFullIsoTimestamp(trimmed)) {
    const parsed = parseStartTime(trimmed, params.now)
    if (!parsed) return { ok: false, error: "Invalid ISO timestamp." }
    end = parsed
  } else {
    return { ok: false, error: "Unrecognised time. Use HH:MM (today) or a full ISO timestamp." }
  }

  if (end.getTime() > params.now.getTime()) {
    return { ok: false, error: `End ${formatClockDated(end, params.now)} is in the future.` }
  }
  if (end.getTime() <= params.start.getTime()) {
    return {
      ok: false,
      error: `End ${formatClockDated(end, params.now)} is at or before the start ${
        formatClockDated(params.start, params.now)
      }.`
    }
  }
  return { ok: true, end }
}
