import { Result, useAtomValue } from "@effect-atom/atom-react"
import { notificationsAtom } from "../atoms/app.js"
import { quickFilterTypeAtom, quickFilterValuesAtom } from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"

/**
 * Quick filters bar for PRs
 * @category components
 */
export function QuickFilters() {
  const { theme } = useTheme()
  const filterType = useAtomValue(quickFilterTypeAtom)
  const filterValues = useAtomValue(quickFilterValuesAtom)
  const filterValue = filterValues[filterType]
  const notificationsResult = useAtomValue(notificationsAtom)
  const notifications = Result.getOrElse(notificationsResult, () => ({ items: [] }))

  const errorCount = notifications.items.filter((n) => n.type === "error").length
  const totalCount = notifications.items.length

  return (
    <box
      style={{
        height: 1,
        width: "100%",
        backgroundColor: theme.backgroundElement,
        flexDirection: "row",
        paddingLeft: 1,
        justifyContent: "space-between"
      }}
    >
      <box style={{ flexDirection: "row" }}>
        <box
          style={{
            ...(filterType === "all" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "all" ? theme.selectedText : theme.textMuted}>[1] All</text>
        </box>
        <box
          style={{
            ...(filterType === "mine" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "mine" ? theme.selectedText : theme.textMuted}>
            [2] Mine{filterType === "mine" && filterValue ? `: ${filterValue}` : ""}
          </text>
        </box>
        <box
          style={{
            ...(filterType === "account" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "account" ? theme.selectedText : theme.textMuted}>
            [3] Acct{filterType === "account" && filterValue ? `: ${filterValue}` : ""}
          </text>
        </box>
        <box
          style={{
            ...(filterType === "author" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "author" ? theme.selectedText : theme.textMuted}>
            [4] Auth{filterType === "author" && filterValue ? `: ${filterValue}` : ""}
          </text>
        </box>
        <box
          style={{
            ...(filterType === "scope" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "scope" ? theme.selectedText : theme.textMuted}>
            [5] Scope{filterType === "scope" && filterValue ? `: ${filterValue}` : ""}
          </text>
        </box>
        <box
          style={{
            ...(filterType === "date" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "date" ? theme.selectedText : theme.textMuted}>
            [6] Age
            {filterType === "date" && filterValue
              ? `: ${
                  filterValue === "today"
                    ? "24h"
                    : filterValue === "week"
                      ? "7d"
                      : filterValue === "month"
                        ? "30d"
                        : "30d+"
                }`
              : ""}
          </text>
        </box>
        <box
          style={{
            ...(filterType === "repo" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "repo" ? theme.selectedText : theme.textMuted}>
            [7] Repo{filterType === "repo" && filterValue ? `: ${filterValue}` : ""}
          </text>
        </box>
        <box
          style={{
            ...(filterType === "status" && { backgroundColor: theme.primary }),
            paddingLeft: 1,
            paddingRight: 1
          }}
        >
          <text fg={filterType === "status" ? theme.selectedText : theme.textMuted}>
            [8] Status{filterType === "status" && filterValue ? `: ${filterValue}` : ""}
          </text>
        </box>
        {(filterType === "mine" ||
          filterType === "account" ||
          filterType === "author" ||
          filterType === "scope" ||
          filterType === "date" ||
          filterType === "repo" ||
          filterType === "status") && <text fg={theme.textMuted}>[←→]</text>}
      </box>
      <box style={{ flexDirection: "row", paddingRight: 1 }}>
        {errorCount > 0 && (
          <box style={{ backgroundColor: theme.error, paddingLeft: 1, paddingRight: 1, marginRight: 1 }}>
            <text fg={theme.selectedText}>[n] Errors ({errorCount})</text>
          </box>
        )}
        {totalCount > errorCount && (
          <box style={{ paddingLeft: 1, paddingRight: 1 }}>
            <text fg={theme.textMuted}>Notif ({totalCount})</text>
          </box>
        )}
      </box>
    </box>
  )
}
