/**
 * The geometry-free half of the charts: which Bookings get their own colour, how each period's
 * column stacks, and how a limit series becomes a step line.
 *
 * **Mental model**
 *
 * - **Eight named Bookings and Other.** The categorical palette has eight validated slots; a ninth
 *   Booking never gets a generated colour, it folds into Other.
 * - **Colour follows the Booking, not its rank.** Slots are handed out once and kept while a
 *   Booking stays on screen, so changing the range or measure does not repaint survivors.
 * - **Unknown is a gap.** A limit reading that could not be taken breaks the line rather than
 *   carrying the last value forward.
 *
 * @module
 */
import type { Agent, LimitReading } from "../core/Model.js"
import type { UsageReport } from "../shared/contracts.js"

export type Measure = "cost" | "tokens"

export const OTHER = "other"
export const NAMED_SERIES = 8

export interface Segment {
  readonly id: string
  readonly value: number
  /** Where the segment starts, stacked on the ones below it. */
  readonly from: number
}

export interface Column {
  readonly period: number
  readonly total: number
  readonly segments: ReadonlyArray<Segment>
}

export interface StackedUsage {
  /** Bottom to top: the named Bookings by measure, then Other when anything folded. */
  readonly series: ReadonlyArray<{ readonly id: string }>
  readonly columns: ReadonlyArray<Column>
  readonly max: number
}

const measureOf = (measure: Measure, cell: { readonly costUsd: number; readonly tokens: number }): number =>
  measure === "cost" ? cell.costUsd : cell.tokens

/**
 * Stacks each period's usage by Booking. With a Booking selected only it is drawn; otherwise the
 * eight largest by the measure over the range are named and the rest fold into Other.
 */
export const stackUsage = (report: UsageReport, measure: Measure, selected: string | null): StackedUsage => {
  const totals = new Map<string, number>()
  for (const cell of report.cells) {
    totals.set(cell.booking, (totals.get(cell.booking) ?? 0) + measureOf(measure, cell))
  }
  const ranked = [...totals].filter(([, total]) => total > 0).sort((left, right) => right[1] - left[1])
  const named = selected === null ? ranked.slice(0, NAMED_SERIES).map(([id]) => id) : [selected]
  const namedSet = new Set(named)
  const folds = selected === null && ranked.length > NAMED_SERIES
  const order = folds ? [...named, OTHER] : named

  const columns = report.periods.map((_, period): Column => {
    const values = new Map<string, number>()
    for (const cell of report.cells) {
      if (cell.period !== period) continue
      const id = namedSet.has(cell.booking) ? cell.booking : folds ? OTHER : null
      if (id === null) continue
      values.set(id, (values.get(id) ?? 0) + measureOf(measure, cell))
    }
    let from = 0
    const segments: Array<Segment> = []
    for (const id of order) {
      const value = values.get(id) ?? 0
      if (value <= 0) continue
      segments.push({ id, value, from })
      from += value
    }
    return { period, total: from, segments }
  })

  return {
    series: order.map((id) => ({ id })),
    columns,
    max: columns.reduce((max, column) => Math.max(max, column.total), 0)
  }
}

/**
 * Colour slots for the Bookings now on screen. A Booking that already had a slot keeps it; a new
 * one takes the lowest slot no surviving Booking holds.
 */
export const assignSlots = (
  previous: ReadonlyMap<string, number>,
  ids: ReadonlyArray<string>
): ReadonlyMap<string, number> => {
  const next = new Map<string, number>()
  for (const id of ids) {
    const slot = previous.get(id)
    if (slot !== undefined) next.set(id, slot)
  }
  const taken = new Set(next.values())
  for (const id of ids) {
    if (next.has(id)) continue
    let slot = 0
    while (taken.has(slot)) slot++
    next.set(id, slot)
    taken.add(slot)
  }
  return next
}

export const bookingLabel = (
  booking: { readonly _tag: "Ticket"; readonly key: string } | { readonly _tag: "Repo"; readonly name: string }
): string => (booking._tag === "Ticket" ? booking.key : `${booking.name} (repo)`)

const agentName = (agent: Agent): string => (agent === "claude" ? "Claude" : "Codex")

/** A limit's name: by window length when known, else by the provider's own key. */
export const limitLabel = (agent: Agent, label: string, windowMinutes: number | null): string => {
  if (label === "*") return `${agentName(agent)} limits`
  // Claude names its windows, and seven_day_opus is a different allowance from seven_day.
  if (agent === "claude" && label !== "five_hour" && label !== "seven_day") return `Claude ${label}`
  if (windowMinutes === 300) return `${agentName(agent)} 5h`
  if (windowMinutes === 10_080) return `${agentName(agent)} weekly`
  if (windowMinutes !== null && windowMinutes % 60 === 0) return `${agentName(agent)} ${windowMinutes / 60}h`
  return `${agentName(agent)} ${label}`
}

/**
 * An SVG path holding each Known reading level until the next reading, its window's reset, or
 * `end`, whichever comes first. Nothing is drawn across an Unknown reading or past a reset nobody
 * has read since: the level after a reset is not known.
 */
export const stepPath = (
  points: ReadonlyArray<{ readonly at: number; readonly reading: LimitReading }>,
  end: number,
  x: (at: number) => number,
  y: (percent: number) => number
): string =>
  points
    .map((point, index) => {
      if (point.reading._tag === "Unknown") return ""
      const until = Math.min(points[index + 1]?.at ?? end, point.reading.resetsAt ?? end)
      if (until <= point.at) return ""
      return `M${x(point.at)},${y(point.reading.usedPercent)}H${x(until)}`
    })
    .join("")

/**
 * The reading in force at an instant: the last point at or before it, unless that reading's window
 * has reset since, after which the level is not known.
 */
export const readingAt = (
  points: ReadonlyArray<{ readonly at: number; readonly reading: LimitReading }>,
  instant: number
): LimitReading | undefined => {
  let found: LimitReading | undefined
  for (const point of points) {
    if (point.at > instant) break
    found = point.reading
  }
  if (found?._tag === "Known" && found.resetsAt !== null && found.resetsAt <= instant) return undefined
  return found
}

/**
 * A limit series' identity on the page, matching the report's: Codex windows by length (a plan
 * change moves a window between slots), Claude windows by name.
 */
export const seriesIdentity = (series: {
  readonly agent: Agent
  readonly label: string
  readonly windowMinutes: number | null
}): string =>
  series.agent === "codex" && series.windowMinutes !== null
    ? `codex:${series.windowMinutes}m`
    : `${series.agent}:${series.label}`

/** The whole range's usage by the measure: the panel's headline number. */
export const rangeTotal = (report: UsageReport, measure: Measure): number =>
  report.cells.reduce((sum, cell) => sum + measureOf(measure, cell), 0)

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** An axis tick: whole dollars once they are large enough to need no cents, compact tokens. */
export const formatAxis = (measure: Measure, value: number): string =>
  measure === "tokens"
    ? compactNumber.format(value)
    : value >= 10 || Number.isInteger(value)
    ? `$${compactNumber.format(value)}`
    : `$${value.toFixed(2)}`
