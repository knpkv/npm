export interface MobileCellMetrics {
  readonly text: string
  readonly rowContentWidth: number
  readonly cellWidth: number
  readonly intrinsicWidth: number
  readonly textLines: number
  readonly maxLineWidth: number
  readonly twoGlyphWidth: number
}

/** Evaluate after fonts load. Body cells must use the complete card width before wrapping their actual text. */
export const readMobileCellGeometry = (
  surface: "table" | "dependencies"
): ReadonlyArray<MobileCellMetrics | null> | null => {
  const context = document.createElement("canvas").getContext("2d")
  if (context === null) return null
  const selector = surface === "table" ? ".ac-detail-table tbody th" : ".ac-dependencies .ac-resource-name"
  return Array.from(document.querySelectorAll<HTMLElement>(selector), (cell) => {
    const row = cell.closest(surface === "table" ? "tr" : "li")
    const text = surface === "table" ? cell.querySelector<HTMLElement>(".ac-output-key, .ac-resource-name") : cell
    if (row === null || text === null) return null
    const style = getComputedStyle(text)
    const rowStyle = getComputedStyle(row)
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const range = document.createRange()
    range.selectNodeContents(text)
    const rectangles = Array.from(range.getClientRects())
    const value = text.textContent ?? ""
    return {
      text: value,
      rowContentWidth: row.getBoundingClientRect().width - Number.parseFloat(rowStyle.paddingInlineStart) -
        Number.parseFloat(rowStyle.paddingInlineEnd) - Number.parseFloat(rowStyle.borderInlineStartWidth) -
        Number.parseFloat(rowStyle.borderInlineEndWidth),
      cellWidth: cell.getBoundingClientRect().width,
      intrinsicWidth: context.measureText(value).width,
      textLines: new Set(rectangles.map((rect) => Math.round(rect.top * 100))).size,
      maxLineWidth: Math.max(0, ...rectangles.map((rect) => rect.width)),
      twoGlyphWidth: context.measureText("xx").width
    }
  })
}
