import { makeDiagramRenderer } from "./diagram-renderer.js"

// Retain source ownership and the render queue through React's setup/cleanup/setup cycle.
const renderers = new WeakMap<HTMLElement, {
  readonly render: () => Promise<void>
  readonly preferredDark: MediaQueryList
  readonly printing: MediaQueryList
}>()

/** Subscribe a mounted guide; cleanup stops future observations without cancelling an active SVG draw. */
export const observeGuideDiagrams = (
  root: HTMLElement,
  draw: Parameters<typeof makeDiagramRenderer>[2]
): () => void => {
  let renderer = renderers.get(root)
  if (renderer === undefined) {
    const preferredDark = matchMedia("(prefers-color-scheme: dark)")
    const printing = matchMedia("print")
    renderer = { render: makeDiagramRenderer(root, preferredDark, draw, printing), preferredDark, printing }
    renderers.set(root, renderer)
  }
  const { preferredDark, printing, render } = renderer
  const update = () => {
    void render()
  }
  const observer = new MutationObserver(update)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-theme"] })
  preferredDark.addEventListener("change", update)
  printing.addEventListener("change", update)
  update()
  return () => {
    observer.disconnect()
    preferredDark.removeEventListener("change", update)
    printing.removeEventListener("change", update)
  }
}
