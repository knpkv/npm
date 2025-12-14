/**
 * Main browse application component.
 */
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { useEffect, useState } from "react"
import type { PageId } from "../../Brand.js"
import type { BrowseItem, ColumnState } from "./BrowseItem.js"
import type { BrowseService } from "./BrowseService.js"
import { ActionsPanel, SELECTION_ACTIONS, TOTAL_ACTIONS } from "./components/ActionsPanel.js"
import { Column } from "./components/Column.js"
import { StatusBar } from "./components/StatusBar.js"
import { ThemeSelector } from "./components/ThemeSelector.js"
import { type ThemeName, themeNames, themes } from "./themes/index.js"

interface BrowseAppProps {
  readonly service: BrowseService
  readonly initialItem: BrowseItem
  readonly userEmail: string | null
  readonly onQuit: () => void
  readonly initialTheme: ThemeName
  readonly onThemeChange: (theme: ThemeName) => void
}

type FocusedColumn = 0 | 1 | 2

interface BrowseState {
  readonly col0: ColumnState
  readonly col1: ColumnState
  readonly focusedColumn: FocusedColumn
  readonly history: ReadonlyArray<ColumnState>
  readonly selectedAction: number
  readonly showPreview: boolean
  readonly showThemeSelector: boolean
  readonly showNewPagePrompt: boolean
  readonly newPageTitle: string
  readonly newPageParentId: PageId | null
  readonly previewContent: string
  readonly previewScroll: number
  readonly loading: boolean
  readonly themeName: ThemeName
  readonly themeIndex: number
  readonly statusMessage: string | null
}

const initialState = (item: BrowseItem, themeName: ThemeName): BrowseState => ({
  col0: { items: [item], selectedIndex: 0 },
  col1: { items: [], selectedIndex: 0 },
  focusedColumn: 0,
  history: [],
  selectedAction: 0,
  showPreview: false,
  showThemeSelector: false,
  showNewPagePrompt: false,
  newPageTitle: "",
  newPageParentId: null,
  previewContent: "",
  previewScroll: 0,
  loading: false,
  themeName,
  themeIndex: themeNames.indexOf(themeName),
  statusMessage: null
})

