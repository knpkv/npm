/**
 * Ticket table with cursor selection and inline filtering.
 *
 * @internal
 */
import { Result, useAtomValue } from "@effect-atom/atom-react"
import type { TicketState } from "../../services/TicketService.js"
import { ticketsAtom } from "../atoms/tickets.js"
import { filterTextAtom, isFilteringAtom, selectedIndexAtom } from "../atoms/ui.js"
import { TicketRow } from "./TicketRow.js"

export function TicketList() {
  const ticketResult = useAtomValue(ticketsAtom)
  const selectedIndex = useAtomValue(selectedIndexAtom)
  const filterText = useAtomValue(filterTextAtom)
  const isFiltering = useAtomValue(isFilteringAtom)

  const ticketState: TicketState | null = Result.isSuccess(ticketResult) ? ticketResult.value : null

  if (!ticketState || ticketState.loading) {
    return (
      <box style={{ flexGrow: 1, paddingLeft: 2 } as any}>
        <text fg="#FFCC00">Loading tickets...</text>
      </box>
    )
  }

  if (ticketState.error) {
    return (
      <box style={{ flexGrow: 1, paddingLeft: 2 } as any}>
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
      <box style={{ flexGrow: 1, paddingLeft: 2 } as any}>
        <text fg="#888888">{filterText ? `No tickets matching "${filterText}"` : "No tickets found"}</text>
      </box>
    )
  }

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      {/* Section header */}
      <box
        style={
          {
            height: 1,
            paddingLeft: 2,
            paddingTop: 1
          } as any
        }
      >
        <text fg="#FFCC00" style={{ fontWeight: "bold" } as any}>
          TICKETS
        </text>
        <text fg="#888888">{` (${tickets.length})`}</text>
        {isFiltering ? <text fg="#00CCFF">{` filter: ${filterText}│`}</text> : null}
      </box>
      {tickets.map((ticket, i) => (
        <TicketRow key={ticket.key} ticket={ticket} selected={i === selectedIndex} />
      ))}
    </box>
  )
}
