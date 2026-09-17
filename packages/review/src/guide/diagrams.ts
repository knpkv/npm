import mermaid from "mermaid"
import { makeDiagramRenderer } from "./diagram-renderer.js"
import { makeMermaidDrawer } from "./mermaid-drawer.js"

const start = () => {
  const root = document.getElementById("review-root")
  if (root === null) return
  const preferredDark = matchMedia("(prefers-color-scheme: dark)")
  const printing = matchMedia("print")
  const render = makeDiagramRenderer(root, preferredDark, makeMermaidDrawer(mermaid), printing)
  new MutationObserver(() => {
    void render()
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-theme"] })
  preferredDark.addEventListener("change", () => {
    void render()
  })
  printing.addEventListener("change", () => {
    void render()
  })
  void render()
}
if (document.documentElement.dataset.reviewReady === "true") start()
else document.addEventListener("review-ready", start, { once: true })
