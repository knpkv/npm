/**
 * Ticket table with cursor selection and inline filtering.
 *
 * @internal
 */
import { useAtomValue } from "@effect/atom-react"
import type { JSX } from "@opentui/react/jsx-runtime"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { TicketState } from "../../services/TicketService.js"
import { ticketsAtom } from "../atoms/tickets.js"
import { filterTextAtom, isFilteringAtom, selectedIndexAtom } from "../atoms/ui.js"
import { TicketRow } from "./TicketRow.js"

type BoxStyle = NonNullable<JSX.IntrinsicElements["box"]["style"]>

const fillStyle = { flexGrow: 1, paddingLeft: 2 } satisfies BoxStyle
const listStyle = { flexDirection: "column", flexGrow: 1 } satisfies BoxStyle
const sectionHeaderStyle = { height: 1, paddingLeft: 2, paddingTop: 1 } satisfies BoxStyle

export function TicketList() {
  const ticketResult = useAtomValue(ticketsAtom)
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const filterText = useAtomValue(filterTextAtom)
  const isFiltering = useAtomValue(isFilteringAtom)

  const ticketState: TicketState | null = AsyncResult.isSuccess(ticketResult) ? ticketResult.value : null

  if (!ticketState || ticketState.loading) {
    return (
      <box style={fillStyle}>
        <text fg="#FFCC00">Loading tickets...</text>
      </box>
    )
  }

  if (ticketState.error) {
    return (
      <box style={fillStyle}>
        <text fg="#FF4444">Error: {ticketState.error}</text>
      </box>
    )
  }

  // Apply filter
  let tickets = ticketState.tickets
  if (filterText.trim()) {
    const lower = filterText.toLowerCase()
    tickets = tickets.filter(
      (t) =>
        t.key.toLowerCase().includes(lower) ||
        t.summary.toLowerCase().includes(lower) ||
        t.status.toLowerCase().includes(lower)
    )
  }

  if (tickets.length === 0) {
    return (
      <box style={fillStyle}>
        <text fg="#888888">{filterText ? `No tickets matching "${filterText}"` : "No tickets found"}</text>
      </box>
    )
  }

  return (
    <box style={listStyle}>
      {/* Section header */}
      <box style={sectionHeaderStyle}>
        <text fg="#FFCC00">TICKETS</text>
        <text fg="#888888">{` (${tickets.length})`}</text>
        {isFiltering ? <text fg="#00CCFF">{` filter: ${filterText}│`}</text> : null}
      </box>
      {tickets.map((ticket, i) => (
        <TicketRow key={ticket.key} ticket={ticket} selected={i === selectedIndex} />
      ))}
    </box>
  )
}
