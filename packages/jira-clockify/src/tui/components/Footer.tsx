/**
 * Help footer showing available keyboard shortcuts.
 *
 * @internal
 */
import { useAtomValue } from "@effect/atom-react"
import type { JSX } from "@opentui/react/jsx-runtime"
import { isFilteringAtom } from "../atoms/ui.js"

type BoxStyle = NonNullable<JSX.IntrinsicElements["box"]["style"]>

const filteringFooterStyle = {
  height: 1,
  width: "100%",
  backgroundColor: "#1a1a2e",
  flexDirection: "row",
  paddingLeft: 1
} satisfies BoxStyle
const filterKeyStyle = { backgroundColor: "#00CCFF", paddingLeft: 1, paddingRight: 1 } satisfies BoxStyle
const footerStyle = { height: 1, width: "100%", backgroundColor: "#1a1a2e", paddingLeft: 2 } satisfies BoxStyle

export function Footer() {
  const isFiltering = useAtomValue(isFilteringAtom)

  if (isFiltering) {
    return (
      <box style={filteringFooterStyle}>
        <box style={filterKeyStyle}>
          <text fg="#000000">/</text>
        </box>
        <text fg="#888888">type to filter ·</text>
        <text fg="#555555">esc clear · enter apply</text>
      </box>
    )
  }

  return (
    <box style={footerStyle}>
      <text fg="#888888">{"↑↓ navigate  s/⏎ start  x stop  / filter  r refresh  q quit"}</text>
    </box>
  )
}
