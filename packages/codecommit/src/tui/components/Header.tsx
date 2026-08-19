import { useAtomValue } from "@effect/atom-react"
import { DateUtils } from "@knpkv/codecommit-core"
import type { PaginatedNotifications } from "@knpkv/codecommit-core/CacheService.js"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { useEffect, useState } from "react"
import { type AppState, appStateAtom, notificationsAtom } from "../atoms/app.js"
import { creatingPrAtom, viewAtom } from "../atoms/ui.js"
import { SPINNER_FRAMES, VIEW_TITLES } from "../Constants.js"
import { useTheme } from "../context/theme.js"

const defaultState: AppState = {
  status: "loading",
  pullRequests: [],
  accounts: []
}

/**
 * Header bar showing current view title and status
 * @category components
 */
export function Header() {
  const { theme } = useTheme()
  const result = useAtomValue(appStateAtom)
  const notificationsResult = useAtomValue(notificationsAtom)
  const view = useAtomValue(viewAtom)
  const creatingPr = useAtomValue(creatingPrAtom)
  const [, setTick] = useState(0)
  const [spinnerFrame, setSpinnerFrame] = useState(0)

  const state = AsyncResult.getOrElse(result, () => defaultState)
  const notifications: PaginatedNotifications = AsyncResult.getOrElse(notificationsResult, () => ({ items: [] }))

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 10000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (state.status === "loading" || creatingPr) {
      const interval = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
      return () => clearInterval(interval)
    }
  }, [state.status, creatingPr])

  if (state.error) {
    return (
      <box
        border={["bottom"]}
        borderColor={theme.textError}
        style={{ height: 2, width: "100%", backgroundColor: theme.backgroundHeaderError, paddingLeft: 1 }}
      >
        <text fg={theme.textError}>{`CodeCommit unavailable · ${state.error}`}</text>
      </box>
    )
  }

  const lastUpdateStr = creatingPr
    ? `${SPINNER_FRAMES[spinnerFrame]} creating ${creatingPr}`
    : state.status === "loading"
      ? `${SPINNER_FRAMES[spinnerFrame]} syncing`
      : state.lastUpdated
        ? DateUtils.formatRelativeTime(state.lastUpdated, new Date()).toLowerCase()
        : "not synced"
  const count =
    view === "prs"
      ? state.pullRequests.length
      : view === "notifications"
        ? notifications.items.length
        : state.accounts.length

  const title = VIEW_TITLES[view] || "CodeCommit"
  const userStr = state.status === "idle" && state.currentUser ? ` · ${state.currentUser}` : ""
  const countLabel =
    view === "prs"
      ? `${count} PR${count === 1 ? "" : "s"}`
      : view === "notifications"
        ? `${count} alert${count === 1 ? "" : "s"}`
        : view === "settings"
          ? `${count} account${count === 1 ? "" : "s"}`
          : "exact head"

  return (
    <box
      border={["bottom"]}
      borderColor={theme.border}
      style={{ height: 2, width: "100%", backgroundColor: theme.backgroundHeader, paddingLeft: 1, paddingRight: 1 }}
    >
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text fg={theme.textAccent} bg={theme.accentTint}>
          {" CC "}
        </text>
        <text fg={theme.text}>{" Control Center"}</text>
        <text fg={theme.textMuted}>{" / CodeCommit / "}</text>
        <text fg={theme.text}>{title}</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={state.status === "loading" || creatingPr ? theme.textAccent : theme.textMuted}>
          {`${countLabel} · ${lastUpdateStr}${userStr}`}
        </text>
      </box>
    </box>
  )
}
