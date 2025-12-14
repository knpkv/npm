/**
 * Theme selector modal component.
 */
import type { Theme, ThemeName } from "../themes/index.js"
import { themeNames, themes } from "../themes/index.js"

interface ThemeSelectorProps {
  readonly currentTheme: ThemeName
  readonly selectedIndex: number
  readonly theme: Theme
  readonly width: number
  readonly height: number
}

export function ThemeSelector({ currentTheme, height, selectedIndex, theme, width }: ThemeSelectorProps) {
  const modalWidth = Math.min(50, width - 10)
  const modalHeight = Math.min(themeNames.length + 6, height - 4)
  const left = Math.floor((width - modalWidth) / 2)
  const top = Math.floor((height - modalHeight) / 2)

  // Calculate visible items (header=3 lines, footer=2 lines, border=2)
  const listHeight = modalHeight - 7
  const visibleCount = Math.max(1, listHeight)

  // Calculate scroll offset to keep selected item visible
  let scrollOffset = 0
  if (selectedIndex >= visibleCount) {
    scrollOffset = selectedIndex - visibleCount + 1
  }
  const visibleThemes = themeNames.slice(scrollOffset, scrollOffset + visibleCount)

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={modalWidth}
      height={modalHeight}
      backgroundColor={theme.bg.secondary}
      border={true}
      borderColor={theme.accent.primary}
      flexDirection="column"
    >
      {/* Header */}
      <box paddingLeft={1} paddingTop={1} paddingBottom={1}>
        <text fg={theme.accent.primary}>{"◐ "}</text>
        <text fg={theme.text.primary}>{"Select Theme"}</text>
        <text fg={theme.text.muted}>{` (${selectedIndex + 1}/${themeNames.length})`}</text>
      </box>

      {/* Divider */}
      <box height={1}>
        <text fg={theme.border.unfocused}>{"─".repeat(modalWidth - 2)}</text>
      </box>

      {/* Theme list */}
      <box flexDirection="column" paddingLeft={1} paddingRight={1} height={visibleCount}>
        {visibleThemes.map((name) => {
          const t = themes[name]
          const idx = themeNames.indexOf(name)
          const isSelected = idx === selectedIndex
          const isCurrent = name === currentTheme

          return (
            <box
              key={name}
              flexDirection="row"
              backgroundColor={isSelected ? theme.selection.active : theme.bg.secondary}
              paddingLeft={1}
            >
              <text fg={isSelected ? theme.text.inverse : theme.accent.tertiary}>{isCurrent ? "● " : "○ "}</text>
              <text fg={isSelected ? theme.text.inverse : theme.text.primary}>{t.name}</text>
              {/* Color preview dots */}
              <text fg={theme.text.muted}></text>
              <text fg={t.accent.primary}>{"●"}</text>
              <text fg={t.accent.secondary}>{"●"}</text>
              <text fg={t.accent.tertiary}>{"●"}</text>
            </box>
          )
        })}
      </box>

      {/* Footer hint */}
      <box flexGrow={1} />
      <box paddingLeft={1} paddingBottom={1} flexDirection="row">
        <text fg={theme.text.muted}>{"⏎ apply"}</text>
        <text fg={theme.text.muted}>{" │ "}</text>
        <text fg={theme.text.muted}>{"esc cancel"}</text>
      </box>
    </box>
  )
}