export function BrowseApp({ initialItem, initialTheme, onQuit, onThemeChange, service, userEmail }: BrowseAppProps) {
  const dimensions = useTerminalDimensions()
  const [state, setState] = useState<BrowseState>(() => initialState(initialItem, initialTheme))

  const {
    col0,
    col1,
    focusedColumn,
    history,
    loading,
    newPageParentId,
    newPageTitle,
    previewContent,
    previewScroll,
    selectedAction,
    showNewPagePrompt,
    showPreview,
    showThemeSelector,
    statusMessage,
    themeIndex,
    themeName
  } = state
  const theme = themes[themeName]

  // Helper to run Effect and update loading state
  const runEffect = <A, E>(effect: Effect.Effect<A, E>, onSuccess: (a: A) => void) => {
    setState((s) => ({ ...s, loading: true }))
    Effect.runPromise(Effect.either(effect)).then((either) => {
      if (either._tag === "Right") {
        onSuccess(either.right)
      }
      setState((s) => ({ ...s, loading: false }))
    })
  }

  // Load children for col1
  const loadChildren = (item: BrowseItem) => {
    runEffect(service.getChildren(item), (children) => {
      setState((s) => ({ ...s, col1: { items: children, selectedIndex: 0 } }))
    })
  }

  // Load initial children
  useEffect(() => {
    const item = col0.items[col0.selectedIndex]
    if (item) loadChildren(item)
  }, [])

  // Get selected item from focused column
  const getSelectedItem = (): BrowseItem | undefined => {
    const col = focusedColumn === 0 ? col0 : col1
    return col.items[col.selectedIndex]
  }

  const selectedItem = getSelectedItem()
  const previewLines = previewContent.split("\n")

  // Execute action
  const executeAction = (item: BrowseItem | undefined) => {
    // Selection actions (require item)
    if (selectedAction < SELECTION_ACTIONS.length) {
      if (!item) return
      if (selectedAction === 0) {
        // Open in browser
        Effect.runPromise(service.openInBrowser(item))
      } else if (selectedAction === 1) {
        // Preview
        runEffect(service.getPreview(item), (content) => {
          setState((s) => ({
            ...s,
            previewContent: content,
            previewScroll: 0,
            showPreview: true
          }))
        })
      } else if (selectedAction === 2) {
        // Add/sync selected page
        runEffect(service.pullPage(item), (result) => {
          setState((s) => ({ ...s, statusMessage: result }))
          setTimeout(() => setState((s) => ({ ...s, statusMessage: null })), 3000)
        })
      } else if (selectedAction === 3) {
        // New page under selected item
        setState((s) => ({
          ...s,
          showNewPagePrompt: true,
          newPageTitle: "",
          newPageParentId: item.id
        }))
      }
    } else {
      // System actions
      const systemIdx = selectedAction - SELECTION_ACTIONS.length
      if (systemIdx === 0) {
        // Theme
        setState((s) => ({ ...s, showThemeSelector: true }))
      } else if (systemIdx === 1) {
        // Sync status
        runEffect(service.getStatus, (status) => {
          setState((s) => ({
            ...s,
            previewContent: `Sync Status:\n\n${status}`,
            previewScroll: 0,
            showPreview: true
          }))
        })
      } else if (systemIdx === 2) {
        // Add page under root
        setState((s) => ({
          ...s,
          showNewPagePrompt: true,
          newPageTitle: "",
          newPageParentId: initialItem.id
        }))
      }
    }
  }

  // Create new page
  const createNewPage = () => {
    if (!newPageParentId || !newPageTitle.trim()) return
    runEffect(service.createNewPage(newPageParentId, newPageTitle.trim()), (result) => {
      setState((s) => ({
        ...s,
        showNewPagePrompt: false,
        newPageTitle: "",
        newPageParentId: null,
        statusMessage: result
      }))
      setTimeout(() => setState((s) => ({ ...s, statusMessage: null })), 3000)
    })
  }

  // Apply theme and save
  const applyTheme = (name: ThemeName) => {
    setState((s) => ({ ...s, themeName: name, themeIndex: themeNames.indexOf(name), showThemeSelector: false }))
    onThemeChange(name)
  }

  // Keyboard navigation
  useKeyboard((key) => {
    const currentItem = getSelectedItem()

    // New page prompt mode
    if (showNewPagePrompt) {
      if (key.name === "escape") {
        setState((s) => ({ ...s, showNewPagePrompt: false, newPageTitle: "", newPageParentId: null }))
      } else if (key.name === "return") {
        createNewPage()
      } else if (key.name === "backspace") {
        setState((s) => ({ ...s, newPageTitle: s.newPageTitle.slice(0, -1) }))
      } else if (key.sequence && key.sequence.length === 1 && key.sequence.match(/[\w\s\-_.]/)) {
        setState((s) => ({ ...s, newPageTitle: s.newPageTitle + key.sequence }))
      }
      return
    }

    // Theme selector mode
    if (showThemeSelector) {
      if (key.name === "escape" || key.name === "q") {
        setState((s) => ({ ...s, showThemeSelector: false }))
      } else if (key.name === "j" || key.name === "down") {
        setState((s) => ({ ...s, themeIndex: (s.themeIndex + 1) % themeNames.length }))
      } else if (key.name === "k" || key.name === "up") {
        setState((s) => ({ ...s, themeIndex: (s.themeIndex - 1 + themeNames.length) % themeNames.length }))
      } else if (key.name === "return") {
        applyTheme(themeNames[themeIndex]!)
      }
      return
    }

    // Quit / escape
    if (key.name === "q" || key.name === "escape") {
      if (showPreview) {
        setState((s) => ({ ...s, showPreview: false }))
      } else if (focusedColumn === 2) {
        setState((s) => ({ ...s, focusedColumn: col1.items.length > 0 ? 1 : 0 }))
      } else {
        onQuit()
      }
      return
    }

    // Down / j
    if (key.name === "j" || key.name === "down") {
      if (showPreview) {
        if (previewScroll < previewLines.length - 1) {
          setState((s) => ({ ...s, previewScroll: s.previewScroll + 1 }))
        }
      } else if (focusedColumn === 2) {
        if (selectedAction < TOTAL_ACTIONS - 1) {
          setState((s) => ({ ...s, selectedAction: s.selectedAction + 1 }))
        }
      } else if (focusedColumn === 0 && col0.selectedIndex < col0.items.length - 1) {
        const newIndex = col0.selectedIndex + 1
        setState((s) => ({ ...s, col0: { ...s.col0, selectedIndex: newIndex } }))
        const item = col0.items[newIndex]
        if (item) loadChildren(item)
      } else if (focusedColumn === 1 && col1.selectedIndex < col1.items.length - 1) {
        setState((s) => ({ ...s, col1: { ...s.col1, selectedIndex: s.col1.selectedIndex + 1 } }))
      }
      return
    }

    // Up / k
    if (key.name === "k" || key.name === "up") {
      if (showPreview) {
        if (previewScroll > 0) {
          setState((s) => ({ ...s, previewScroll: s.previewScroll - 1 }))
        }
      } else if (focusedColumn === 2) {
        if (selectedAction > 0) {
          setState((s) => ({ ...s, selectedAction: s.selectedAction - 1 }))
        }
      } else if (focusedColumn === 0 && col0.selectedIndex > 0) {
        const newIndex = col0.selectedIndex - 1
        setState((s) => ({ ...s, col0: { ...s.col0, selectedIndex: newIndex } }))
        const item = col0.items[newIndex]
        if (item) loadChildren(item)
      } else if (focusedColumn === 1 && col1.selectedIndex > 0) {
        setState((s) => ({ ...s, col1: { ...s.col1, selectedIndex: s.col1.selectedIndex - 1 } }))
      }
      return
    }

    // Left / h / backspace
    if (key.name === "h" || key.name === "left" || key.name === "backspace") {
      if (showPreview) {
        setState((s) => ({ ...s, showPreview: false }))
      } else if (focusedColumn === 2) {
        setState((s) => ({ ...s, focusedColumn: col1.items.length > 0 ? 1 : 0 }))
      } else if (focusedColumn === 1) {
        setState((s) => ({ ...s, focusedColumn: 0 }))
      } else if (focusedColumn === 0 && history.length > 0) {
        const prev = history[history.length - 1]!
        setState((s) => ({
          ...s,
          history: s.history.slice(0, -1),
          col1: s.col0,
          col0: prev
        }))
      } else if (focusedColumn === 0 && history.length === 0 && !loading) {
        const item = col0.items[col0.selectedIndex]
        if (item) {
          runEffect(service.getParentAndSiblings(item), (result) => {
            if (Option.isSome(result)) {
              const { siblings } = result.value
              // Only go back if siblings are different from current col0
              // (prevents duplication when already at sibling level)
              const currentIds = new Set(col0.items.map((i) => i.id))
              const siblingIds = new Set(siblings.map((s) => s.id))
              const sameContent =
                currentIds.size === siblingIds.size && [...currentIds].every((id) => siblingIds.has(id))
              if (!sameContent) {
                const idx = siblings.findIndex((s) => s.id === item.id)
                setState((s) => ({
                  ...s,
                  col1: s.col0,
                  col0: { items: siblings, selectedIndex: idx >= 0 ? idx : 0 }
                }))
              }
            }
          })
        }
      }
      return
    }

    // Enter
    if (key.name === "return") {
      if (showPreview) {
        setState((s) => ({ ...s, showPreview: false }))
      } else if (focusedColumn === 2) {
        executeAction(currentItem)
      } else if (focusedColumn === 0 && col1.items.length > 0) {
        setState((s) => ({ ...s, focusedColumn: 1 }))
      } else if (focusedColumn === 1 && col1.items.length > 0) {
        const item = col1.items[col1.selectedIndex]
        if (item) {
          runEffect(service.getChildren(item), (children) => {
            setState((s) => ({
              ...s,
              history: [...s.history, s.col0],
              col0: s.col1,
              col1: { items: children, selectedIndex: 0 },
              focusedColumn: 0
            }))
          })
        }
      }
      return
    }

    // Right / l
    if (key.name === "l" || key.name === "right") {
      if (showPreview) return
      if (focusedColumn === 2) return
      if (focusedColumn === 0 && col1.items.length > 0) {
        setState((s) => ({ ...s, focusedColumn: 1 }))
      } else if (focusedColumn === 0 && col1.items.length === 0) {
        setState((s) => ({ ...s, focusedColumn: 2, selectedAction: 0 }))
      } else if (focusedColumn === 1) {
        setState((s) => ({ ...s, focusedColumn: 2, selectedAction: 0 }))
      }
      return
    }

    // Shortcuts
    if (key.name === "o" && currentItem) {
      Effect.runPromise(service.openInBrowser(currentItem))
    } else if (key.name === "v" && currentItem) {
      runEffect(service.getPreview(currentItem), (content) => {
        setState((s) => ({
          ...s,
          previewContent: content,
          previewScroll: 0,
          showPreview: true
        }))
      })
    }
  })

  // Layout
  const hasCol1 = col1.items.length > 0
  const colWidth = Math.floor(dimensions.width / 3)
  const actionsWidth = hasCol1 ? dimensions.width - colWidth * 2 : dimensions.width - colWidth
  const contentHeight = dimensions.height - 3

  return (
    <box width={dimensions.width} height={dimensions.height} flexDirection="column" backgroundColor={theme.bg.primary}>
      {/* Header */}
      <box height={1} backgroundColor={theme.bg.header} paddingLeft={1} flexDirection="row">
        <text fg={theme.accent.primary}>{"◈ "}</text>
        <text fg={theme.text.primary}>{service.siteName}</text>
        {selectedItem ? (
          <box flexDirection="row">
            <text fg={theme.text.muted}>{" › "}</text>
            <text fg={theme.accent.secondary}>{selectedItem.title}</text>
          </box>
        ) : null}
      </box>

      {/* Main content */}
      <box flexDirection="row" height={contentHeight}>
        <Column state={col0} isFocused={focusedColumn === 0} width={colWidth} height={contentHeight} theme={theme} />
        {hasCol1 ? (
          <Column state={col1} isFocused={focusedColumn === 1} width={colWidth} height={contentHeight} theme={theme} />
        ) : null}
        <ActionsPanel
          selectedItem={selectedItem}
          isFocused={focusedColumn === 2}
          selectedAction={selectedAction}
          showPreview={showPreview}
          previewContent={previewContent}
          previewScroll={previewScroll}
          loading={loading}
          width={actionsWidth}
          height={contentHeight}
          theme={theme}
        />
      </box>

      {/* Status bar */}
      <StatusBar
        width={dimensions.width}
        userEmail={userEmail}
        loading={loading}
        inActionsPanel={focusedColumn === 2}
        theme={theme}
        themeName={theme.name}
        statusMessage={statusMessage}
      />

      {/* Theme selector modal */}
      {showThemeSelector ? (
        <ThemeSelector
          currentTheme={themeName}
          selectedIndex={themeIndex}
          theme={theme}
          width={dimensions.width}
          height={dimensions.height}
        />
      ) : null}

      {/* New page prompt modal */}
      {showNewPagePrompt ? (
        <box
          position="absolute"
          left={Math.floor((dimensions.width - 50) / 2)}
          top={Math.floor((dimensions.height - 7) / 2)}
          width={50}
          height={7}
          backgroundColor={theme.bg.secondary}
          border={true}
          borderColor={theme.accent.primary}
          flexDirection="column"
        >
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme.accent.primary}>{"◈ "}</text>
            <text fg={theme.text.primary}>{"New Page"}</text>
          </box>
          <box paddingLeft={1} paddingTop={1}>
            <text fg={theme.text.muted}>{"Title: "}</text>
            <text fg={theme.text.primary}>{newPageTitle}</text>
            <text fg={theme.accent.primary}>{"█"}</text>
          </box>
          <box flexGrow={1} />
          <box paddingLeft={1} paddingBottom={1} flexDirection="row">
            <text fg={theme.text.muted}>{"⏎ create"}</text>
            <text fg={theme.text.muted}>{" │ "}</text>
            <text fg={theme.text.muted}>{"esc cancel"}</text>
          </box>
        </box>
      ) : null}
    </box>
  )
}
