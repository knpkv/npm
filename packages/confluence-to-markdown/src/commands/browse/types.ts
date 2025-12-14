/**
 * Types for browse navigation state machine.
 */
import type { PageId } from "../../Brand.js"
import type { BrowseItem, ColumnState } from "./BrowseItem.js"
import type { StatusInfo } from "./components/StatusBar.js"
import type { ThemeName } from "./themes/index.js"

export type { StatusInfo, StatusType } from "./components/StatusBar.js"

/**
 * Focus state discriminated union.
 * Explicitly represents where the user is in the UI.
 */
export type Focus =
  | { readonly type: "column"; readonly index: 0 | 1 }
  | { readonly type: "actions"; readonly selectedFrom: 0 | 1 }
  | { readonly type: "preview" }
  | { readonly type: "modal"; readonly kind: "theme" | "newPage"; readonly parentId?: PageId }

/**
 * Reducer actions for state transitions.
 */
export type Action =
  // Navigation
  | { readonly type: "nav/up" }
  | { readonly type: "nav/down" }
  | { readonly type: "nav/left" }
  | { readonly type: "nav/right" }
  | { readonly type: "nav/select" }
  | { readonly type: "nav/back" }
  | { readonly type: "nav/enter" }
  // Data
  | { readonly type: "data/setCol1"; readonly items: ReadonlyArray<BrowseItem> }
  | { readonly type: "data/drill"; readonly children: ReadonlyArray<BrowseItem> }
  | { readonly type: "data/goBack"; readonly siblings: ReadonlyArray<BrowseItem>; readonly idx: number }
  | { readonly type: "data/updateCol0Selection"; readonly index: number }
  // UI
  | { readonly type: "ui/showPreview"; readonly content: string }
  | { readonly type: "ui/showTheme" }
  | { readonly type: "ui/showNewPage"; readonly parentId: PageId }
  | { readonly type: "ui/closeModal" }
  | { readonly type: "ui/setStatus"; readonly status: StatusInfo | null }
  // Theme
  | { readonly type: "theme/select"; readonly name: ThemeName }
  | { readonly type: "theme/navigate"; readonly direction: "up" | "down" }
  // New page
  | { readonly type: "newPage/updateTitle"; readonly title: string }
  | { readonly type: "newPage/backspace" }

/**
 * Browse state.
 */
export interface BrowseState {
  // Navigation focus
  readonly focus: Focus
  // Column data
  readonly col0: ColumnState
  readonly col1: ColumnState
  readonly history: ReadonlyArray<ColumnState>
  // Actions panel
  readonly selectedAction: number
  // Preview
  readonly previewContent: string
  readonly previewScroll: number
  // New page modal
  readonly newPageTitle: string
  // UI
  readonly themeName: ThemeName
  readonly themeIndex: number
  readonly status: StatusInfo | null
}

/**
 * Side effects that need to be executed after state update.
 */
export type SideEffect =
  | { readonly type: "loadChildren"; readonly item: BrowseItem }
  | { readonly type: "loadPreview"; readonly item: BrowseItem }
  | { readonly type: "loadParentSiblings"; readonly item: BrowseItem }
  | { readonly type: "openBrowser"; readonly item: BrowseItem }
  | { readonly type: "pullPage"; readonly item: BrowseItem }
  | { readonly type: "createPage"; readonly parentId: PageId; readonly title: string }
  | { readonly type: "getStatus" }
  | { readonly type: "quit" }
  | { readonly type: "applyTheme"; readonly name: ThemeName }
  | { readonly type: "checkChildrenAndDrill"; readonly item: BrowseItem }

/**
 * Reducer result with optional side effect.
 */
export interface ReducerResult {
  readonly state: BrowseState
  readonly effect?: SideEffect
}
