/**
 * An ASCII day calendar for Attributed Intervals — a Clockify-style time grid in the terminal.
 *
 * **Mental model**
 *
 * - **One column per minute, one row per hour.** 60 columns is the widest a grid can be while
 *   staying inside a normal terminal, and a minute is the resolution proposals are expressed in,
 *   so the picture and the numbers agree.
 * - **Only hours with work are drawn.** A day is mostly empty; printing 24 rows to show three
 *   would bury the answer. A `~` separator marks each skipped stretch so the gaps stay visible
 *   rather than silently closing up.
 * - **A minute is filled if any credited time touches it.** A 20-second span therefore shows as a
 *   full minute — the grid is a picture of *when*, and the row above it is the authority on
 *   *how much*.
 * - **A minute worked on several Issue Keys at once shows as shared.** That time is divided equally
 *   between them, so attributing the minute to one of their glyphs would misrepresent it.
 *
 * @module
 */
import { localDay } from "../utils/time.js"

/** One Issue Key's credited spans on the day being drawn. */
export interface CalendarRow {
  readonly ticketKey: string
  readonly spans: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>
}

const MINUTES_PER_DAY = 24 * 60
const MINUTES_PER_HOUR = 60
const IDLE = "."
const SKIPPED = "~"
/** A minute claimed by more than one Issue Key: worked in parallel, so the time was split. */
const SHARED = "%"

/**
 * Glyphs in assignment order. Deliberately ASCII: this has to survive a pipe, a log file, and a
 * paste into a ticket comment.
 */
const GLYPHS = ["#", "=", "*", "+", "o", "x"]

/**
 * The glyph for every Issue Key past the supply.
 *
 * Shared on purpose, and legible as such: past six keys in a day the grid cannot tell them apart
 * anyway, and saying so is better than silently reusing `#` for the seventh as if it were the first.
 * Ownership is tracked by Issue Key, so a minute split between two overflow keys still reads shared.
 */
const OVERFLOW = "?"

const LABEL_WIDTH = 8

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Which grid cell an instant belongs in, by the local clock the reader is looking at.
 *
 * `up` rounds to the end of the minute, for a span's exclusive end. A `00:00` end rounds to the
 * full day rather than to zero: it is the close of this day, not the start of it.
 */
const localMinuteOfDay = (atMs: number, rounding: "down" | "up" = "down"): number => {
  const at = new Date(atMs)
  const exact = at.getHours() * 60 + at.getMinutes()
  if (rounding === "down") return exact
  const rounded = at.getSeconds() > 0 || at.getMilliseconds() > 0 ? exact + 1 : exact
  return rounded === 0 ? MINUTES_PER_DAY : rounded
}

/**
 * The `:00  :05  …` ruler. Each label is five characters, so label *n* begins exactly above
 * minute `5n` of the grid below it.
 */
const ruler = (): string => {
  let marks = ""
  for (let minute = 0; minute < MINUTES_PER_HOUR; minute += 5) {
    marks += `:${String(minute).padStart(2, "0")}  `
  }
  return `${" ".repeat(LABEL_WIDTH)}${marks}`
}

/**
 * Draw one day. Returns the lines to print, or an empty array when the day has no credited time
 * at all — a caller can then say "nothing" in its own words rather than print an empty grid.
 */
