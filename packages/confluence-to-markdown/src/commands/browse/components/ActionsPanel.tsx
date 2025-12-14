/**
 * Actions panel component - shows actions or preview.
 */
import type { BrowseItem } from "../BrowseItem.js"
import type { Theme } from "../themes/index.js"

export const SELECTION_ACTIONS = [
  { label: "Open in browser", icon: "⌘" },
  { label: "Preview", icon: "◎" },
  { label: "Add", icon: "+" },
  { label: "New page", icon: "◈" }
] as const

export const SYSTEM_ACTIONS = [
  { label: "Theme", icon: "◐" },
  { label: "Status", icon: "⎇" },
  { label: "Add page", icon: "+" }
] as const

export type SelectionActionType = (typeof SELECTION_ACTIONS)[number]["label"]
export type SystemActionType = (typeof SYSTEM_ACTIONS)[number]["label"]

export const TOTAL_ACTIONS = SELECTION_ACTIONS.length + SYSTEM_ACTIONS.length

interface ActionsPanelProps {
  readonly selectedItem: BrowseItem | undefined
  readonly isFocused: boolean
  readonly selectedAction: number
  readonly showPreview: boolean
  readonly previewContent: string
  readonly previewScroll: number
  readonly loading: boolean
  readonly width: number
  readonly height: number
  readonly theme: Theme
}

export function ActionsPanel({
  height,
  isFocused,
  loading,
  previewContent,
  previewScroll,
  selectedAction,
  selectedItem,
  showPreview,
  theme,
  width
}: ActionsPanelProps) {
  const borderColor = isFocused ? theme.border.focused : theme.border.unfocused
  const previewLines = previewContent.split("\n")

  return (
    <box
      width={width}
      flexDirection="column"
      border={true}
      borderColor={borderColor}
      backgroundColor={theme.bg.primary}
    >
      {showPreview ? (
        <box flexDirection="column" paddingLeft={1} paddingTop={1}>
          {/* Preview header */}
          <box flexDirection="row" paddingBottom={1}>
            <text fg={theme.accent.secondary}>{`${theme.icons.synced} `}</text>
            <text fg={theme.text.primary}>{"Preview"}</text>
            <text fg={theme.text.muted}>{" │ "}</text>
            <text fg={theme.text.secondary}>{`${previewScroll + 1}/${previewLines.length}`}</text>
          </box>
          <box height={1} backgroundColor={theme.border.unfocused} />
          <scrollbox height={height - 5}>
            <text fg={theme.text.secondary}>{previewLines.slice(previewScroll).join("\n") || "No content"}</text>
          </scrollbox>
        </box>
      ) : (
        <box flexDirection="column" paddingLeft={1} paddingTop={1}>
          {selectedItem ? (
            <box flexDirection="column">
              {/* Item title with icon */}
              <box flexDirection="row">
                <text fg={theme.accent.primary}>{`${theme.icons.synced} `}</text>
                <text fg={theme.text.primary}>{selectedItem.title}</text>
              </box>

              {/* Sync status badge */}
              <box flexDirection="row" paddingTop={1}>
                <text fg={selectedItem.synced ? theme.status.synced : theme.status.unsynced}>
                  {selectedItem.synced ? `${theme.icons.check} ` : `${theme.icons.cross} `}
                </text>
                <text fg={selectedItem.synced ? theme.status.synced : theme.status.unsynced}>
                  {selectedItem.synced ? "Synced" : "Not synced"}
                </text>
              </box>

              {/* Divider */}
              <box height={1} paddingTop={1}>
                <text fg={theme.text.muted}>{"─".repeat(Math.max(0, width - 4))}</text>
              </box>

              {/* Selection actions */}
              <box flexDirection="column" paddingTop={1}>
                <text fg={theme.text.muted} paddingBottom={1}>
                  {"SELECTION"}
                </text>
                {SELECTION_ACTIONS.map((action, idx) => {
                  const isSelected = idx === selectedAction && isFocused
                  return (
                    <box
                      key={idx}
                      flexDirection="row"
                      backgroundColor={isSelected ? theme.selection.active : theme.bg.primary}
                      paddingLeft={1}
                      paddingRight={1}
                    >
                      <text fg={isSelected ? theme.text.inverse : theme.accent.tertiary}>{`${action.icon} `}</text>
                      <text fg={isSelected ? theme.text.inverse : theme.text.primary}>{action.label}</text>
                    </box>
                  )
                })}
              </box>

              {/* System actions */}
              <box flexDirection="column" paddingTop={1}>
                <text fg={theme.text.muted} paddingBottom={1}>
                  {"SYSTEM"}
                </text>
                {SYSTEM_ACTIONS.map((action, idx) => {
                  const globalIdx = SELECTION_ACTIONS.length + idx
                  const isSelected = globalIdx === selectedAction && isFocused
                  return (
                    <box
                      key={idx}
                      flexDirection="row"
                      backgroundColor={isSelected ? theme.selection.active : theme.bg.primary}
                      paddingLeft={1}
                      paddingRight={1}
                    >
                      <text fg={isSelected ? theme.text.inverse : theme.accent.tertiary}>{`${action.icon} `}</text>
                      <text fg={isSelected ? theme.text.inverse : theme.text.primary}>{action.label}</text>
                    </box>
                  )
                })}
              </box>
            </box>
          ) : (
            <box flexDirection="column" paddingTop={2}>
              <text fg={theme.text.muted}>{`${theme.icons.unsynced} Select a page`}</text>
            </box>
          )}
        </box>
      )}

      {/* Loading indicator */}
      {loading ? (
        <box paddingLeft={1} paddingTop={1}>
          <text fg={theme.status.loading}>{`${theme.icons.loading} Loading...`}</text>
        </box>
      ) : null}
    </box>
  )
}
