import type { RlySeries } from "../primitives/ChartLegend.js"

/** One series' value in one column. */
export interface RlyChartSegment {
  readonly id: string
  readonly series: RlySeries
  /** A non-negative finite amount; zero, negative and non-finite values (`NaN`, ±Infinity) draw nothing. */
  readonly value: number
}

/** One period on the time axis, in epoch milliseconds, with its stacked values. */
export interface RlyChartColumn {
  readonly start: number
  readonly end: number
  readonly segments: ReadonlyArray<RlyChartSegment>
}

/** Consecutive columns drawn as one bar: `first`..`last` are column indices. */
export interface RlyChartBin {
  readonly first: number
  readonly last: number
  readonly start: number
  readonly end: number
  readonly total: number
  readonly segments: ReadonlyArray<RlyChartSegment & { readonly offset: number }>
}

/** An inclusive range of column indices. */
export interface RlyChartSelection {
  readonly from: number
  readonly to: number
}

/** An axis label: at a bin's start, or the one end-anchored label at the axis end. */
export type RlyChartTick = { readonly anchor: "start"; readonly index: number } | { readonly anchor: "end" }

/**
 * Bin sizes that divide a day evenly. Bins group every N columns, so for hourly columns starting on
 * an hour boundary they line up with clock hours; an offset start, gaps or a DST day shift them.
 */
const BIN_SIZES: ReadonlyArray<number> = [1, 2, 3, 6, 12, 24]

const DAY = 24

/** Where each bin starts, in column indices; a short trailing remainder joins the bin before it. */
const groupStarts = (count: number, size: number): ReadonlyArray<number> => {
  const starts: Array<number> = []
  for (let first = 0; first < count; first += size) starts.push(first)
  if (count % size > 0 && starts.length > 1) starts.pop()
  return starts
}

/** Columns arrived out of time order or overlapping, so they cannot share one time axis. */
export class RlyChartColumnsError extends Error {
  override readonly name = "RlyChartColumnsError"
  /** The first column that starts before the previous one ends, or ends before it starts. */
  readonly index: number
  constructor(index: number) {
    super(`StackedBars columns must be in time order without overlaps; column ${index} is not`)
    this.index = index
  }
}

/** Fail loudly on columns that cannot share one time axis: each must start at or after the previous end. */
export const validateColumns = (columns: ReadonlyArray<RlyChartColumn>): void => {
  for (const [index, column] of columns.entries()) {
    const previous = columns[index - 1]
    if (column.end < column.start || (previous !== undefined && column.start < previous.end)) {
      throw new RlyChartColumnsError(index)
    }
  }
}

/**
 * One stack order for the whole chart: each series id in the order it first appears across all
 * columns. Every bin stacks in this order, so a series keeps its place from bar to bar.
 */
export const stackOrder = (columns: ReadonlyArray<RlyChartColumn>): ReadonlyMap<string, number> => {
  const order = new Map<string, number>()
  for (const column of columns) {
    for (const segment of column.segments) if (!order.has(segment.id)) order.set(segment.id, order.size)
  }
  return order
}

/** The narrowest bar, in pixels, that binning `columns` by `size` draws on the shared time axis. */
const narrowestBar = (columns: ReadonlyArray<RlyChartColumn>, size: number, width: number): number => {
  const from = columns[0]?.start ?? 0
  const span = Math.max(1, (columns[columns.length - 1]?.end ?? from) - from)
  const starts = groupStarts(columns.length, size)
  // A loop, not Math.min(...), so a long history (150,000 columns) cannot overflow the call stack.
  let narrowest = Number.POSITIVE_INFINITY
  for (const [index, first] of starts.entries()) {
    const last = (starts[index + 1] ?? columns.length) - 1
    narrowest = Math.min(narrowest, (((columns[last]?.end ?? from) - (columns[first]?.start ?? from)) / span) * width)
  }
  return narrowest
}

/**
 * The smallest bin size whose every bar, measured on the shared time axis, is at least `minBar`
 * pixels wide, so uneven or sparse periods are measured as drawn. Past a day per bar it grows in
 * whole days (24 columns at a time); failing all, one bin holds everything.
 */
export const chooseBinSize = (width: number, columns: ReadonlyArray<RlyChartColumn>, minBar = 6): number => {
  if (columns.length === 0) return 1
  const preferred = BIN_SIZES.find((size) => narrowestBar(columns, size, width) >= minBar)
  if (preferred !== undefined) return preferred
  // Whole days, smallest first, so the finest size that keeps every bar wide enough wins.
  for (let days = 2; days * DAY < columns.length; days += 1) {
    if (narrowestBar(columns, days * DAY, width) >= minBar) return days * DAY
  }
  return columns.length
}

