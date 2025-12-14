/**
 * Column component for Miller columns navigation.
 */
import type { Theme } from "../themes/index.js"
import type { ColumnState, TuiItem } from "../TuiItem.js"

interface ColumnProps {
  readonly state: ColumnState
  readonly isFocused: boolean
  readonly width: number
  readonly height: number
  readonly theme: Theme
}

/** Check if item is synced (only pages can be synced) */
const isSynced = (item: TuiItem): boolean => item.type === "page" && item.synced

/** Get icon for item type */
const getIcon = (item: TuiItem, theme: Theme, synced: boolean): string => {
  if (item.type === "auth-menu") return item.icon
  if (item.type === "space") return theme.icons.folder
  return synced ? theme.icons.synced : theme.icons.unsynced
}

/** Get unique key for item */
const getKey = (item: TuiItem): string => {
  if (item.type === "auth-menu") return item.id
  return item.id
}

export function Column({ height, isFocused, state, theme, width }: ColumnProps) {
  const borderColor = isFocused ? theme.border.focused : theme.border.unfocused

  return (
    <box width={width} border={true} borderColor={borderColor} backgroundColor={theme.bg.primary}>
      <scrollbox height={height - 2}>
        {state.items.length === 0 ? (
          <text fg={theme.text.muted} paddingLeft={1}>
            {"—"}
          </text>
        ) : (
          state.items.map((item: TuiItem, idx: number) => {
            const isSelected = idx === state.selectedIndex
            const synced = isSynced(item)
            const icon = getIcon(item, theme, synced)

            let bgColor: string
            let textColor: string
            let iconColor: string

            if (isSelected && isFocused) {
              bgColor = theme.selection.active
              textColor = theme.text.inverse
              iconColor = theme.text.inverse
            } else if (isSelected) {
              bgColor = theme.selection.inactive
              textColor = theme.text.primary
              iconColor =
                item.type === "auth-menu"
                  ? theme.accent.primary
                  : item.type === "space"
                    ? theme.accent.secondary
                    : synced
                      ? theme.status.synced
                      : theme.text.muted
            } else {
              bgColor = theme.bg.primary
              textColor = theme.text.primary
              iconColor =
                item.type === "auth-menu"
                  ? theme.accent.primary
                  : item.type === "space"
                    ? theme.accent.secondary
                    : synced
                      ? theme.status.synced
                      : theme.text.muted
            }

            return (
              <box key={getKey(item)} backgroundColor={bgColor} paddingLeft={1} flexDirection="row">
                <text fg={iconColor}>{`${icon} `}</text>
                <text fg={textColor}>{item.title}</text>
              </box>
            )
          })
        )}
      </scrollbox>
    </box>
  )
}
