/**
 * Reducer for TUI navigation state machine.
 */
import { getActions } from "./components/ActionsPanel.js"
import { themeNames } from "./themes/index.js"
import type { TuiItem } from "./TuiItem.js"
import type { Action, Focus, ReducerResult, TuiState } from "./types.js"

/**
 * Get the currently selected item based on focus state.
 */
export function getSelectedItem(state: TuiState): TuiItem | undefined {
  const col = state.focus.type === "actions"
    ? state.focus.selectedFrom === 0
      ? state.col0
      : state.col1
    : state.focus.type === "column"
    ? state.focus.index === 0
      ? state.col0
      : state.col1
    : state.col0 // preview/modal defaults to col0
  return col.items[col.selectedIndex]
}

/**
 * Main reducer function.
 */
export function reducer(state: TuiState, action: Action): ReducerResult {
  // Handle mode transitions
  if (action.type === "mode/set") {
    return { state: { ...state, mode: action.mode } }
  }

  // Quit always works regardless of focus state
  if (action.type === "nav/quit") {
    return { state, effect: { type: "quit" } }
  }

  // Handle status updates first
  if (action.type === "ui/setStatus") {
    return { state: { ...state, status: action.status } }
  }
  if (action.type === "data/setCol0") {
    return { state: { ...state, col0: { items: action.items, selectedIndex: 0 } } }
  }
  if (action.type === "data/setCol1") {
    return { state: { ...state, col1: { items: action.items, selectedIndex: 0 } } }
  }
  if (action.type === "data/updateCol0Selection") {
    return {
      state: { ...state, col0: { ...state.col0, selectedIndex: action.index } },
      effect: { type: "loadChildren", item: state.col0.items[action.index]! }
    }
  }

  // Route to handler based on focus
  switch (state.focus.type) {
    case "modal":
      return handleModal(state, action)
    case "preview":
      return handlePreview(state, action)
    case "actions":
      return handleActions(state, action)
    case "column":
      return handleColumn(state, action)
  }
}

/**
 * Handle modal focus state (theme selector, new page prompt, or login).
 */
function handleModal(state: TuiState, action: Action): ReducerResult {
  const modal = state.focus as Extract<Focus, { type: "modal" }>

  if (modal.kind === "theme") {
    if (action.type === "nav/back" || action.type === "ui/closeModal") {
      return { state: { ...state, focus: { type: "actions", selectedFrom: 0 } } }
    }
    if (action.type === "nav/up" || action.type === "theme/navigate") {
      const dir = action.type === "theme/navigate" ? action.direction : "up"
      const delta = dir === "up" ? -1 : 1
      const newIdx = (state.themeIndex + delta + themeNames.length) % themeNames.length
      return { state: { ...state, themeIndex: newIdx } }
    }
    if (action.type === "nav/down") {
      const newIdx = (state.themeIndex + 1) % themeNames.length
      return { state: { ...state, themeIndex: newIdx } }
    }
    if (action.type === "nav/enter" || action.type === "theme/select") {
      const name = action.type === "theme/select" ? action.name : themeNames[state.themeIndex]!
      return {
        state: {
          ...state,
          themeName: name,
          themeIndex: themeNames.indexOf(name),
          focus: { type: "actions", selectedFrom: 0 }
        },
        effect: { type: "applyTheme", name }
      }
    }
    return { state }
  }

  // New page modal
  if (modal.kind === "newPage") {
    if (action.type === "nav/back" || action.type === "ui/closeModal") {
      return { state: { ...state, focus: { type: "actions", selectedFrom: 0 }, newPageTitle: "" } }
    }
    if (action.type === "newPage/updateTitle") {
      return { state: { ...state, newPageTitle: action.title } }
    }
    if (action.type === "newPage/backspace") {
      return { state: { ...state, newPageTitle: state.newPageTitle.slice(0, -1) } }
    }
    if (action.type === "nav/enter" && modal.parentId && state.newPageTitle.trim()) {
      return {
        state: { ...state, focus: { type: "actions", selectedFrom: 0 }, newPageTitle: "" },
        effect: { type: "createPage", parentId: modal.parentId, title: state.newPageTitle.trim() }
      }
    }
    return { state }
  }

  // Login modal (shows status during OAuth flow)
  if (modal.kind === "login") {
    if (action.type === "nav/back" || action.type === "ui/closeModal") {
      return { state: { ...state, focus: { type: "column", index: 0 } } }
    }
    return { state }
  }

  return { state }
}

/**
 * Handle preview focus state.
 */
