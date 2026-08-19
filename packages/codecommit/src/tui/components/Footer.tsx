import { useAtomValue } from "@effect/atom-react"
import { exitPendingAtom, filterTextAtom, isFilteringAtom, uiErrorAtom, viewAtom } from "../atoms/ui.js"
import { HINTS } from "../Constants.js"
import { useTheme } from "../context/theme.js"

/**
 * Footer bar showing hints or filter input
 * @category components
 */
export function Footer() {
  const { theme } = useTheme()
  const view = useAtomValue(viewAtom)
  const filterText = useAtomValue(filterTextAtom)
  const isFiltering = useAtomValue(isFilteringAtom)
  const exitPending = useAtomValue(exitPendingAtom)
  const uiError = useAtomValue(uiErrorAtom)

  if (exitPending) {
    return (
      <box style={{ height: 1, width: "100%", backgroundColor: theme.warningTint, paddingLeft: 1 }}>
        <text fg={theme.textWarning}>Press Ctrl+C again to exit</text>
      </box>
    )
  }

  if (uiError) {
    return (
      <box style={{ height: 1, width: "100%", backgroundColor: theme.errorTint, paddingLeft: 1 }}>
        <text fg={theme.textError}>{uiError}</text>
      </box>
    )
  }

  if (isFiltering) {
    return (
      <box
        style={{ height: 1, width: "100%", backgroundColor: theme.background, flexDirection: "row", paddingLeft: 1 }}
      >
        <text fg={theme.textAccent} bg={theme.accentTint}>
          {" / "}
        </text>
        <text fg={theme.textMuted}>{" Filter pull requests  "}</text>
        <text fg={theme.text}>{filterText}</text>
        <text fg={theme.textAccent}>{"│"}</text>
      </box>
    )
  }

  const hintText = HINTS[view] || ""

  return (
    <box style={{ height: 1, width: "100%", backgroundColor: theme.background, paddingLeft: 1 }}>
      <text fg={theme.textMuted}>{hintText}</text>
    </box>
  )
}
