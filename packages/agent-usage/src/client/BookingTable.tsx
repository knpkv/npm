/**
 * Every Booking in the range with its requests, tokens and API-equivalent cost, on rly's
 * EntityTable (a table on wide screens, a stack of labelled rows on narrow ones). Pressing a
 * Booking draws only it in the usage chart; pressing it again draws them all.
 *
 * @module
 */
import { type RlyEntityTableColumn, type RlyEntityTableRow, EntityTable } from "@knpkv/rly/patterns"
import { useState } from "react"
import { totalTokens } from "../core/Model.js"
import type { BookingSummary } from "../shared/contracts.js"
import {
  type BookingColumn,
  type BookingSort,
  bookingColumns,
  DEFAULT_SORT,
  nextSort,
  sortBookings,
  visibleSort
} from "./bookingModel.js"
import { bookingLabel, OTHER } from "./chartModel.js"
import { formatTokens, formatUsd } from "../limits/format.js"
import { seriesColor } from "./UsageChart.js"

const LABELS = {
  booking: "Booking",
  title: "Title",
  agents: "Agents",
  requests: "Requests",
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  tokens: "Tokens",
  cost: "API-eq. cost"
} satisfies Record<BookingColumn, string>

const titleOf = (summary: BookingSummary): string =>
  summary.booking._tag === "Repo"
    ? ""
    : summary.title === null
      ? "title not looked up yet"
      : summary.title._tag === "Known"
        ? summary.title.summary
        : summary.title.reason === "NotFound"
          ? "not found in Jira"
          : "title not looked up yet"

/** The cost cell: the priced part, and "?" when some of the tokens have no price. */
const costOf = (summary: BookingSummary): string =>
  summary.unpricedTokens === 0
    ? formatUsd(summary.costUsd)
    : summary.costUsd === 0
      ? "?"
      : `${formatUsd(summary.costUsd)} + ?`

const NumberCell = (props: { readonly value: string; readonly title?: string | undefined }) => (
  <span className="usage-number" title={props.title}>
    {props.value}
  </span>
)

export const BookingTable = (props: {
  readonly bookings: ReadonlyArray<BookingSummary>
  readonly named: ReadonlySet<string>
  readonly slots: ReadonlyMap<string, number>
  readonly selected: string | null
  readonly onSelect: (id: string | null) => void
}) => {
  const [sort, setSort] = useState<BookingSort>(DEFAULT_SORT)
  const [breakdown, setBreakdown] = useState(false)
  const shown = bookingColumns(props.bookings, breakdown)
  const effectiveSort = visibleSort(sort, shown)
  const columns = shown.map((id): RlyEntityTableColumn => ({
    id,
    label: LABELS[id],
    sortable: true,
    sortDirection: effectiveSort.column === id ? effectiveSort.direction : "none"
  }))
  const [first, ...rest] = columns
  const cell = (summary: BookingSummary, column: BookingColumn) => {
    const selected = props.selected === summary.id
    switch (column) {
      case "booking":
        return (
          <button
            aria-pressed={selected}
            className="usage-row-button"
            onClick={() => props.onSelect(selected ? null : summary.id)}
            type="button"
          >
            <span
              className="usage-swatch"
              style={{ background: seriesColor(props.named.has(summary.id) ? summary.id : OTHER, props.slots) }}
            />
            {bookingLabel(summary.booking)}
          </button>
        )
      case "title":
        // The cell ellipsizes a long summary; the title keeps the whole text reachable.
        return (
          <span className="usage-title" title={titleOf(summary)}>
            {titleOf(summary)}
          </span>
        )
      case "agents":
        return summary.agents.join(", ")
      case "requests":
        return <NumberCell value={summary.requests.toLocaleString()} />
      case "input":
        return <NumberCell value={formatTokens(summary.tokens.input)} />
      case "output":
        return <NumberCell value={formatTokens(summary.tokens.output + summary.tokens.reasoning)} />
      case "cacheRead":
        return <NumberCell value={formatTokens(summary.tokens.cacheRead)} />
      case "cacheWrite":
        return <NumberCell value={formatTokens(summary.tokens.cacheWrite5m + summary.tokens.cacheWrite1h)} />
      case "tokens":
        return <NumberCell value={formatTokens(totalTokens(summary.tokens))} />
      case "cost":
        return (
          <NumberCell
            title={
              summary.unpricedModels.length === 0 ? undefined : `No price for ${summary.unpricedModels.join(", ")}`
            }
            value={costOf(summary)}
          />
        )
    }
  }
  const rows = sortBookings(props.bookings, effectiveSort).map((summary): RlyEntityTableRow => ({
    id: summary.id,
    cells: shown.map((column) => ({ columnId: column, content: cell(summary, column) }))
  }))
  if (first === undefined) return null
  return (
    // Numbers align right from the Requests column on; the column before it depends on the title.
    <div className="usage-bookings" data-breakdown={breakdown} data-numeric-from={shown.indexOf("requests") + 1}>
      <EntityTable
        columns={[first, ...rest]}
        density="compact"
        data={
          rows.length === 0
            ? { state: "empty", title: "No bookings", description: "Nothing was used in this range." }
            : { state: "ready", rows }
        }
        heading="Bookings"
        headingSize="card"
        onSortChange={(id) => {
          const column = shown.find((candidate) => candidate === id)
          if (column !== undefined) setSort(nextSort(effectiveSort, column))
        }}
      />
      <label className="usage-breakdown-toggle">
        <input checked={breakdown} onChange={(event) => setBreakdown(event.currentTarget.checked)} type="checkbox" />
        Show token breakdown
      </label>
    </div>
  )
}
