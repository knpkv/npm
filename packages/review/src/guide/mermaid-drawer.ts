import type { Mermaid } from "mermaid"

/**
 * Measures SVGs in Mermaid's body container, even when their destination tab is hidden.
 * Mermaid 12 defaults to ELK layout and the `neo` look; guides keep dagre and `classic` so existing
 * diagrams render as before.
 */
export const makeMermaidDrawer = (mermaid: Pick<Mermaid, "initialize" | "render">) => {
  let sequence = 0
  return async (nodes: Array<HTMLElement>, theme: "dark" | "neutral"): Promise<void> => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
      layout: "dagre",
      look: "classic"
    })
    for (const node of nodes) {
      const { bindFunctions, svg } = await mermaid.render(`review-diagram-${++sequence}`, node.textContent)
      node.innerHTML = svg
      node.dataset.processed = "true"
      bindFunctions?.(node)
    }
  }
}
