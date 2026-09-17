import type { Mermaid } from "mermaid"

/** Measures SVGs in Mermaid's body container, even when their destination tab is hidden. */
export const makeMermaidDrawer = (mermaid: Pick<Mermaid, "initialize" | "render">) => {
  let sequence = 0
  return async (nodes: Array<HTMLElement>, theme: "dark" | "neutral"): Promise<void> => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme })
    for (const node of nodes) {
      const { bindFunctions, svg } = await mermaid.render(`review-diagram-${++sequence}`, node.textContent)
      node.innerHTML = svg
      node.dataset.processed = "true"
      bindFunctions?.(node)
    }
  }
}