function handlePreview(state: TuiState, action: Action): ReducerResult {
  const previewLines = state.previewContent.split("\n")

  if (
    action.type === "nav/back" || action.type === "ui/closeModal" || action.type === "nav/left" ||
    action.type === "nav/select"
  ) {
    return { state: { ...state, focus: { type: "actions", selectedFrom: 0 } } }
  }
  if (action.type === "nav/down") {
    if (state.previewScroll < previewLines.length - 1) {
      return { state: { ...state, previewScroll: state.previewScroll + 1 } }
    }
    return { state }
  }
  if (action.type === "nav/up") {
    if (state.previewScroll > 0) {
      return { state: { ...state, previewScroll: state.previewScroll - 1 } }
    }
    return { state }
  }
  return { state }
}

/**
 * Handle actions panel focus state.
 */
function handleActions(state: TuiState, action: Action): ReducerResult {
  const actionsFocus = state.focus as Extract<Focus, { type: "actions" }>
  const item = getSelectedItem(state)
  const { totalActions } = getActions(state.mode)

  if (action.type === "nav/back" || action.type === "nav/left") {
    // Go back to column
    const targetCol = state.col1.items.length > 0 ? 1 : 0
    return { state: { ...state, focus: { type: "column", index: targetCol as 0 | 1 } } }
  }
  if (action.type === "nav/down") {
    if (state.selectedAction < totalActions - 1) {
      return { state: { ...state, selectedAction: state.selectedAction + 1 } }
    }
    return { state }
  }
  if (action.type === "nav/up") {
    if (state.selectedAction > 0) {
      return { state: { ...state, selectedAction: state.selectedAction - 1 } }
    }
    return { state }
  }
  if (action.type === "nav/enter") {
    return executeAction(state, item, actionsFocus.selectedFrom)
  }

  // UI actions
  if (action.type === "ui/showPreview") {
    return { state: { ...state, focus: { type: "preview" }, previewContent: action.content, previewScroll: 0 } }
  }
  if (action.type === "ui/showTheme") {
    return { state: { ...state, focus: { type: "modal", kind: "theme" } } }
  }
  if (action.type === "ui/showNewPage" && action.parentId) {
    return {
      state: { ...state, focus: { type: "modal", kind: "newPage", parentId: action.parentId }, newPageTitle: "" }
    }
  }
  if (action.type === "ui/showLogin") {
    return { state: { ...state, focus: { type: "modal", kind: "login" } } }
  }

  return { state }
}

/**
 * Execute the currently selected action based on mode.
 */
function executeAction(state: TuiState, item: TuiItem | undefined, _selectedFrom: 0 | 1): ReducerResult {
  const idx = state.selectedAction
  const { selectionActions, systemActions } = getActions(state.mode)

  // Selection actions (require item for most)
  if (idx < selectionActions.length) {
    const actionId = selectionActions[idx]?.id

    // Auth menu items handle themselves
    if (item?.type === "auth-menu") {
      if (item.id === "create-oauth") {
        return { state, effect: { type: "createOAuth" } }
      }
      if (item.id === "login") {
        return { state, effect: { type: "login" } }
      }
      if (item.id === "quit") {
        return { state, effect: { type: "quit" } }
      }
    }

    if (!item) return { state }

    if (actionId === "open") {
      return { state, effect: { type: "openBrowser", item } }
    }
    if (actionId === "preview") {
      return { state, effect: { type: "loadPreview", item } }
    }
    if (actionId === "pull") {
      return { state, effect: { type: "pullPage", item } }
    }
    if (actionId === "clone") {
      return { state, effect: { type: "clonePage", item } }
    }
    if (actionId === "new-page" && item.type === "page") {
      return { state: { ...state, focus: { type: "modal", kind: "newPage", parentId: item.id }, newPageTitle: "" } }
    }
  }

  // System actions
  const systemIdx = idx - selectionActions.length
  if (systemIdx >= 0 && systemIdx < systemActions.length) {
    const actionId = systemActions[systemIdx]?.id

    if (actionId === "theme") {
      return { state: { ...state, focus: { type: "modal", kind: "theme" } } }
    }
    if (actionId === "status") {
      return { state, effect: { type: "getStatus" } }
    }
    if (actionId === "new-root-page") {
      const rootItem = state.col0.items[0]
      if (rootItem?.type === "page") {
        return {
          state: { ...state, focus: { type: "modal", kind: "newPage", parentId: rootItem.id }, newPageTitle: "" }
        }
      }
    }
    if (actionId === "logout") {
      return { state, effect: { type: "logout" } }
    }
    if (actionId === "quit") {
      return { state, effect: { type: "quit" } }
    }
  }

  return { state }
}

/**
 * Handle column focus state (col0 or col1).
 */
