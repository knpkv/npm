import { useAtomValue } from "@effect-atom/atom-react"
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
      <box style={{ height: 1, width: "100%", backgroundColor: theme.backgroundHeaderWarning }}>
        <text fg={theme.textError}>Press Ctrl+C again to exit</text>
      </box>
    )
  }

  if (uiError) {
    return (
      <box style={{ height: 1, width: "100%", backgroundColor: theme.backgroundHeaderError }}>
        <text fg={theme.textError}>{`ERROR: ${uiError}`}</text>
      </box>
    )
  }

  if (isFiltering) {
    return (
      <box style={{ height: 1, width: "100%", backgroundColor: theme.backgroundElement, flexDirection: "row" }}>
        <text fg={theme.background} bg={theme.primary}>{" / "}</text>
        <text fg={theme.textMuted}>{" Filter: "}</text>
        <text fg={theme.text}>{filterText}</text>
        <text fg={theme.primary}>{"│"}</text>
      </box>
    )
  }

  const hintText = HINTS[view] || ""

  return (
    <box style={{ height: 1, width: "100%", backgroundColor: theme.backgroundPanel }}>
      <text fg={theme.textMuted}>{`  >  ${hintText}`}</text>
    </box>
  )
}
