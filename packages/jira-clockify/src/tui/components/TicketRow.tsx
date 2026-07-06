/**
 * Single ticket row — key, summary, status, priority columns.
 *
 * @internal
 */
import type { JSX } from "@opentui/react/jsx-runtime"
import type { JiraTicket } from "../../services/TicketService.js"

type BoxStyle = NonNullable<JSX.IntrinsicElements["box"]["style"]>

interface TicketRowProps {
  readonly ticket: JiraTicket
  readonly selected: boolean
}

const statusColor = (status: string): string => {
  const s = status.toLowerCase()
  if (s.includes("progress") || s.includes("development")) return "#5599FF"
  if (s.includes("review")) return "#CC88FF"
  if (s.includes("to do") || s.includes("open")) return "#FFCC00"
  if (s.includes("done") || s.includes("closed")) return "#00CC66"
  if (s.includes("block") || s.includes("impediment")) return "#FF4444"
  if (s.includes("deploy") || s.includes("stage")) return "#00CC66"
  if (s.includes("duplicate")) return "#888888"
  return "#CCCCCC"
}

const typeIcon = (type: string): string => {
  switch (type.toLowerCase()) {
    case "bug":
      return "🐛"
    case "story":
      return "📖"
    case "task":
      return "✓"
    case "epic":
      return "⚡"
    case "subtask":
    case "sub-task":
      return "↳"
    default:
      return "·"
  }
}

export function TicketRow({ selected, ticket }: TicketRowProps) {
  const bg = selected ? "#1a2744" : undefined
  const keyFg = selected ? "#00CCFF" : "#FFFFFF"
  const summaryFg = selected ? "#CCCCCC" : "#999999"
  const rowStyle = {
    height: 1,
    flexDirection: "row",
    paddingLeft: 1,
    ...(bg ? { backgroundColor: bg } : {})
  } satisfies BoxStyle

  return (
    <box style={rowStyle}>
      <text fg={keyFg}>{selected ? "❯" : " "}</text>
      <text fg="#888888">{typeIcon(ticket.type)}</text>
      <text fg={keyFg}>{ticket.key.padEnd(12)}</text>
      <text fg={summaryFg}>{ticket.summary.slice(0, 50).padEnd(50)}</text>
      <text fg={statusColor(ticket.status)}>{` ${ticket.status}`}</text>
    </box>
  )
}