export const renderDayCalendar = (options: {
  readonly day: string
  readonly rows: ReadonlyArray<CalendarRow>
}): ReadonlyArray<string> => {
  const minutes = new Array<string>(MINUTES_PER_DAY).fill(IDLE)
  // Who owns each minute, tracked by Issue Key rather than by glyph. There are only so many glyphs,
  // and a day with more Issue Keys than glyphs would otherwise have two of them compare equal — so a
  // minute genuinely split between them would read as exclusively one ticket's.
  const owners = new Array<string | null>(MINUTES_PER_DAY).fill(null)
  const glyphs = new Map<string, string>()
  let anyShared = false

  options.rows.forEach((row, index) => {
    const glyph = GLYPHS[index] ?? OVERFLOW
    glyphs.set(row.ticketKey, glyph)
    for (const span of row.spans) {
      // Spans never cross a local midnight, but a caller may pass a whole period's worth of rows,
      // so anything outside this day is skipped rather than wrapped onto it.
      if (localDay(new Date(span.startMs)) !== options.day) continue
      // Read off the local clock rather than measured from midnight. On a daylight-saving day the
      // two disagree: after a spring-forward, work at 03:00 sits 2 hours from midnight and would be
      // drawn in the `02h` row, and after a fall-back every later block shifts by an hour and the
      // last of them runs off the end of the grid and disappears — exactly when the grid is being
      // used to decide whether a proposal is right.
      const from = localMinuteOfDay(span.startMs)
      const to = span.endMs - span.startMs >= DAY_MS ? MINUTES_PER_DAY : localMinuteOfDay(span.endMs, "up")
      for (let minute = Math.max(0, from); minute < Math.min(MINUTES_PER_DAY, to); minute++) {
        const owner = owners[minute]
        if (owner === null || owner === undefined) {
          minutes[minute] = glyph
          owners[minute] = row.ticketKey
          continue
        }
        // Already claimed by another Issue Key: the minute was worked in parallel and its time was
        // divided, so neither glyph would be honest.
        if (owner !== row.ticketKey) {
          minutes[minute] = SHARED
          anyShared = true
        }
      }
    }
  })

  const activeHours = [...new Array(24).keys()].filter((hour) =>
    minutes.slice(hour * MINUTES_PER_HOUR, (hour + 1) * MINUTES_PER_HOUR).some((cell) => cell !== IDLE)
  )
  if (activeHours.length === 0) return []

  const legend = [
    ...[...glyphs.entries()].map(([ticketKey, glyph]) => `${glyph} ${ticketKey}`),
    ...(anyShared ? [`${SHARED} shared (split equally)`] : [])
  ].join("   ")

  const lines: Array<string> = [`  ${options.day}   ${legend}`, ruler()]
  let previous: number | null = null
  for (const hour of activeHours) {
    if (previous !== null && hour > previous + 1) {
      lines.push(`${" ".repeat(LABEL_WIDTH)}${SKIPPED.repeat(3)} ${hour - previous - 1}h with nothing credited`)
    }
    const label = `  ${String(hour).padStart(2, "0")}h  `.padEnd(LABEL_WIDTH)
    lines.push(label + minutes.slice(hour * MINUTES_PER_HOUR, (hour + 1) * MINUTES_PER_HOUR).join(""))
    previous = hour
  }
  return lines
}

/** Local `HH:MM`. */
const clock = (ms: number): string => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
}

/**
 * The outer bounds of a set of spans: when the work item started and when it finished.
 *
 * This is the pair a timesheet actually asks for. It is deliberately *not* the credited duration —
 * the gaps inside it were not worked, and on a shared day part of it belongs to another Issue Key.
 */
export const formatSpanBounds = (
  spans: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>
): string => {
  if (spans.length === 0) return ""
  const first = spans.reduce((earliest, span) => Math.min(earliest, span.startMs), Infinity)
  const last = spans.reduce((latest, span) => Math.max(latest, span.endMs), -Infinity)
  return `${clock(first)}-${clock(last)}`
}

/** The earliest instant in a set of spans, for anchoring a write to when work began. */
export const earliestStart = (
  spans: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>
): Date | undefined =>
  spans.length === 0
    ? undefined
    : new Date(spans.reduce((earliest, span) => Math.min(earliest, span.startMs), Infinity))

/**
 * `HH:MM-HH:MM` for each span, so the row above the grid says *when* in words. Long lists are
 * clipped with a count rather than wrapped, because the total is already on the row.
 */
export const formatSpanRanges = (
  spans: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>,
  options?: { readonly limit?: number | undefined }
): string => {
  const limit = options?.limit ?? 4
  const shown = spans.slice(0, limit).map((span) => `${clock(span.startMs)}-${clock(span.endMs)}`)
  const hidden = spans.length - shown.length
  return hidden > 0 ? `${shown.join(", ")} +${hidden} more` : shown.join(", ")
}
