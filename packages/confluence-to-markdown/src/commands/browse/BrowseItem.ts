/**
 * Types for browse command.
 */
import type { PageId } from "../../Brand.js"

/**
 * Item in the browse navigation tree.
 */
export interface BrowseItem {
  readonly id: PageId
  readonly title: string
  readonly synced: boolean
  readonly parentId?: PageId
}

/**
 * State of a navigation column.
 */
export interface ColumnState {
  readonly items: ReadonlyArray<BrowseItem>
  readonly selectedIndex: number
}

/**
 * Parent navigation result.
 */
export interface ParentResult {
  readonly parent: BrowseItem
  readonly siblings: ReadonlyArray<BrowseItem>
}
