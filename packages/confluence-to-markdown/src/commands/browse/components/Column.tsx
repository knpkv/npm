/**
 * Column component for Miller columns navigation.
 */
import type { BrowseItem, ColumnState } from "../BrowseItem.js"
import type { Theme } from "../themes/index.js"

interface ColumnProps {
  readonly state: ColumnState
  readonly isFocused: boolean
  readonly width: number
  readonly height: number
  readonly theme: Theme
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
          state.items.map((item: BrowseItem, idx: number) => {
            const isSelected = idx === state.selectedIndex

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
              iconColor = item.synced ? theme.status.synced : theme.text.muted
            } else {
              bgColor = theme.bg.primary
              textColor = theme.text.primary
              iconColor = item.synced ? theme.status.synced : theme.text.muted
            }

            return (
              <box key={item.id} backgroundColor={bgColor} paddingLeft={1} flexDirection="row">
                <text fg={iconColor}>{item.synced ? `${theme.icons.synced} ` : `${theme.icons.unsynced} `}</text>
                <text fg={textColor}>{item.title}</text>
              </box>
            )
          })
        )}
      </scrollbox>
    </box>
  )
}