/**
 * Per bin, the factor that turns its total into a rate per nominal bin (`size` columns of average
 * length), so a folded or longer bin stands as tall as its spending rate, not its raw sum. Bar areas
 * then match totals on the time-proportional axis.
 */
export const binRates = (
  bins: ReadonlyArray<RlyChartBin>,
  columns: ReadonlyArray<RlyChartColumn>,
  size: number
): ReadonlyArray<number> => {
  // The mean of the columns' own lengths, so a gap between periods never inflates a rate.
  const average = Math.max(1, columns.reduce((sum, column) => sum + Math.max(0, column.end - column.start), 0)) /
    Math.max(1, columns.length)
  return bins.map((bin) => (average * size) / Math.max(1, bin.end - bin.start))
}

/**
 * Group columns into bins of `size`, merging segments by id and stacking every bin in the chart's
 * one `stackOrder`. A short trailing remainder joins the bin before it, so the last bar is never
 * narrower than the rest.
 */
export const binColumns = (columns: ReadonlyArray<RlyChartColumn>, size: number): ReadonlyArray<RlyChartBin> => {
  const bins: Array<RlyChartBin> = []
  const order = stackOrder(columns)
  const starts = groupStarts(columns.length, size)
  for (const [index, first] of starts.entries()) {
    const group = columns.slice(first, starts[index + 1] ?? columns.length)
    const values = new Map<string, RlyChartSegment>()
    for (const segment of group.flatMap((column) => column.segments)) {
      // A failed reading (NaN, ±Infinity) is no reading, so it cannot poison the totals or the scale.
      if (!Number.isFinite(segment.value) || segment.value <= 0) continue
      // The first-seen segment keeps its fields; later ones only add their value.
      const seen = values.get(segment.id)
      values.set(segment.id, seen === undefined ? segment : { ...seen, value: seen.value + segment.value })
    }
    const ordered = [...values.values()].sort(
      (left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)
    )
    const segments = ordered.reduce<Array<RlyChartBin["segments"][number]>>(
      (stacked, segment) => [...stacked, { ...segment, offset: stacked.reduce((sum, { value }) => sum + value, 0) }],
      []
    )
    bins.push({
      end: group[group.length - 1]?.end ?? 0,
      first,
      last: first + group.length - 1,
      segments,
      start: group[0]?.start ?? 0,
      total: segments.reduce((sum, { value }) => sum + value, 0)
    })
  }
  return bins
}

/** Select one bin, or with `extend` grow an existing selection to cover it. Unknown bins change nothing. */
export const selectBin = (
  selection: RlyChartSelection | null,
  bins: ReadonlyArray<RlyChartBin>,
  index: number,
  extend: boolean
): RlyChartSelection | null => {
  const bin = bins[index]
  if (bin === undefined) return selection
  if (!extend || selection === null) return { from: bin.first, to: bin.last }
  return { from: Math.min(selection.from, bin.first), to: Math.max(selection.to, bin.last) }
}

/** The bin a navigation key moves focus to, or `null` for any other key. */
export const moveFocus = (key: string, current: number, last: number): number | null => {
  const clamp = (next: number): number => Math.max(0, Math.min(last, next))
  switch (key) {
    case "ArrowLeft":
      return clamp(current - 1)
    case "ArrowRight":
      return clamp(current + 1)
    case "Home":
      return 0
    case "End":
      return last
    default:
      return null
  }
}

/**
 * Ticks at least `labelWidth` apart, from each bin's start in pixels on the shared time axis, so
 * uneven bins never crowd their labels. The last bin always gets an end-anchored tick, so the axis
 * says where it ends without a label clipping at the edge; ticks crowding it are dropped. One bin
 * gets its start and end when both fit, else its start alone.
 */
export const chartTicks = (
  starts: ReadonlyArray<number>,
  width: number,
  labelWidth: number
): ReadonlyArray<RlyChartTick> => {
  if (starts.length === 0) return []
  if (starts.length === 1) {
    return width >= 2 * labelWidth
      ? [{ anchor: "start", index: 0 }, { anchor: "end" }]
      : [{ anchor: "start", index: 0 }]
  }
  // Start ticks leave room for the end label, so no bin is labelled twice.
  const regular = starts.reduce<ReadonlyArray<{ readonly anchor: "start"; readonly index: number }>>(
    (ticks, x, index) => {
      const previous = ticks.at(-1)
      const previousX = previous === undefined ? Number.NEGATIVE_INFINITY : (starts[previous.index] ?? 0)
      return x - previousX >= labelWidth && x + labelWidth <= width - labelWidth
        ? [...ticks, { anchor: "start", index }]
        : ticks
    },
    []
  )
  return [...regular, { anchor: "end" }]
}
