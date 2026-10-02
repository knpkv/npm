/** Serializes diagram rendering and retains changes received during an active draw. */
export const makeDiagramRenderer = (
  root: HTMLElement,
  preferredDark: Pick<MediaQueryList, "matches">,
  draw: (nodes: Array<HTMLElement>, theme: "dark" | "neutral") => Promise<void>,
  printing: Pick<MediaQueryList, "matches">
): () => Promise<void> => {
  const sources = new WeakMap<Element, string>()
  let rendering = false
  let renderPending = false

  /** Re-render newly mounted tab content and theme changes after React has committed. */
  const render = async (): Promise<void> => {
    // Printing may change the system color preference; retain the completed SVG for synchronous capture.
    if (printing.matches && root.querySelector(".mermaid:not([data-processed=\"true\"])") === null) return
    if (rendering) {
      renderPending = true
      return
    }
    const selectedTheme = root.querySelector<HTMLElement>("[data-theme]")?.dataset.theme
    const dark = selectedTheme === "dark" || (selectedTheme === "system" && preferredDark.matches)
    const theme = dark ? "dark" : "neutral"
    const nodes = [...root.querySelectorAll<HTMLElement>(".mermaid")]
    for (const node of nodes) {
      const source = sources.get(node)
      if (source === undefined) sources.set(node, node.textContent)
      else if (!printing.matches && node.dataset.diagramTheme !== theme) {
        node.textContent = source
        delete node.dataset.processed
      }
    }
    const pending = nodes.filter((node) => node.dataset.processed !== "true")
    if (pending.length === 0) return
    rendering = true
    try {
      for (const node of pending) {
        try {
          await draw([node], theme)
        } catch (cause) {
          const message = document.createElement("span")
          message.setAttribute("role", "alert")
          message.textContent = `Diagram rendering failed: ${String(cause)}`
          node.replaceChildren(message)
          node.dataset.processed = "true"
        }
        node.dataset.diagramTheme = theme
      }
    } finally {
      rendering = false
      if (renderPending) {
        renderPending = false
        await render()
      }
    }
  }

  return render
}
