/**
 * Main browse application component.
 */
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { useEffect, useState } from "react"
import type { BrowseItem, ColumnState } from "./BrowseItem.js"
import type { BrowseService } from "./BrowseService.js"
import { ActionsPanel, ACTIONS } from "./components/ActionsPanel.js"
import { Column } from "./components/Column.js"
import { StatusBar } from "./components/StatusBar.js"
import { ThemeSelector } from "./components/ThemeSelector.js"
import { defaultTheme, themes, themeNames, type Theme, type ThemeName } from "./themes/index.js"

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
  readonly previewContent: string
  readonly previewScroll: number
  readonly loading: boolean
  readonly themeName: ThemeName
  readonly themeIndex: number
}

const initialState = (item: BrowseItem, themeName: ThemeName): BrowseState => ({
  col0: { items: [item], selectedIndex: 0 },
  col1: { items: [], selectedIndex: 0 },
  focusedColumn: 0,
  history: [],
  selectedAction: 0,
  showPreview: false,
  showThemeSelector: false,
  previewContent: "",
  previewScroll: 0,
  loading: false,
  themeName,
  themeIndex: themeNames.indexOf(themeName)
})

export function BrowseApp({ service, initialItem, userEmail, onQuit, initialTheme, onThemeChange }: BrowseAppProps) {
  const dimensions = useTerminalDimensions()
  const [state, setState] = useState<BrowseState>(() => initialState(initialItem, initialTheme))

  const {
    col0,
    col1,
    focusedColumn,
    history,
    selectedAction,
    showPreview,
    showThemeSelector,
    previewContent,
    previewScroll,
    loading,
    themeName,
    themeIndex
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
  const executeAction = (item: BrowseItem) => {
    if (selectedAction === 0) {
      Effect.runPromise(service.openInBrowser(item))
    } else if (selectedAction === 1) {
      runEffect(service.getPreview(item), (content) => {
        setState((s) => ({
          ...s,
          previewContent: content,
          previewScroll: 0,
          showPreview: true
        }))
      })
    } else if (selectedAction === 2) {
      // Open theme selector
      setState((s) => ({ ...s, showThemeSelector: true }))
    }
  }

  // Apply theme and save
  const applyTheme = (name: ThemeName) => {
    setState((s) => ({ ...s, themeName: name, themeIndex: themeNames.indexOf(name), showThemeSelector: false }))
    onThemeChange(name)
  }

  // Keyboard navigation
  useKeyboard((key) => {
    const currentItem = getSelectedItem()

    // Theme selector mode
    if (showThemeSelector) {
      if (key.name === "escape" || key.name === "q") {
        setState((s) => ({ ...s, showThemeSelector: false }))
      } else if (key.name === "j" || key.name === "down") {
        setState((s) => ({ ...s, themeIndex: Math.min(s.themeIndex + 1, themeNames.length - 1) }))
      } else if (key.name === "k" || key.name === "up") {
        setState((s) => ({ ...s, themeIndex: Math.max(s.themeIndex - 1, 0) }))
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
        if (selectedAction < ACTIONS.length - 1) {
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
              const idx = siblings.findIndex((s) => s.id === item.id)
              setState((s) => ({
                ...s,
                col1: s.col0,
                col0: { items: siblings, selectedIndex: idx >= 0 ? idx : 0 }
              }))
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
      } else if (focusedColumn === 2 && currentItem) {
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
    </box>
  )
}
