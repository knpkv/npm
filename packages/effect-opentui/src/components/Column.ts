/**
 * Single column component for list selection.
 */
import type { SelectRenderable } from "@opentui/core"

/**
 * Column definition with rendering functions.
 *
 * @category models
 */
export interface ColumnDef<T> {
  readonly id: string
  readonly renderItem: (item: T) => string
  readonly renderDescription?: (item: T) => string
}

/**
 * Updates column options in a SelectRenderable.
 *
 * @category rendering
 */
export const updateColumnOptions = <T>(
  select: SelectRenderable,
  items: ReadonlyArray<T>,
  colDef: ColumnDef<T>
): void => {
  select.options = items.map((item) => ({
    name: colDef.renderItem(item),
    description: colDef.renderDescription?.(item) ?? "",
    value: item
  }))
}

/**
 * Updates focus across multiple columns.
 *
 * @category rendering
 */
export const updateColumnFocus = (
  selects: ReadonlyArray<SelectRenderable>,
  focusIdx: number
): void => {
  selects.forEach((s, i) => {
    if (i === focusIdx) {
      s.focus()
    } else {
      s.blur()
    }
  })
}
