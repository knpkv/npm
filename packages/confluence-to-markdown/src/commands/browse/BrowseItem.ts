/**
 * Types for browse command.
 */
import type { PageId, SpaceId } from "../../Brand.js"

/**
 * Page item in the browse navigation tree.
 */
export interface PageBrowseItem {
  readonly type: "page"
  readonly id: PageId
  readonly title: string
  readonly synced: boolean
  readonly parentId?: PageId
  readonly spaceId?: SpaceId
}

/**
 * Space item in the browse navigation tree.
 */
export interface SpaceBrowseItem {
  readonly type: "space"
  readonly id: SpaceId
  readonly key: string
  readonly title: string
}

/**
 * Item in the browse navigation tree (discriminated union).
 */
export type BrowseItem = PageBrowseItem | SpaceBrowseItem

/**
 * Legacy item type for backwards compatibility.
 * @deprecated Use BrowseItem with type discriminator
 */
export interface LegacyBrowseItem {
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
