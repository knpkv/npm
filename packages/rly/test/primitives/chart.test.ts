import { describe, expect, it } from "vitest"
import {
  binColumns,
  binRates,
  chartTicks,
  chooseBinSize,
  moveFocus,
  type RlyChartColumn,
  selectBin
} from "../../src/internal/chart.js"

const hour = 3_600_000
const column = (index: number, values: Record<string, number>): RlyChartColumn => ({
  end: (index + 1) * hour,
  segments: Object.entries(values).map(([id, value]) => ({ id, series: id === "rest" ? "other" : 1, value })),
  start: index * hour
})

const hourly = (count: number): ReadonlyArray<RlyChartColumn> =>
  Array.from({ length: count }, (_, index) => column(index, { a: 1 }))

describe("chart model", () => {
  it("bins only as coarsely as needed to keep every bar at least the minimum width", () => {
    expect(chooseBinSize(720, hourly(24))).toBe(1)
    expect(chooseBinSize(720, hourly(168))).toBe(2)
    expect(chooseBinSize(320, hourly(168))).toBe(6)
    expect(chooseBinSize(40, hourly(168))).toBe(48)
    expect(chooseBinSize(0, [])).toBe(1)
    // Past a day per bar, bins grow in whole days until every bar is 6px wide again.
    expect(chooseBinSize(320, hourly(2000))).toBe(48)
  })

  it("bins a very long history without overflowing the stack, and keeps 24px pointer targets", () => {
    const minutes: ReadonlyArray<RlyChartColumn> = Array.from({ length: 150_000 }, (_, index) => ({
      end: (index + 1) * 60_000,
      segments: [],
      start: index * 60_000
    }))
    const size = chooseBinSize(720, minutes, 24)
    const bins = binColumns(minutes, size)
    expect(Math.min(...bins.slice(0, -1).map((bin) => ((bin.last - bin.first + 1) / minutes.length) * 720)))
      .toBeGreaterThanOrEqual(24)
    // A 403px week at 24px targets: every hourly bar is a full pointer target.
    const week = hourly(168)
    const weekSize = chooseBinSize(403, week, 24)
    for (const bin of binColumns(week, weekSize)) {
      expect(((bin.last - bin.first + 1) / 168) * 403).toBeGreaterThanOrEqual(24)
    }
  })

  it("measures bars on the time axis, so a short period among long ones is never drawn under 6px", () => {
    const uneven: ReadonlyArray<RlyChartColumn> = [
      { end: hour, segments: [], start: 0 },
      { end: 1000 * hour, segments: [], start: hour }
    ]
    // Each column alone would leave the first bar 0.72px wide; together they are one bar.
    expect(chooseBinSize(720, uneven)).toBe(2)
    expect(binColumns(uneven, 2)).toHaveLength(1)
  })

  it("picks the finest whole-day bin whose every bar is wide enough, never an estimate above it", () => {
    const day = 24
    const narrowest = (columns: ReadonlyArray<RlyChartColumn>, size: number, width: number): number => {
      const span = (columns.at(-1)?.end ?? 0) - (columns[0]?.start ?? 0)
      return Math.min(...binColumns(columns, size).map((bin) => ((bin.end - bin.start) / span) * width))
    }
    const cases: ReadonlyArray<readonly [width: number, columns: number]> = [
      [320, 2000],
      [200, 1500],
      [480, 4000]
    ]
    for (const [width, count] of cases) {
      const columns = hourly(count)
      const size = chooseBinSize(width, columns)
      expect(narrowest(columns, size, width)).toBeGreaterThanOrEqual(6)
      if (size > 2 * day && size < count) expect(narrowest(columns, size - day, width)).toBeLessThan(6)
    }
  })

  it("turns each bin's total into a rate per nominal bin, so a folded bin is not taller for holding more time", () => {
    const columns = hourly(25)
    const bins = binColumns(columns, 2)
    const rates = binRates(bins, columns, 2)
    expect(rates[0]).toBeCloseTo(1)
    expect(rates.at(-1)).toBeCloseTo(2 / 3)
    // Three hours of 1 each, as a rate per two hours, stand as tall as two hours of 1.
    expect((bins.at(-1)?.total ?? 0) * (rates.at(-1) ?? 0)).toBeCloseTo(bins[0]?.total ?? 0)
  })

  it("measures rates against the columns' own lengths, so a gap between periods changes nothing", () => {
    const sparse = [column(0, { a: 1 }), column(9, { a: 1 })]
    expect(binRates(binColumns(sparse, 1), sparse, 1)).toEqual([1, 1])
  })

  it("treats non-finite values as no reading, so one failed reading cannot poison the chart", () => {
    const [bin] = binColumns(
      [column(0, { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: Number.NEGATIVE_INFINITY, d: 2 })],
      1
    )
    expect(bin?.total).toBe(2)
    expect(bin?.segments.map(({ id }) => id)).toEqual(["d"])
  })

  it("merges a bin's segments by id in the order the series first appear, offsetting each on the last", () => {
    const bins = binColumns(
      [column(0, { a: 2, rest: 1 }), column(1, { b: 3, a: 1 }), column(2, { b: 1 }), column(3, { b: 1 })],
      2
    )
    expect(bins).toHaveLength(2)
    const [first, second] = bins
    expect(first).toMatchObject({ end: 2 * hour, first: 0, last: 1, start: 0, total: 7 })
    expect(first?.segments).toEqual([
      { id: "a", offset: 0, series: 1, value: 3 },
      { id: "rest", offset: 3, series: "other", value: 1 },
      { id: "b", offset: 4, series: 1, value: 3 }
    ])
    expect(second).toMatchObject({ first: 2, last: 3, total: 2 })
  })

  it("folds a short trailing remainder into the bin before it, so no bar is narrower than the rest", () => {
    const columns = Array.from({ length: 25 }, (_, index) => column(index, { a: 1 }))
    const bins = binColumns(columns, 2)
    expect(bins).toHaveLength(12)
    expect(bins.at(-1)).toMatchObject({ first: 22, last: 24 })
    // Every bar at the chosen size keeps the 6px minimum on a time-proportional axis, remainder included.
    const cases: ReadonlyArray<readonly [width: number, count: number]> = [[100, 25], [320, 1009], [100, 24]]
    for (const [width, count] of cases) {
      const size = chooseBinSize(width, hourly(count))
      const narrowest = Math.min(
        ...binColumns(Array.from({ length: count }, (_, index) => column(index, { a: 1 })), size).map(
          (bin) => ((bin.last - bin.first + 1) / count) * width
        )
      )
      expect(narrowest).toBeGreaterThanOrEqual(6)
    }
    expect(binColumns(columns.slice(0, 1), 2)).toHaveLength(1)
  })

  it("drops empty and negative segments rather than drawing them", () => {
    const [bin] = binColumns([column(0, { a: 0, b: -2, c: 1 })], 1)
    expect(bin?.segments.map(({ id }) => id)).toEqual(["c"])
  })

  it("selects a bin's column range, and extends an existing selection to cover another bin", () => {
    const bins = binColumns([0, 1, 2, 3, 4, 5].map((index) => column(index, { a: 1 })), 2)
    expect(selectBin(null, bins, 1, false)).toEqual({ from: 2, to: 3 })
    expect(selectBin({ from: 2, to: 3 }, bins, 0, true)).toEqual({ from: 0, to: 3 })
    expect(selectBin({ from: 2, to: 3 }, bins, 2, true)).toEqual({ from: 2, to: 5 })
    expect(selectBin(null, bins, 2, true)).toEqual({ from: 4, to: 5 })
    expect(selectBin({ from: 0, to: 1 }, bins, 9, false)).toEqual({ from: 0, to: 1 })
  })

  it("moves focus with arrows, Home and End, clamped to the bins", () => {
    expect(moveFocus("ArrowLeft", 3, 5)).toBe(2)
    expect(moveFocus("ArrowLeft", 0, 5)).toBe(0)
    expect(moveFocus("ArrowRight", 5, 5)).toBe(5)
    expect(moveFocus("Home", 3, 5)).toBe(0)
    expect(moveFocus("End", 0, 5)).toBe(5)
    expect(moveFocus("Enter", 3, 5)).toBeNull()
  })

  it("spaces ticks at least the label width apart and anchors the last one to the end", () => {
    const indices = (ticks: ReturnType<typeof chartTicks>) =>
      ticks.map((tick) => (tick.anchor === "end" ? "end" : tick.index))
    expect(indices(chartTicks(Array.from({ length: 24 }, (_, index) => index * 20), 480, 70))).toEqual([
      0,
      4,
      8,
      12,
      16,
      "end"
    ])
    // Uneven bins: ticks follow where bins actually start, never crowding their labels.
    expect(indices(chartTicks([0, 10, 20, 400], 480, 70))).toEqual([0, "end"])
    // The end label is the axis end, never a second label for the last bin.
    expect(indices(chartTicks([0, 100], 1000, 72))).toEqual([0, 1, "end"])
    // One bin names both ends when both fit, else its start alone.
    expect(indices(chartTicks([0], 480, 70))).toEqual([0, "end"])
    expect(indices(chartTicks([0], 100, 70))).toEqual([0])
    expect(chartTicks([], 480, 70)).toEqual([])
  })
})
