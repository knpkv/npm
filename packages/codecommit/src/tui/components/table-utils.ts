/**
 * Pure helpers for Table layout and scroll calculations.
 *
 * Separated from Table.tsx to avoid transitive React/OpenTUI deps in tests.
 *
 * @internal
 */

/** Row height in lines: 1 content + 1 paddingBottom */
export const ROW_HEIGHT = 2

/** Rows of context to keep visible above the selected row */
export const SCROLL_LEAD = 2

/**
 * Compute the scroll-Y target so `selectedIndex` is visible with SCROLL_LEAD
 * rows of context above it.
 */
export const computeScrollTarget = (
  selectedIndex: number,
  rowHeight: number = ROW_HEIGHT,
  scrollLead: number = SCROLL_LEAD
): number => Math.max(0, (selectedIndex - scrollLead) * rowHeight)

/**
 * Resolve a Column width spec to a concrete `width` and `flexGrow` pair
 * suitable for the box layout engine.
 */
export const resolveColumnLayout = (
  width: number | `${number}%` | "auto" | undefined
): { readonly width: number | `${number}%` | 0; readonly flexGrow: 0 | 1 } => ({
  width: width === "auto" || !width ? 0 : width,
  flexGrow: width === "auto" || !width ? 1 : 0
})
