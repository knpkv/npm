/**
 * Actions panel component - shows actions or preview based on mode.
 */
import type { Theme } from "../themes/index.js"
import type { TuiItem } from "../TuiItem.js"
import type { AppMode } from "../TuiService.js"

/**
 * Action definition with id for programmatic access.
 */
export interface ActionDef {
  readonly id: string
  readonly label: string
  readonly icon: string
}

/**
 * Get actions based on app mode.
 */
export function getActions(mode: AppMode): {
  selectionActions: ReadonlyArray<ActionDef>
  systemActions: ReadonlyArray<ActionDef>
  totalActions: number
} {
  if (mode.type === "unauthenticated") {
    // No selection actions in auth screen - items ARE the actions
    return {
      selectionActions: [],
      systemActions: [{ id: "quit", label: "Quit", icon: "⎋" }],
      totalActions: 1
    }
  }

  if (mode.type === "authenticated") {
    // Spaces mode - can clone, preview, open
    const selectionActions: Array<ActionDef> = [
      { id: "open", label: "Open in browser", icon: "⌘" },
      { id: "preview", label: "Preview", icon: "◎" },
      { id: "clone", label: "Clone as root", icon: "⬇" }
    ]
    const systemActions: Array<ActionDef> = [
      { id: "theme", label: "Theme", icon: "◐" },
      { id: "logout", label: "Logout", icon: "⏏" },
      { id: "quit", label: "Quit", icon: "⎋" }
    ]
    return {
      selectionActions,
      systemActions,
      totalActions: selectionActions.length + systemActions.length
    }
  }

  // Configured mode - full functionality
  const selectionActions: Array<ActionDef> = [
    { id: "open", label: "Open in browser", icon: "⌘" },
    { id: "preview", label: "Preview", icon: "◎" },
    { id: "pull", label: "Pull page", icon: "⬇" },
    { id: "new-page", label: "New page", icon: "◈" }
  ]
  const systemActions: Array<ActionDef> = [
    { id: "theme", label: "Theme", icon: "◐" },
    { id: "status", label: "Status", icon: "⎇" },
    { id: "new-root-page", label: "Add page", icon: "+" },
    { id: "logout", label: "Logout", icon: "⏏" },
    { id: "quit", label: "Quit", icon: "⎋" }
  ]
  return {
    selectionActions,
    systemActions,
    totalActions: selectionActions.length + systemActions.length
  }
}

/**
 * Get total action count for a mode.
 */
export function getTotalActions(mode: AppMode): number {
  return getActions(mode).totalActions
}

interface ActionsPanelProps {
  readonly mode: AppMode
  readonly selectedItem: TuiItem | undefined
  readonly isFocused: boolean
  readonly selectedAction: number
  readonly showPreview: boolean
  readonly previewContent: string
  readonly previewScroll: number
  readonly width: number
  readonly height: number
  readonly theme: Theme
}

export function ActionsPanel({
  height,
  isFocused,
  mode,
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
  const { selectionActions, systemActions } = getActions(mode)

  // Render item info based on type
  const renderItemInfo = () => {
    if (!selectedItem) {
      return (
        <box flexDirection="column" paddingTop={2}>
          <text fg={theme.text.muted}>{`${theme.icons.unsynced} Select an item`}</text>
        </box>
      )
    }

    if (selectedItem.type === "auth-menu") {
      return (
        <box flexDirection="column">
          <box flexDirection="row">
            <text fg={theme.accent.primary}>{`${selectedItem.icon} `}</text>
            <text fg={theme.text.primary}>{selectedItem.title}</text>
          </box>
          <box flexDirection="row" paddingTop={1}>
            <text fg={theme.text.secondary}>{"Press Enter to select"}</text>
          </box>
        </box>
      )
    }

    if (selectedItem.type === "space") {
      return (
        <box flexDirection="column">
          <box flexDirection="row">
            <text fg={theme.accent.primary}>{`${theme.icons.folder} `}</text>
            <text fg={theme.text.primary}>{selectedItem.title}</text>
          </box>
          <box flexDirection="row" paddingTop={1}>
            <text fg={theme.accent.secondary}>{`${theme.icons.bullet} `}</text>
            <text fg={theme.text.secondary}>{`Key: ${selectedItem.key}`}</text>
          </box>
        </box>
      )
    }

    // Page item
    return (
      <box flexDirection="column">
        <box flexDirection="row">
          <text fg={theme.accent.primary}>{`${theme.icons.synced} `}</text>
          <text fg={theme.text.primary}>{selectedItem.title}</text>
        </box>
        <box flexDirection="row" paddingTop={1}>
          <text fg={selectedItem.synced ? theme.status.synced : theme.status.unsynced}>
            {selectedItem.synced ? `${theme.icons.check} ` : `${theme.icons.cross} `}
          </text>
          <text fg={selectedItem.synced ? theme.status.synced : theme.status.unsynced}>
            {selectedItem.synced ? "Synced" : "Not synced"}
          </text>
        </box>
      </box>
    )
  }

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
          {renderItemInfo()}

          {/* Divider */}
          <box height={1} paddingTop={1}>
            <text fg={theme.text.muted}>{"─".repeat(Math.max(0, width - 4))}</text>
          </box>

          {/* Selection actions */}
          {selectionActions.length > 0 ? (
            <box flexDirection="column" paddingTop={1}>
              <text fg={theme.text.muted} paddingBottom={1}>
                {"SELECTION"}
              </text>
              {selectionActions.map((action, idx) => {
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
          ) : null}

          {/* System actions */}
          {systemActions.length > 0 ? (
            <box flexDirection="column" paddingTop={1}>
              <text fg={theme.text.muted} paddingBottom={1}>
                {"SYSTEM"}
              </text>
              {systemActions.map((action, idx) => {
                const globalIdx = selectionActions.length + idx
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
          ) : null}
        </box>
      )}
    </box>
  )
}
