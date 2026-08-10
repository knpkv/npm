import { useTheme } from "../context/theme.js"
import type { ListItem } from "../ListBuilder.js"
import { isAwsAuthenticationNotification } from "../notification-auth.js"
import { Badge } from "./Badge.js"
import { type Column, Table } from "./Table.js"

interface NotificationsTableProps {
  readonly items: ReadonlyArray<ListItem>
  readonly selectedIndex: number
}

/**
 * Table for notifications view
 * @category components
 */
export function NotificationsTable({ items, selectedIndex }: NotificationsTableProps) {
  const { theme } = useTheme()

  const columns: Array<Column<ListItem>> = [
    {
      header: "TYPE",
      width: 8,
      render: (item) => {
        if (item.type !== "notification") return null
        const type = item.notification.type
        if (type === "error") {
          return (
            <Badge variant="error" minWidth={5}>
              ERR
            </Badge>
          )
        }
        if (type === "warning") {
          return (
            <Badge variant="warning" minWidth={5}>
              WARN
            </Badge>
          )
        }
        if (type === "success") {
          return (
            <Badge variant="success" minWidth={5}>
              OK
            </Badge>
          )
        }
        return (
          <Badge variant="info" minWidth={5}>
            INFO
          </Badge>
        )
      }
    },
    {
      header: "MESSAGE",
      width: "auto",
      render: (item, selected) => {
        if (item.type !== "notification") return null
        const fg = selected ? theme.selectedText : theme.text
        return <text fg={fg}>{`${item.notification.title}: ${item.notification.message}`}</text>
      }
    },
    {
      header: "ACTION",
      width: 22,
      render: (item, selected) => {
        if (item.type !== "notification") return null
        if (isAwsAuthenticationNotification(item.notification.message)) {
          const bg = selected ? theme.successTint : theme.accentTint
          const fg = selected ? theme.textSuccess : theme.textAccent
          return (
            <box
              style={{
                backgroundColor: bg,
                paddingLeft: 1,
                paddingRight: 1
              }}
            >
              <text fg={fg}>{selected ? "⏎ Sign in" : "  Sign in"}</text>
            </box>
          )
        }
        return null
      }
    },
    {
      header: "TIME",
      width: 15,
      render: (item) => {
        if (item.type !== "notification") return null
        return (
          <text fg={theme.textMuted}>
            {new Date(item.notification.createdAt).toLocaleTimeString("en-GB", { hour12: false })}
          </text>
        )
      }
    }
  ]

  return (
    <Table
      data={items}
      columns={columns}
      selectedIndex={selectedIndex}
      keyExtractor={(i) => (i.type === "notification" ? `${i.notification.id}` : "")}
    />
  )
}
