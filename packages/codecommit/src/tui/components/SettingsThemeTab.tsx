import { useAtomValue } from "@effect/atom-react"
import { useMemo } from "react"
import { themeAtom, themeSelectionIndexAtom } from "../atoms/ui.js"
import { useTheme } from "../context/theme.js"
import { themes } from "../theme/themes.js"

export function SettingsThemeTab() {
  const { theme } = useTheme()
  const currentThemeId = useAtomValue(themeAtom)
  const selectionIndex = useAtomValue(themeSelectionIndexAtom)

  const allThemes = useMemo(
    () =>
      Object.keys(themes)
        .sort()
        .map((name) => ({ id: name, label: name })),
    []
  )

  return (
    <box style={{ flexDirection: "column", flexGrow: 1, width: "100%" }}>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.textMuted}>{`CURRENT THEME  `}</text>
        <text fg={theme.text}>{currentThemeId}</text>
      </box>
      <box style={{ height: 1, paddingLeft: 1 }}>
        <text fg={theme.textMuted}>{"↑↓ navigate  ·  enter apply"}</text>
      </box>
      <scrollbox style={{ flexGrow: 1, width: "100%" }}>
        {allThemes.map((t, i) => {
          const isCurrent = t.id === currentThemeId
          const isSelected = i === selectionIndex
          return (
            <box
              key={t.id}
              style={{
                height: 1,
                paddingLeft: 1,
                ...(isSelected && { backgroundColor: theme.backgroundRaised })
              }}
            >
              <text fg={isSelected ? theme.text : isCurrent ? theme.textAccent : theme.textMuted}>
                {`${isSelected ? "│" : " "} ${t.label}${isCurrent ? "  current" : ""}`}
              </text>
            </box>
          )
        })}
      </scrollbox>
    </box>
  )
}
