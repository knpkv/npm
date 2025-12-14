/**
 * Reducer for browse navigation state machine.
 */
import type { BrowseItem } from "./BrowseItem.js"
import { SELECTION_ACTIONS, TOTAL_ACTIONS } from "./components/ActionsPanel.js"
import { themeNames } from "./themes/index.js"
import type { Action, BrowseState, Focus, ReducerResult } from "./types.js"

/**
 * Get the currently selected item based on focus state.
 */
export function getSelectedItem(state: BrowseState): BrowseItem | undefined {
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
export function reducer(state: BrowseState, action: Action): ReducerResult {
  // Handle loading state updates first
  if (action.type === "ui/setLoading") {
    return { state: { ...state, loading: action.loading } }
  }
  if (action.type === "ui/setStatus") {
    return { state: { ...state, statusMessage: action.msg } }
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
 * Handle modal focus state (theme selector or new page prompt).
 */
function handleModal(state: BrowseState, action: Action): ReducerResult {
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

  return { state }
}

/**
 * Handle preview focus state.
 */
function handlePreview(state: BrowseState, action: Action): ReducerResult {
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
function handleActions(state: BrowseState, action: Action): ReducerResult {
  const actionsFocus = state.focus as Extract<Focus, { type: "actions" }>
  const item = getSelectedItem(state)

  if (action.type === "nav/back" || action.type === "nav/left") {
    // Go back to column
    const targetCol = state.col1.items.length > 0 ? 1 : 0
    return { state: { ...state, focus: { type: "column", index: targetCol as 0 | 1 } } }
  }
  if (action.type === "nav/down") {
    if (state.selectedAction < TOTAL_ACTIONS - 1) {
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

  return { state }
}

/**
 * Execute the currently selected action.
 */
function executeAction(state: BrowseState, item: BrowseItem | undefined, _selectedFrom: 0 | 1): ReducerResult {
  const idx = state.selectedAction

  // Selection actions (require item)
  if (idx < SELECTION_ACTIONS.length) {
    if (!item) return { state }

    if (idx === 0) {
      // Open in browser
      return { state, effect: { type: "openBrowser", item } }
    }
    if (idx === 1) {
      // Preview
      return { state, effect: { type: "loadPreview", item } }
    }
    if (idx === 2) {
      // Add/sync
      return { state, effect: { type: "pullPage", item } }
    }
    if (idx === 3) {
      // New page under selected
      return { state: { ...state, focus: { type: "modal", kind: "newPage", parentId: item.id }, newPageTitle: "" } }
    }
  }

  // System actions
  const systemIdx = idx - SELECTION_ACTIONS.length
  if (systemIdx === 0) {
    // Theme
    return { state: { ...state, focus: { type: "modal", kind: "theme" } } }
  }
  if (systemIdx === 1) {
    // Status
    return { state, effect: { type: "getStatus" } }
  }
  if (systemIdx === 2) {
    // Add page under root - need initialItem, use col0[0]
    const rootItem = state.col0.items[0]
    if (rootItem) {
      return { state: { ...state, focus: { type: "modal", kind: "newPage", parentId: rootItem.id }, newPageTitle: "" } }
    }
  }

  return { state }
}

/**
 * Handle column focus state (col0 or col1).
 */
function handleColumn(state: BrowseState, action: Action): ReducerResult {
  const colFocus = state.focus as Extract<Focus, { type: "column" }>
  const col = colFocus.index === 0 ? state.col0 : state.col1
  const item = col.items[col.selectedIndex]

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
      // No history, try to load parent siblings
      if (item) {
        return { state, effect: { type: "loadParentSiblings", item } }
      }
    }
    return { state }
  }

  if (action.type === "nav/right") {
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
