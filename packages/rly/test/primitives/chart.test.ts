import { describe, expect, it } from "vitest"
import {
  binColumns,
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

describe("chart model", () => {
  it("bins only as coarsely as needed to keep every bar at least the minimum width", () => {
    expect(chooseBinSize(720, 24)).toBe(1)
    expect(chooseBinSize(720, 168)).toBe(2)
    expect(chooseBinSize(320, 168)).toBe(6)
    expect(chooseBinSize(40, 168)).toBe(48)
    expect(chooseBinSize(0, 0)).toBe(1)
    // Past a day per bar, bins grow in whole days until every bar is 6px wide again.
    expect(chooseBinSize(320, 2000)).toBe(48)
    expect(320 / Math.ceil(2000 / chooseBinSize(320, 2000))).toBeGreaterThanOrEqual(6)
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
      const size = chooseBinSize(width, count)
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
    const ticks = chartTicks(24, 480, 70)
    expect(ticks.map(({ index }) => index)).toEqual([0, 4, 8, 12, 16, 23])
    expect(ticks.at(-1)?.anchor).toBe("end")
    expect(ticks[0]?.anchor).toBe("start")
    expect(chartTicks(1, 480, 70)).toEqual([{ anchor: "start", index: 0 }])
    expect(chartTicks(0, 480, 70)).toEqual([])
  })
})
