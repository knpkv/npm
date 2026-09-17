import mermaid from "mermaid"

const sources = new WeakMap<Element, string>()
let rendering = false
let renderedTheme = ""
const preferredDark = matchMedia("(prefers-color-scheme: dark)")

/** Re-render newly mounted tab content and theme changes after React has committed. */
const render = async () => {
  const root = document.getElementById("review-root")
  if (root === null || rendering) return
  const selectedTheme = root.querySelector<HTMLElement>("[data-theme]")?.dataset.theme
  const dark = selectedTheme === "dark" || (selectedTheme === "system" && preferredDark.matches)
  const theme = dark ? "dark" : "neutral"
  const nodes = [...root.querySelectorAll<HTMLElement>(".mermaid")]
  for (const node of nodes) {
    const source = sources.get(node)
    if (source === undefined) sources.set(node, node.textContent)
    else if (renderedTheme !== theme) {
      node.textContent = source
      delete node.dataset.processed
    }
  }
  const pending = nodes.filter((node) => node.dataset.processed !== "true")
  if (pending.length === 0) return
  renderedTheme = theme
  rendering = true
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme })
  try {
    await mermaid.run({ nodes: pending })
  } catch (cause) {
    const message = document.createElement("p")
    message.setAttribute("role", "alert")
    message.textContent = `Diagram rendering failed: ${String(cause)}`
    root.prepend(message)
    for (const node of pending) node.dataset.processed = "true"
  } finally {
    rendering = false
  }
}

const start = () => {
  const root = document.getElementById("review-root")
  if (root === null) return
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
