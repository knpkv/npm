interface RenderedDiffLineLocation {
  readonly lineNumber: number
  readonly side: "additions" | "deletions"
}

/** Resolve one Pierre renderer line across split, stacked, and alternate-line presentations. */
export const renderedDiffLine = (
  container: Element,
  location: RenderedDiffLineLocation
): HTMLElement | null => {
  const root = container.shadowRoot
  if (root === null) return null

  const sideContainer = location.side === "additions" ? "data-additions" : "data-deletions"
  const type = location.side === "additions" ? "change-addition" : "change-deletion"
  const contextLine = location.side === "additions" ? "data-line" : "data-alt-line"
  return (
    root.querySelector<HTMLElement>(`[${sideContainer}] [data-line="${location.lineNumber}"]`) ??
      root.querySelector<HTMLElement>(`[data-line="${location.lineNumber}"][data-line-type="${type}"]`) ??
      root.querySelector<HTMLElement>(`[${contextLine}="${location.lineNumber}"][data-line-type="context"]`) ??
      root.querySelector<HTMLElement>(`[${contextLine}="${location.lineNumber}"][data-line-type="context-expanded"]`) ??
      root.querySelector<HTMLElement>(`[${sideContainer}] [data-alt-line="${location.lineNumber}"]`) ??
      root.querySelector<HTMLElement>(`[${sideContainer}][data-line="${location.lineNumber}"]`) ??
      root.querySelector<HTMLElement>(`[${sideContainer}][data-alt-line="${location.lineNumber}"]`)
  )
}
