import mermaid from "mermaid"
import { makeDiagramRenderer } from "./diagram-renderer.js"

const start = () => {
  const root = document.getElementById("review-root")
  if (root === null) return
  const preferredDark = matchMedia("(prefers-color-scheme: dark)")
  const render = makeDiagramRenderer(root, preferredDark, async (nodes, theme) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme })
    await mermaid.run({ nodes })
  })
  new MutationObserver(() => {
    void render()
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-theme"] })
  preferredDark.addEventListener("change", () => {
    void render()
  })
  void render()
}
if (document.documentElement.dataset.reviewReady === "true") start()
else document.addEventListener("review-ready", start, { once: true })
