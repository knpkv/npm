import { describe, expect, it } from "@effect/vitest"
import {
  bookingColumns,
  type BookingSort,
  DEFAULT_SORT,
  nextSort,
  sortBookings,
  visibleSort
} from "../src/client/bookingModel.js"
import type { BookingSummary } from "../src/shared/contracts.js"

const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

const summary = (id: string, costUsd: number, requests: number, total: number): BookingSummary => ({
  id,
  booking: { _tag: "Repo", name: id },
  title: null,
  agents: ["claude"],
  requests,
  tokens: { ...tokens, input: total },
  costUsd,
  unpricedTokens: 0,
  unpricedModels: []
})

const rows = [summary("a", 1, 30, 100), summary("b", 3, 10, 300), summary("c", 2, 20, 200)]

describe("sortBookings", () => {
  it("sorts by the chosen column, largest first by default, ties by name", () => {
    expect(sortBookings(rows, { column: "cost", direction: "descending" }).map((row) => row.id)).toEqual([
      "b",
      "c",
      "a"
    ])
    expect(sortBookings(rows, { column: "requests", direction: "ascending" }).map((row) => row.id)).toEqual([
      "b",
      "c",
      "a"
    ])
    expect(sortBookings(rows, { column: "booking", direction: "ascending" }).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c"
    ])
  })

  it("sorts a booking with unpriced tokens by its priced part", () => {
    const partly = { ...summary("d", 0, 1, 1), unpricedTokens: 5, unpricedModels: ["m"] }
    expect(sortBookings([...rows, partly], { column: "cost", direction: "descending" }).at(-1)?.id).toBe("d")
  })
})

describe("nextSort", () => {
  it("starts a numeric column largest first and flips on a second press", () => {
    expect(nextSort({ column: "cost", direction: "descending" }, "requests")).toEqual({
      column: "requests",
      direction: "descending"
    })
    expect(nextSort({ column: "requests", direction: "descending" }, "requests")).toEqual({
      column: "requests",
      direction: "ascending"
    })
    expect(nextSort({ column: "cost", direction: "descending" }, "booking")).toEqual({
      column: "booking",
      direction: "ascending"
    })
  })
})

describe("bookingColumns", () => {
  it("shows a title column only when some booking has a ticket, and the breakdown only on request", () => {
    expect(bookingColumns(rows, false)).toEqual(["booking", "agents", "requests", "tokens", "cost"])
    const ticket: BookingSummary = { ...summary("T-1", 1, 1, 1), booking: { _tag: "Ticket", key: "T-1" } }
    expect(bookingColumns([...rows, ticket], true)).toEqual([
      "booking",
      "title",
      "agents",
      "requests",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "tokens",
      "cost"
    ])
  })
})

describe("visibleSort", () => {
  it("falls back to cost when the breakdown or title column disappears, retaining visible sorts", () => {
    const shown = bookingColumns(rows, false)
    expect(visibleSort({ column: "input", direction: "ascending" }, shown)).toEqual(DEFAULT_SORT)
    expect(visibleSort({ column: "title", direction: "ascending" }, shown)).toEqual(DEFAULT_SORT)
    const current: BookingSort = { column: "cost", direction: "ascending" }
    expect(visibleSort(current, shown)).toBe(current)
    expect(visibleSort({ column: "input", direction: "ascending" }, bookingColumns(rows, true))).toEqual({
      column: "input",
      direction: "ascending"
    })
  })
})