function handleColumn(state: TuiState, action: Action): ReducerResult {
  const colFocus = state.focus as Extract<Focus, { type: "column" }>
  const col = colFocus.index === 0 ? state.col0 : state.col1
  const item = col.items[col.selectedIndex]

  // In unauthenticated mode, Enter on auth menu items triggers action
  if (action.type === "nav/enter" && item?.type === "auth-menu") {
    if (item.id === "create-oauth") {
      return { state, effect: { type: "createOAuth" } }
    }
    if (item.id === "login") {
      return { state, effect: { type: "login" } }
    }
    if (item.id === "quit") {
      return { state, effect: { type: "quit" } }
    }
  }

  if (action.type === "nav/back") {
    return { state, effect: { type: "quit" } }
  }

  if (action.type === "nav/select") {
    // Space - go to actions panel
    return { state: { ...state, focus: { type: "actions", selectedFrom: colFocus.index } } }
  }

  if (action.type === "nav/up") {
    if (col.selectedIndex > 0) {
      const newIdx = col.selectedIndex - 1
      if (colFocus.index === 0) {
        // Don't load children for auth menu items
        const newItem = state.col0.items[newIdx]
        if (newItem?.type === "auth-menu") {
          return { state: { ...state, col0: { ...state.col0, selectedIndex: newIdx } } }
        }
        return {
          state: { ...state, col0: { ...state.col0, selectedIndex: newIdx } },
          effect: { type: "loadChildren", item: state.col0.items[newIdx]! }
        }
      }
      return { state: { ...state, col1: { ...state.col1, selectedIndex: newIdx } } }
    }
    return { state }
  }

  if (action.type === "nav/down") {
    if (col.selectedIndex < col.items.length - 1) {
      const newIdx = col.selectedIndex + 1
      if (colFocus.index === 0) {
        // Don't load children for auth menu items
        const newItem = state.col0.items[newIdx]
        if (newItem?.type === "auth-menu") {
          return { state: { ...state, col0: { ...state.col0, selectedIndex: newIdx } } }
        }
        return {
          state: { ...state, col0: { ...state.col0, selectedIndex: newIdx } },
          effect: { type: "loadChildren", item: state.col0.items[newIdx]! }
        }
      }
      return { state: { ...state, col1: { ...state.col1, selectedIndex: newIdx } } }
    }
    return { state }
  }

  if (action.type === "nav/left") {
    if (colFocus.index === 1) {
      // Move from col1 to col0
      return { state: { ...state, focus: { type: "column", index: 0 } } }
    }
    if (colFocus.index === 0) {
      // At col0, try to go back in history or load parent
      if (state.history.length > 0) {
        const prev = state.history[state.history.length - 1]!
        return {
          state: {
            ...state,
            history: state.history.slice(0, -1),
            col1: state.col0,
            col0: prev
          }
        }
      }
      // No history, try to load parent siblings (not for auth menu)
      if (item && item.type !== "auth-menu") {
        return { state, effect: { type: "loadParentSiblings", item } }
      }
    }
    return { state }
  }

  if (action.type === "nav/right") {
    // Auth menu items don't have children
    if (item?.type === "auth-menu") {
      return { state }
    }

    if (colFocus.index === 0) {
      if (state.col1.items.length > 0) {
        // Has children, move to col1
        return { state: { ...state, focus: { type: "column", index: 1 } } }
      }
      // No children, go to actions
      return { state: { ...state, focus: { type: "actions", selectedFrom: 0 } } }
    }
    if (colFocus.index === 1 && item) {
      // Check if col1 item has children
      return { state, effect: { type: "checkChildrenAndDrill", item } }
    }
    return { state }
  }

  if (action.type === "nav/enter") {
    if (colFocus.index === 0 && state.col1.items.length > 0) {
      // Move focus to col1
      return { state: { ...state, focus: { type: "column", index: 1 } } }
    }
    if (colFocus.index === 1 && item) {
      // Drill into col1 item
      return { state, effect: { type: "checkChildrenAndDrill", item } }
    }
    return { state }
  }

  // Data updates from effects
  if (action.type === "data/drill") {
    return {
      state: {
        ...state,
        history: [...state.history, state.col0],
        col0: state.col1,
        col1: { items: action.children, selectedIndex: 0 },
        focus: { type: "column", index: 0 }
      }
    }
  }

  if (action.type === "data/goBack") {
    return {
      state: {
        ...state,
        col1: state.col0,
        col0: { items: action.siblings, selectedIndex: action.idx }
      }
    }
  }

  // UI actions
  if (action.type === "ui/showPreview") {
    return { state: { ...state, focus: { type: "preview" }, previewContent: action.content, previewScroll: 0 } }
  }

  return { state }
}
