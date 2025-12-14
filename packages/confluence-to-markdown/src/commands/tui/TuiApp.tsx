/**
 * Main TUI application component with mode-aware state machine.
 */
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { useEffect, useReducer, useRef } from "react"
import { ActionsPanel } from "./components/ActionsPanel.js"
import { Column } from "./components/Column.js"
import { NewPageModal } from "./components/NewPageModal.js"
import { StatusBar } from "./components/StatusBar.js"
import { ThemeSelector } from "./components/ThemeSelector.js"
import { getSelectedItem, reducer } from "./reducer.js"
import { type ThemeName, themeNames, themes } from "./themes/index.js"
import type { AuthMenuItem, PageTuiItem, TuiItem } from "./TuiItem.js"
import type { TuiService } from "./TuiService.js"
import type { Action, SideEffect, TuiState } from "./types.js"

/**
 * Auth menu items for unauthenticated mode.
 */
const AUTH_MENU_ITEMS: ReadonlyArray<AuthMenuItem> = [
  { type: "auth-menu", id: "create-oauth", title: "Create OAuth Client", icon: "⚙" },
  { type: "auth-menu", id: "login", title: "Login", icon: "→" },
  { type: "auth-menu", id: "quit", title: "Quit", icon: "⎋" }
]

interface TuiAppProps {
  readonly service: TuiService
  readonly initialItems: ReadonlyArray<TuiItem>
  readonly userEmail: string | null
  readonly onQuit: () => void
  readonly initialTheme: ThemeName
  readonly onThemeChange: (theme: ThemeName) => void
  readonly onModeChange: () => void
}

const initialState = (items: ReadonlyArray<TuiItem>, themeName: ThemeName, service: TuiService): TuiState => ({
  mode: service.mode,
  focus: { type: "column", index: 0 },
  col0: { items, selectedIndex: 0 },
  col1: { items: [], selectedIndex: 0 },
  history: [],
  selectedAction: 0,
  previewContent: "",
  previewScroll: 0,
  newPageTitle: "",
  themeName,
  themeIndex: themeNames.indexOf(themeName),
  status: null
})

/**
 * Convert key event to action.
 */
function keyToAction(key: KeyEvent, state: TuiState): Action | null {
  // Quit shortcuts - always work (check various key formats)
  if (key.ctrl && key.name === "c") return { type: "nav/quit" }
  if (key.name === "q" || key.name === "Q" || key.sequence === "q" || key.sequence === "Q") {
    return { type: "nav/quit" }
  }

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
  if (key.name === "escape") return { type: "nav/back" }

  return null
}

