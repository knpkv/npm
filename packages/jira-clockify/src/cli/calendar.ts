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
import { localDay, nextLocalMidnight } from "../utils/time.js"

/** One Issue Key's credited spans on the day being drawn. */
export interface CalendarRow {
  readonly ticketKey: string
  readonly spans: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>
}

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

interface TimelineRow {
  readonly hour: number
  readonly minutes: ReadonlyArray<number | null>
}

/**
 * The actual elapsed minutes of one local day, projected into local-clock rows.
 *
 * A backward transition starts a new occurrence, so a repeated hour gets a second row even when
 * only half of it repeats. A forward transition simply skips the missing local columns or hour.
 */
const localTimeline = (dayStartMs: number, dayEndMs: number): ReadonlyArray<TimelineRow> => {
  const rows: Array<{ hour: number; minutes: Array<number | null> }> = []
  let occurrence = 0
  let previousLocalMinute: number | null = null
  let previousKey: string | null = null
  let currentRow: { hour: number; minutes: Array<number | null> } | null = null
  const elapsedMinutes = Math.round((dayEndMs - dayStartMs) / 60_000)

  for (let elapsedMinute = 0; elapsedMinute < elapsedMinutes; elapsedMinute++) {
    const local = new Date(dayStartMs + elapsedMinute * 60_000)
    const localMinute = local.getHours() * MINUTES_PER_HOUR + local.getMinutes()
    if (previousLocalMinute !== null && localMinute < previousLocalMinute) occurrence++
    const key = `${String(occurrence)}:${String(local.getHours())}`
    if (key !== previousKey) {
      currentRow = {
        hour: local.getHours(),
        minutes: Array.from({ length: MINUTES_PER_HOUR }, (): number | null => null)
      }
      rows.push(currentRow)
      previousKey = key
    }
    if (currentRow !== null) currentRow.minutes[local.getMinutes()] = elapsedMinute
    previousLocalMinute = localMinute
  }

  return rows
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
  const representative = options.rows
    .flatMap((row) => row.spans)
    .find((span) => localDay(new Date(span.startMs)) === options.day)
  if (representative === undefined) return []
  const representativeStart = new Date(representative.startMs)
  const dayStartMs = new Date(
    representativeStart.getFullYear(),
    representativeStart.getMonth(),
    representativeStart.getDate()
  ).getTime()
  const dayEndMs = nextLocalMidnight(dayStartMs)
  const dayDurationMs = dayEndMs - dayStartMs
  const timeline = localTimeline(dayStartMs, dayEndMs)
  const gridMinutes = Math.round(dayDurationMs / 60_000)
  const minutes = Array.from({ length: gridMinutes }, () => IDLE)
  // Who owns each minute, tracked by Issue Key rather than by glyph. There are only so many glyphs,
  // and a day with more Issue Keys than glyphs would otherwise have two of them compare equal — so a
  // minute genuinely split between them would read as exclusively one ticket's.
  const owners = Array.from({ length: gridMinutes }, (): string | null => null)
  const glyphs = new Map<string, string>()
  let anyShared = false

  options.rows.forEach((row, index) => {
    const glyph = GLYPHS[index] ?? OVERFLOW
    glyphs.set(row.ticketKey, glyph)
    for (const span of row.spans) {
      // Spans never cross a local midnight, but a caller may pass a whole period's worth of rows,
      // so anything outside this day is skipped rather than wrapped onto it.
      if (localDay(new Date(span.startMs)) !== options.day) continue
      const from = Math.floor((span.startMs - dayStartMs) / 60_000)
      const to = span.endMs - span.startMs >= dayDurationMs
        ? gridMinutes
        : Math.ceil((span.endMs - dayStartMs) / 60_000)
      for (let minute = Math.max(0, from); minute < Math.min(gridMinutes, to); minute++) {
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

  const cellsFor = (row: TimelineRow): ReadonlyArray<string> =>
    row.minutes.map((elapsedMinute) => elapsedMinute === null ? IDLE : (minutes[elapsedMinute] ?? IDLE))
  const activeHours = timeline
    .map((row, index) => ({ cells: cellsFor(row), index, row }))
    .filter(({ cells }) => cells.some((cell) => cell !== IDLE))
  if (activeHours.length === 0) return []

  const legend = [
    ...[...glyphs.entries()].map(([ticketKey, glyph]) => `${glyph} ${ticketKey}`),
    ...(anyShared ? [`${SHARED} shared (split equally)`] : [])
  ].join("   ")

  const lines: Array<string> = [`  ${options.day}   ${legend}`, ruler()]
  let previous: number | null = null
  for (const { cells, index, row } of activeHours) {
    if (previous !== null && index > previous + 1) {
      lines.push(`${" ".repeat(LABEL_WIDTH)}${SKIPPED.repeat(3)} ${index - previous - 1}h with nothing credited`)
    }
    const label = `  ${String(row.hour).padStart(2, "0")}h  `.padEnd(LABEL_WIDTH)
    lines.push(label + cells.join(""))
    previous = index
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
