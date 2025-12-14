/**
 * Main browse application component with reducer-based state machine.
 */
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { useEffect, useReducer, useRef } from "react"
import type { BrowseItem } from "./BrowseItem.js"
import type { BrowseService } from "./BrowseService.js"
import { ActionsPanel } from "./components/ActionsPanel.js"
import { Column } from "./components/Column.js"
import { NewPageModal } from "./components/NewPageModal.js"
import { StatusBar } from "./components/StatusBar.js"
import { ThemeSelector } from "./components/ThemeSelector.js"
import { getSelectedItem, reducer } from "./reducer.js"
import { type ThemeName, themeNames, themes } from "./themes/index.js"
import type { Action, BrowseState, SideEffect } from "./types.js"

interface BrowseAppProps {
  readonly service: BrowseService
  readonly initialItem: BrowseItem
  readonly userEmail: string | null
  readonly onQuit: () => void
  readonly initialTheme: ThemeName
  readonly onThemeChange: (theme: ThemeName) => void
}

const initialState = (item: BrowseItem, themeName: ThemeName): BrowseState => ({
  focus: { type: "column", index: 0 },
  col0: { items: [item], selectedIndex: 0 },
  col1: { items: [], selectedIndex: 0 },
  history: [],
  selectedAction: 0,
  previewContent: "",
  previewScroll: 0,
  newPageTitle: "",
  loading: false,
  themeName,
  themeIndex: themeNames.indexOf(themeName),
  statusMessage: null
})

/**
 * Convert key event to action.
 */
function keyToAction(key: KeyEvent, state: BrowseState): Action | null {
  // Modal-specific handling
  if (state.focus.type === "modal" && state.focus.kind === "newPage") {
    if (key.name === "escape") return { type: "nav/back" }
    if (key.name === "return") return { type: "nav/enter" }
    if (key.name === "backspace") return { type: "newPage/backspace" }
    if (key.sequence && key.sequence.length === 1 && key.sequence.match(/[\w\s\-_.]/)) {
      return { type: "newPage/updateTitle", title: state.newPageTitle + key.sequence }
    }
    return null
  }

  // Standard navigation
  if (key.name === "j" || key.name === "down") return { type: "nav/down" }
  if (key.name === "k" || key.name === "up") return { type: "nav/up" }
  if (key.name === "h" || key.name === "left" || key.name === "backspace") return { type: "nav/left" }
  if (key.name === "l" || key.name === "right") return { type: "nav/right" }
  if (key.name === "space") return { type: "nav/select" }
  if (key.name === "return") return { type: "nav/enter" }
  if (key.name === "escape" || key.name === "q") return { type: "nav/back" }

  // Shortcuts
  if (key.name === "o") return { type: "nav/enter" } // treated as open in actions context
  if (key.name === "v") return { type: "nav/enter" } // treated as preview in actions context

  return null
}

export function BrowseApp({ initialItem, initialTheme, onQuit, onThemeChange, service, userEmail }: BrowseAppProps) {
  const dimensions = useTerminalDimensions()
  const [state, dispatch] = useReducer(
    (s: BrowseState, a: Action) => reducer(s, a).state,
    initialState(initialItem, initialTheme)
  )

  // Track pending effects
  const pendingEffect = useRef<SideEffect | undefined>(undefined)

  // Custom dispatch that captures side effects
  const dispatchWithEffect = (action: Action) => {
    const result = reducer(state, action)
    pendingEffect.current = result.effect
    dispatch(action)
  }

  const {
    col0,
    col1,
    focus,
    loading,
    newPageTitle,
    previewContent,
    previewScroll,
    selectedAction,
    statusMessage,
    themeIndex,
    themeName
  } = state
  const theme = themes[themeName]
  const selectedItem = getSelectedItem(state)

  // Helper to run Effect
  const runEffect = <A, E>(effect: Effect.Effect<A, E>, onSuccess: (a: A) => void) => {
    dispatch({ type: "ui/setLoading", loading: true })
    Effect.runPromise(Effect.either(effect)).then((either) => {
      if (either._tag === "Right") {
        onSuccess(either.right)
      }
      dispatch({ type: "ui/setLoading", loading: false })
    })
  }

  // Execute side effects
  useEffect(() => {
    const effect = pendingEffect.current
    if (!effect) return
    pendingEffect.current = undefined

    switch (effect.type) {
      case "loadChildren":
        runEffect(service.getChildren(effect.item), (children) => {
          dispatch({ type: "data/setCol1", items: children })
        })
        break

      case "loadPreview":
        runEffect(service.getPreview(effect.item), (content) => {
          dispatch({ type: "ui/showPreview", content })
        })
        break

      case "loadParentSiblings":
        runEffect(service.getParentAndSiblings(effect.item), (result) => {
          if (Option.isSome(result)) {
            const { siblings } = result.value
            const currentIds = new Set(col0.items.map((i) => i.id))
            const siblingIds = new Set(siblings.map((s) => s.id))
            const sameContent = currentIds.size === siblingIds.size && [...currentIds].every((id) => siblingIds.has(id))
            if (!sameContent) {
              const idx = siblings.findIndex((s) => s.id === effect.item.id)
              dispatch({ type: "data/goBack", siblings, idx: idx >= 0 ? idx : 0 })
            }
          }
        })
        break

      case "openBrowser":
        Effect.runPromise(service.openInBrowser(effect.item))
        break

      case "pullPage":
        runEffect(service.pullPage(effect.item), (result) => {
          dispatch({ type: "ui/setStatus", msg: result })
          setTimeout(() => dispatch({ type: "ui/setStatus", msg: null }), 3000)
        })
        break

      case "createPage":
        runEffect(service.createNewPage(effect.parentId, effect.title), (result) => {
          dispatch({ type: "ui/setStatus", msg: result })
          setTimeout(() => dispatch({ type: "ui/setStatus", msg: null }), 3000)
        })
        break

      case "getStatus":
        runEffect(service.getStatus, (status) => {
          dispatch({ type: "ui/showPreview", content: `Sync Status:\n\n${status}` })
        })
        break

      case "quit":
        onQuit()
        break

      case "applyTheme":
        onThemeChange(effect.name)
        break

      case "checkChildrenAndDrill":
        runEffect(service.getChildren(effect.item), (children) => {
          if (children.length > 0) {
            dispatch({ type: "data/drill", children })
          } else {
            // No children - go to actions
            dispatch({ type: "nav/select" })
          }
        })
        break
    }
  })

  // Load initial children
  useEffect(() => {
    const item = col0.items[col0.selectedIndex]
    if (item) {
      runEffect(service.getChildren(item), (children) => {
        dispatch({ type: "data/setCol1", items: children })
      })
    }
  }, [])

  // Keyboard handler
  useKeyboard((key) => {
    const action = keyToAction(key, state)
    if (action) {
      dispatchWithEffect(action)
    }
  })

  // Derived state for rendering
  const inActionsPanel = focus.type === "actions"
  const showPreview = focus.type === "preview"
  const showThemeSelector = focus.type === "modal" && focus.kind === "theme"
  const showNewPagePrompt = focus.type === "modal" && focus.kind === "newPage"
  const focusedColumn = focus.type === "column" ? focus.index : focus.type === "actions" ? 2 : -1

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
          isFocused={inActionsPanel}
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
        inActionsPanel={inActionsPanel}
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
        <NewPageModal title={newPageTitle} theme={theme} width={dimensions.width} height={dimensions.height} />
      ) : null}
    </box>
  )
}
