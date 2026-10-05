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

/** The smallest bin size that keeps each bar at least `minBar` pixels wide. */
export const chooseBinSize = (width: number, count: number, minBar = 6): number => {
  if (count === 0) return 1
  return BIN_SIZES.find((size) => width / Math.ceil(count / size) >= minBar) ?? BIN_SIZES[BIN_SIZES.length - 1] ?? 1
}

/** Group columns into bins of `size`, merging segments by id in first-appearance order. */
export const binColumns = (columns: ReadonlyArray<RlyChartColumn>, size: number): ReadonlyArray<RlyChartBin> => {
  const bins: Array<RlyChartBin> = []
  for (let first = 0; first < columns.length; first += size) {
    const group = columns.slice(first, first + size)
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
 * Tick positions at least `labelWidth` apart. The last bin always gets an end-anchored tick, so the
 * axis says where it ends without a label clipping at the edge; ticks crowding it are dropped.
 */
export const chartTicks = (count: number, width: number, labelWidth: number): ReadonlyArray<RlyChartTick> => {
  if (count === 0) return []
  if (count === 1) return [{ anchor: "start", index: 0 }]
  const bar = width / count
  const every = Math.max(1, Math.ceil(labelWidth / bar))
  const regular = Array.from({ length: Math.ceil(count / every) }, (_, step) => step * every)
    .filter((index) => index * bar + labelWidth <= width - labelWidth)
    .map((index): RlyChartTick => ({ anchor: "start", index }))
  return [...regular, { anchor: "end", index: count - 1 }]
}
