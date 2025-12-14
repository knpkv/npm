/**
 * Types for TUI navigation items.
 */
import type { PageId, SpaceId } from "../../Brand.js"

/**
 * Menu item for auth screen.
 */
export interface AuthMenuItem {
  readonly type: "auth-menu"
  readonly id: "create-oauth" | "login" | "quit"
  readonly title: string
  readonly icon: string
}

/**
 * Page item in the navigation tree.
 */
export interface PageTuiItem {
  readonly type: "page"
  readonly id: PageId
  readonly title: string
  readonly synced: boolean
  readonly parentId?: PageId
  readonly spaceId?: SpaceId
  readonly spaceKey?: string
}

/**
 * Space item in the navigation tree.
 */
export interface SpaceTuiItem {
  readonly type: "space"
  readonly id: SpaceId
  readonly key: string
  readonly title: string
}

/**
 * Item in the TUI navigation (discriminated union).
 */
export type TuiItem = AuthMenuItem | PageTuiItem | SpaceTuiItem

/**
 * State of a navigation column.
 */
export interface ColumnState {
  readonly items: ReadonlyArray<TuiItem>
  readonly selectedIndex: number
}

/**
 * Parent navigation result.
 */
export interface ParentResult {
  readonly parent: TuiItem
  readonly siblings: ReadonlyArray<TuiItem>
}
