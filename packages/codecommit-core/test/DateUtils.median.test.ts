import { describe, expect, it } from "@effect/vitest"
import { median } from "../src/DateUtils.js"

describe("median", () => {
  // Edge case: StatsService returns null when no detail data exists for a metric
  it("returns null for empty array", () => {
    expect(median([])).toBe(null)
  })

  // Base case: single PR in the week — median equals that PR's duration
  it("returns the single element for length-1 array", () => {
    expect(median([42])).toBe(42)
  })

  // Odd count: verifies correct middle element selection after sorting
  it("returns middle element for odd-length array", () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  // Even count: verifies averaging of two middle elements (e.g. 4 PRs merged)
  it("returns average of two middle elements for even-length array", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  // Safety: median is called on detail arrays from SQL — must not reorder originals
  it("does not mutate the input array", () => {
    const input = [5, 3, 1, 4, 2]
    median(input)
    expect(input).toEqual([5, 3, 1, 4, 2])
  })

  // Real-world: many PRs with similar merge times should collapse to that value
  it("handles duplicate values", () => {
    expect(median([1, 1, 1, 1, 1])).toBe(1)
  })

  // Core reason for median over avg: one stale PR (1000ms) shouldn't skew the metric
  // avg([1,2,3,4,1000]) = 202, but median = 3 — reflects typical PR experience
  it("handles large spread (outlier-resistant check)", () => {
    expect(median([1000, 1, 3, 4, 2])).toBe(3)
  })
})