export function TuiApp({
  initialItems,
  initialTheme,
  onModeChange,
  onQuit,
  onThemeChange,
  service,
  userEmail
}: TuiAppProps) {
  const dimensions = useTerminalDimensions()
  const [state, dispatch] = useReducer(
    (s: TuiState, a: Action) => reducer(s, a).state,
    initialState(initialItems, initialTheme, service)
  )

  // Track pending effects
  const pendingEffect = useRef<SideEffect | undefined>(undefined)

  // Track latest state for keyboard handler (avoids stale closure)
  const stateRef = useRef(state)
  stateRef.current = state

  const {
    col0,
    col1,
    focus,
    mode,
    newPageTitle,
    previewContent,
    previewScroll,
    selectedAction,
    status,
    themeIndex,
    themeName
  } = state
  const theme = themes[themeName]
  const selectedItem = getSelectedItem(state)

  // Helper to run Effect with status updates
  const runEffect = <A, E>(
    loadingMsg: string,
    effect: Effect.Effect<A, E>,
    onSuccess: (a: A) => void,
    successMsg?: string | ((a: A) => string)
  ) => {
    dispatch({ type: "ui/setStatus", status: { type: "loading", message: loadingMsg } })
    Effect.runPromise(Effect.either(effect)).then((either) => {
      if (either._tag === "Right") {
        onSuccess(either.right)
        if (successMsg) {
          const msg = typeof successMsg === "function" ? successMsg(either.right) : successMsg
          dispatch({ type: "ui/setStatus", status: { type: "success", message: msg } })
          setTimeout(() => dispatch({ type: "ui/setStatus", status: null }), 3000)
        } else {
          dispatch({ type: "ui/setStatus", status: null })
        }
      } else {
        dispatch({ type: "ui/setStatus", status: { type: "error", message: String(either.left) } })
      }
    })
  }

  // Execute side effects
  useEffect(() => {
    const effect = pendingEffect.current
    if (!effect) return
    pendingEffect.current = undefined

    switch (effect.type) {
      case "loadChildren":
        if (effect.item.type !== "auth-menu") {
          runEffect("Loading...", service.getChildren(effect.item), (children) => {
            dispatch({ type: "data/setCol1", items: children })
          })
        }
        break

      case "loadPreview":
        runEffect("Loading preview...", service.getPreview(effect.item), (content) => {
          dispatch({ type: "ui/showPreview", content })
        })
        break

      case "loadParentSiblings":
        runEffect("Loading...", service.getParentAndSiblings(effect.item), (result) => {
          if (Option.isSome(result)) {
            const { siblings } = result.value
            const currentIds = new Set(col0.items.filter((i) => i.type !== "auth-menu").map((i) => i.id))
            const siblingIds = new Set(siblings.filter((s) => s.type !== "auth-menu").map((s) => s.id))
            const sameContent = currentIds.size === siblingIds.size && [...currentIds].every((id) => siblingIds.has(id))
            if (!sameContent && effect.item.type === "page") {
              const idx = siblings.findIndex((s) => s.type === "page" && s.id === effect.item.id)
              dispatch({ type: "data/goBack", siblings, idx: idx >= 0 ? idx : 0 })
            }
          }
        })
        break

      case "openBrowser":
        Effect.runPromise(service.openInBrowser(effect.item))
        break

      case "pullPage":
        runEffect(
          "Pulling page...",
          service.pullPage(effect.item),
          () => {},
          (result) => result
        )
        break

      case "clonePage":
        if (effect.item.type === "page") {
          runEffect(
            "Cloning...",
            service.clonePage(effect.item as PageTuiItem),
            () => {},
            (result) => result
          )
        }
        break

      case "createPage":
        runEffect(
          "Creating page...",
          service.createNewPage(effect.parentId, effect.title),
          () => {},
          (result) => result
        )
        break

      case "getStatus":
        runEffect("Loading status...", service.getStatus, (syncStatus) => {
          dispatch({ type: "ui/showPreview", content: `Sync Status:\n\n${syncStatus}` })
        })
        break

      case "createOAuth":
        Effect.runPromise(service.createOAuthClient)
        dispatch({ type: "ui/setStatus", status: { type: "info", message: "Opening browser..." } })
        setTimeout(() => dispatch({ type: "ui/setStatus", status: null }), 2000)
        break

      case "login":
        dispatch({ type: "ui/setStatus", status: { type: "loading", message: "Starting login..." } })
        Effect.runPromise(Effect.either(service.login)).then((result) => {
          if (result._tag === "Right") {
            dispatch({ type: "ui/setStatus", status: { type: "success", message: "Logged in!" } })
            // Trigger mode change to reload with new auth state
            setTimeout(() => onModeChange(), 1000)
          } else {
            dispatch({ type: "ui/setStatus", status: { type: "error", message: "Login failed" } })
          }
        })
        break

      case "logout":
        Effect.runPromise(service.logout)
        dispatch({ type: "ui/setStatus", status: { type: "info", message: "Logged out" } })
        setTimeout(() => onModeChange(), 1000)
        break

      case "quit":
        onQuit()
        // Fallback: force exit after short delay if onQuit doesn't work
        setTimeout(() => process.exit(0), 100)
        break

      case "applyTheme":
        onThemeChange(effect.name)
        break

      case "checkChildrenAndDrill":
        if (effect.item.type !== "auth-menu") {
          runEffect("Loading...", service.getChildren(effect.item), (children) => {
            if (children.length > 0) {
              dispatch({ type: "data/drill", children })
            } else {
              // No children - go to actions panel and show info
              dispatch({ type: "nav/select" })
              dispatch({ type: "ui/setStatus", status: { type: "info", message: "No child pages" } })
              setTimeout(() => dispatch({ type: "ui/setStatus", status: null }), 2000)
            }
          })
        }
        break
    }
  })

  // Load initial children (only if first item is not auth-menu)
  useEffect(() => {
    const item = col0.items[col0.selectedIndex]
    if (item && item.type !== "auth-menu") {
      runEffect("Loading...", service.getChildren(item), (children) => {
        dispatch({ type: "data/setCol1", items: children })
      })
    }
  }, [])

  // Keyboard handler - use stateRef to avoid stale closure
  useKeyboard((key) => {
    const currentState = stateRef.current
    const action = keyToAction(key, currentState)
    if (action) {
      const result = reducer(currentState, action)
      pendingEffect.current = result.effect
      dispatch(action)
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

  // Header text based on mode
  const headerText =
    mode.type === "unauthenticated"
      ? "Authentication"
      : mode.type === "authenticated"
        ? "Confluence Spaces"
        : service.siteName

  return (
    <box width={dimensions.width} height={dimensions.height} flexDirection="column" backgroundColor={theme.bg.primary}>
      {/* Header */}
      <box height={1} backgroundColor={theme.bg.header} paddingLeft={1} flexDirection="row">
        <text fg={theme.accent.primary}>{"◈ "}</text>
        <text fg={theme.text.primary}>{headerText}</text>
        {selectedItem && selectedItem.type !== "auth-menu" ? (
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
          mode={mode}
          selectedItem={selectedItem}
          isFocused={inActionsPanel}
          selectedAction={selectedAction}
          showPreview={showPreview}
          previewContent={previewContent}
          previewScroll={previewScroll}
          width={actionsWidth}
          height={contentHeight}
          theme={theme}
        />
      </box>

      {/* Status bar */}
      <StatusBar
        width={dimensions.width}
        userEmail={userEmail}
        inActionsPanel={inActionsPanel}
        theme={theme}
        status={status}
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

export { AUTH_MENU_ITEMS }
