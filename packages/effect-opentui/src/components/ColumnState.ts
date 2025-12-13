/**
 * State management for column-based navigation.
 */
import type { Effect } from "effect"
import { Option, Ref } from "effect"

/**
 * State for a multi-column navigation component.
 *
 * @category models
 */
export interface ColumnState<T> {
  readonly focusedColumn: number
  readonly selectedIndices: Record<number, number>
  readonly columnData: Record<number, ReadonlyArray<T>>
  readonly previewContent: Option.Option<string>
}

/**
 * Creates initial column state.
 *
 * @category constructors
 */
export const makeColumnState = <T>(): ColumnState<T> => ({
  focusedColumn: 0,
  selectedIndices: {},
  columnData: {},
  previewContent: Option.none()
})

/**
 * Updates the focused column.
 *
 * @category state
 */
export const setFocusedColumn = (column: number) => <T>(state: ColumnState<T>): ColumnState<T> => ({
  ...state,
  focusedColumn: column
})

/**
 * Updates the selected index for a column.
 *
 * @category state
 */
export const setSelectedIndex = (column: number, index: number) => <T>(state: ColumnState<T>): ColumnState<T> => ({
  ...state,
  selectedIndices: { ...state.selectedIndices, [column]: index }
})

/**
 * Updates the data for a column.
 *
 * @category state
 */
export const setColumnData =
  <T>(column: number, data: ReadonlyArray<T>) => (state: ColumnState<T>): ColumnState<T> => ({
    ...state,
    columnData: { ...state.columnData, [column]: data }
  })

/**
 * Gets the currently selected item.
 *
 * @category state
 */
export const getSelectedItem = <T>(state: ColumnState<T>): T | undefined => {
  const column = state.focusedColumn
  const items = state.columnData[column]
  const index = state.selectedIndices[column] ?? 0
  return items?.[index]
}

/**
 * Creates a managed column state ref.
 *
 * @category constructors
 */
export const makeColumnStateRef = <T>(): Effect.Effect<Ref.Ref<ColumnState<T>>> => Ref.make(makeColumnState<T>())
