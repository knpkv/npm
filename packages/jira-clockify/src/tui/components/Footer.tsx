/**
 * Help footer showing available keyboard shortcuts.
 *
 * @internal
 */
import { useAtomValue } from "@effect-atom/atom-react"
import { isFilteringAtom } from "../atoms/ui.js"

export function Footer() {
  const isFiltering = useAtomValue(isFilteringAtom)

  if (isFiltering) {
    return (
      <box
        style={{ height: 1, width: "100%", backgroundColor: "#1a1a2e", flexDirection: "row", paddingLeft: 1 } as any}
      >
        <box style={{ backgroundColor: "#00CCFF", paddingLeft: 1, paddingRight: 1 } as any}>
          <text fg="#000000">/</text>
        </box>
        <text fg="#888888">type to filter ·</text>
        <text fg="#555555">esc clear · enter apply</text>
      </box>
    )
  }

  return (
    <box style={{ height: 1, width: "100%", backgroundColor: "#1a1a2e", paddingLeft: 2 } as any}>
      <text fg="#888888">{"↑↓ navigate  s/⏎ start  x stop  / filter  r refresh  q quit"}</text>
    </box>
  )
}
