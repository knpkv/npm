/**
 * What the Booking table shows and in which order: the columns worth a glance by default, the token
 * breakdown on request, and a sort the viewer controls.
 *
 * @module
 */
import { Predicate } from "effect"
import { totalTokens } from "../core/Model.js"
import type { BookingSummary } from "../shared/contracts.js"
import { bookingLabel } from "./chartModel.js"

export type BookingColumn =
  | "booking"
  | "title"
  | "agents"
  | "requests"
  | "input"
  | "output"
  | "cacheRead"
  | "cacheWrite"
  | "tokens"
  | "cost"

export type SortDirection = "ascending" | "descending"

export interface BookingSort {
  readonly column: BookingColumn
  readonly direction: SortDirection
}

export const DEFAULT_SORT: BookingSort = { column: "cost", direction: "descending" }

const BREAKDOWN: ReadonlyArray<BookingColumn> = ["input", "output", "cacheRead", "cacheWrite"]
const TEXT_COLUMNS: ReadonlySet<BookingColumn> = new Set(["booking", "title", "agents"])

/**
 * The columns to show: a title only when some Booking is a ticket (a repo has none to show), and the
 * token breakdown only when asked for.
 */
export const bookingColumns = (
  bookings: ReadonlyArray<BookingSummary>,
  breakdown: boolean
): ReadonlyArray<BookingColumn> => {
  const title: ReadonlyArray<BookingColumn> = bookings.some((summary) => summary.booking._tag === "Ticket")
    ? ["title"]
    : []
  return ["booking", ...title, "agents", "requests", ...(breakdown ? BREAKDOWN : []), "tokens", "cost"]
}

/** Fall back to the default cost sort while the chosen column is hidden. */
export const visibleSort = (sort: BookingSort, columns: ReadonlyArray<BookingColumn>): BookingSort =>
  columns.includes(sort.column) ? sort : DEFAULT_SORT

const titleText = (summary: BookingSummary): string => (summary.title?._tag === "Known" ? summary.title.summary : "")

const sortValue = (summary: BookingSummary, column: BookingColumn): number | string => {
  switch (column) {
    case "booking":
      return bookingLabel(summary.booking)
    case "title":
      return titleText(summary)
    case "agents":
      return summary.agents.join(", ")
    case "requests":
      return summary.requests
    case "input":
      return summary.tokens.input
    case "output":
      return summary.tokens.output + summary.tokens.reasoning
    case "cacheRead":
      return summary.tokens.cacheRead
    case "cacheWrite":
      return summary.tokens.cacheWrite5m + summary.tokens.cacheWrite1h
    case "tokens":
      return totalTokens(summary.tokens)
    case "cost":
      // A Booking with unpriced tokens sorts by the part that has a price.
      return summary.costUsd
  }
}

const compare = (left: number | string, right: number | string): number =>
  Predicate.isNumber(left) && Predicate.isNumber(right) ? left - right : String(left).localeCompare(String(right))

/** The Bookings in the viewer's order; ties fall back to the Booking's name. */
export const sortBookings = (
  bookings: ReadonlyArray<BookingSummary>,
  sort: BookingSort
): ReadonlyArray<BookingSummary> => {
  const sign = sort.direction === "ascending" ? 1 : -1
  return [...bookings].sort(
    (left, right) =>
      sign * compare(sortValue(left, sort.column), sortValue(right, sort.column)) ||
      bookingLabel(left.booking).localeCompare(bookingLabel(right.booking))
  )
}

/** Pressing a column: a new one starts largest first (names A to Z); the same one flips. */
export const nextSort = (current: BookingSort, column: BookingColumn): BookingSort =>
  current.column === column
    ? { column, direction: current.direction === "ascending" ? "descending" : "ascending" }
    : { column, direction: TEXT_COLUMNS.has(column) ? "ascending" : "descending" }
