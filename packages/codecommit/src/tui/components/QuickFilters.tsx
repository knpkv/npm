import { Result, useAtomValue } from "@effect-atom/atom-react"
import type { PaginatedNotifications } from "@knpkv/codecommit-core/CacheService.js"
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
  const notifications: PaginatedNotifications = Result.getOrElse(notificationsResult, () => ({ items: [] }))

  const errorCount = notifications.items.filter((n) => n.type === "error").length
  const totalCount = notifications.items.length

  const pill = (key: string, label: string, type: string, value?: string) => (
    <box
      key={key}
      style={{
        ...(filterType === type && { backgroundColor: type === "hot" ? theme.warning : theme.primary }),
        paddingLeft: 1,
        paddingRight: 1
      }}
    >
      <text fg={filterType === type ? theme.selectedText : theme.textMuted}>
        {label}
        {filterType === type && value ? `: ${value}` : ""}
      </text>
    </box>
  )

  const dateLabel =
    filterValue === "today" ? "24h" : filterValue === "week" ? "7d" : filterValue === "month" ? "30d" : "30d+"

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
        {pill("all", "[1] All", "all")}
        {pill("hot", "[2] Hot", "hot")}
        {pill("mine", "[3] Mine", "mine", filterType === "mine" ? filterValue : undefined)}
        {pill("account", "[4] Acct", "account", filterType === "account" ? filterValue : undefined)}
        {pill("author", "[5] Auth", "author", filterType === "author" ? filterValue : undefined)}
        {pill("scope", "[6] Scope", "scope", filterType === "scope" ? filterValue : undefined)}
        {pill("date", "[7] Age", "date", filterType === "date" ? dateLabel : undefined)}
        {pill("repo", "[8] Repo", "repo", filterType === "repo" ? filterValue : undefined)}
        {pill("status", "[9] Status", "status", filterType === "status" ? filterValue : undefined)}
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
