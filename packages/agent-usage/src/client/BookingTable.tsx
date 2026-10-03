/**
 * Every Booking in the range with its tokens and API-equivalent cost. Clicking a row draws only
 * that Booking in the usage chart; clicking it again draws them all.
 *
 * @module
 */
import { totalTokens } from "../core/Model.js"
import type { BookingSummary } from "../shared/contracts.js"
import { bookingLabel, OTHER } from "./chartModel.js"
import { formatTokens, formatUsd } from "./format.js"
import { seriesColor } from "./UsageChart.js"

const titleOf = (summary: BookingSummary): string =>
  summary.title === null
    ? "no ticket named"
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

export const BookingTable = (props: {
  readonly bookings: ReadonlyArray<BookingSummary>
  readonly named: ReadonlySet<string>
  readonly slots: ReadonlyMap<string, number>
  readonly selected: string | null
  readonly onSelect: (id: string | null) => void
}) => (
  <table className="usage-table">
    <caption>Bookings in this range</caption>
    <thead>
      <tr>
        <th scope="col">Booking</th>
        <th scope="col">Title</th>
        <th scope="col">Agents</th>
        <th className="usage-number" scope="col">
          Requests
        </th>
        <th className="usage-number" scope="col">
          Input
        </th>
        <th className="usage-number" scope="col">
          Output
        </th>
        <th className="usage-number" scope="col">
          Cache read
        </th>
        <th className="usage-number" scope="col">
          Cache write
        </th>
        <th className="usage-number" scope="col">
          Total tokens
        </th>
        <th className="usage-number" scope="col">
          API-eq. cost
        </th>
      </tr>
    </thead>
    <tbody>
      {props.bookings.map((summary) => {
        const selected = props.selected === summary.id
        return (
          <tr data-selected={selected} key={summary.id}>
            <th scope="row">
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
            </th>
            <td className="usage-title">{titleOf(summary)}</td>
            <td>{summary.agents.join(", ")}</td>
            <td className="usage-number">{summary.requests.toLocaleString()}</td>
            <td className="usage-number">{formatTokens(summary.tokens.input)}</td>
            <td className="usage-number">{formatTokens(summary.tokens.output + summary.tokens.reasoning)}</td>
            <td className="usage-number">{formatTokens(summary.tokens.cacheRead)}</td>
            <td className="usage-number">{formatTokens(summary.tokens.cacheWrite5m + summary.tokens.cacheWrite1h)}</td>
            <td className="usage-number">{formatTokens(totalTokens(summary.tokens))}</td>
            <td
              className="usage-number"
              title={
                summary.unpricedModels.length === 0 ? undefined : `No price for ${summary.unpricedModels.join(", ")}`
              }
            >
              {costOf(summary)}
            </td>
          </tr>
        )
      })}
    </tbody>
  </table>
)
