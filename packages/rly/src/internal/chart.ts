import type { RlySeries } from "../primitives/ChartLegend.js"

/** One series' value in one column. */
export interface RlyChartSegment {
  readonly id: string
  readonly series: RlySeries
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

export interface RlyChartTick {
  readonly index: number
  readonly anchor: "start" | "end"
}

/** Bin sizes that divide a day evenly, so bins line up with clock hours. */
const BIN_SIZES: ReadonlyArray<number> = [1, 2, 3, 6, 12, 24]

const DAY = 24

/** Where each bin starts, in column indices; a short trailing remainder joins the bin before it. */
const groupStarts = (count: number, size: number): ReadonlyArray<number> => {
  const starts: Array<number> = []
  for (let first = 0; first < count; first += size) starts.push(first)
  if (count % size > 0 && starts.length > 1) starts.pop()
  return starts
}

/** The narrowest bar, in pixels, that binning `columns` by `size` draws on the shared time axis. */
const narrowestBar = (columns: ReadonlyArray<RlyChartColumn>, size: number, width: number): number => {
  const from = columns[0]?.start ?? 0
  const span = Math.max(1, (columns[columns.length - 1]?.end ?? from) - from)
  const starts = groupStarts(columns.length, size)
  return Math.min(
    ...starts.map((first, index) => {
      const last = (starts[index + 1] ?? columns.length) - 1
      return (((columns[last]?.end ?? from) - (columns[first]?.start ?? from)) / span) * width
    })
  )
}

/**
 * The smallest bin size whose every bar, measured on the shared time axis, is at least `minBar`
 * pixels wide, so uneven or sparse periods are measured as drawn. Past a day per bar it grows in
 * whole days, so bins still line up with midnight; failing all, one bin holds everything.
 */
export const chooseBinSize = (width: number, columns: ReadonlyArray<RlyChartColumn>, minBar = 6): number => {
  if (columns.length === 0) return 1
  const days = Array.from({ length: Math.ceil(columns.length / DAY) }, (_, index) => (index + 2) * DAY)
  return [...BIN_SIZES, ...days].find((size) => narrowestBar(columns, size, width) >= minBar) ?? columns.length
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
  const from = columns[0]?.start ?? 0
  const average = Math.max(1, (columns[columns.length - 1]?.end ?? from) - from) / Math.max(1, columns.length)
  return bins.map((bin) => (average * size) / Math.max(1, bin.end - bin.start))
}

/**
 * Group columns into bins of `size`, merging segments by id in first-appearance order. A short
 * trailing remainder joins the bin before it, so the last bar is never narrower than the rest.
 */
export const binColumns = (columns: ReadonlyArray<RlyChartColumn>, size: number): ReadonlyArray<RlyChartBin> => {
  const bins: Array<RlyChartBin> = []
  const starts = groupStarts(columns.length, size)
  for (const [index, first] of starts.entries()) {
    const group = columns.slice(first, starts[index + 1] ?? columns.length)
    const values = new Map<string, RlyChartSegment>()
    for (const segment of group.flatMap((column) => column.segments)) {
      if (segment.value <= 0) continue
      const seen = values.get(segment.id)
      values.set(segment.id, { ...segment, value: (seen?.value ?? 0) + segment.value })
    }
    const segments = [...values.values()].reduce<Array<RlyChartBin["segments"][number]>>(
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
 * says where it ends without a label clipping at the edge; ticks crowding it are dropped.
 */
export const chartTicks = (
  starts: ReadonlyArray<number>,
  width: number,
  labelWidth: number
): ReadonlyArray<RlyChartTick> => {
  if (starts.length === 0) return []
  if (starts.length === 1) return [{ anchor: "start", index: 0 }]
  const regular = starts.reduce<ReadonlyArray<RlyChartTick>>((ticks, x, index) => {
    const previous = ticks.at(-1)
    const previousX = previous === undefined ? Number.NEGATIVE_INFINITY : (starts[previous.index] ?? 0)
    return x - previousX >= labelWidth && x + labelWidth <= width - labelWidth
      ? [...ticks, { anchor: "start", index }]
      : ticks
  }, [])
  return [...regular, { anchor: "end", index: starts.length - 1 }]
}
