import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useEffect, useState } from "react"
import { type AppState, appStateAtom, notificationsAtom } from "../atoms/app.js"
import { creatingPrAtom, viewAtom } from "../atoms/ui.js"
import { SPINNER_FRAMES, VIEW_TITLES } from "../Constants.js"
import { useTheme } from "../context/theme.js"
import { formatRelativeTime } from "../utils/date.js"

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

  const state = Result.getOrElse(result, () => defaultState)
  const notifications = Result.getOrElse(notificationsResult, () => ({ items: [] }))

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
      <box style={{ height: 1, width: "100%", backgroundColor: theme.backgroundHeaderError }}>
        <text fg={theme.text}>{`  [X] ERROR: ${state.error}`}</text>
      </box>
    )
  }

  const lastUpdateStr = creatingPr
    ? `  [+] Creating: ${creatingPr} ${SPINNER_FRAMES[spinnerFrame]}`
    : state.status === "loading"
      ? `  [@] Fetching ${state.statusDetail ?? "..."}  ${SPINNER_FRAMES[spinnerFrame]}`
      : state.lastUpdated
        ? `  [@] ${formatRelativeTime(state.lastUpdated)}`
        : ""
  const count =
    view === "prs"
      ? state.pullRequests.length
      : view === "notifications"
        ? notifications.items.length
        : state.accounts.length

  const title = (VIEW_TITLES[view] || "TUI").toUpperCase()
  const headerText = `  AWS ${title} (${count}) ${lastUpdateStr}`

  const bgColor = theme.backgroundHeader

  return (
    <box style={{ height: 1, width: "100%", backgroundColor: bgColor }}>
      <text fg={theme.text}>{headerText}</text>
    </box>
  )
}
