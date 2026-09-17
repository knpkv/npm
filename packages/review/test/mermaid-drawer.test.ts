// @vitest-environment happy-dom
import { expect, it } from "vitest"
import { makeMermaidDrawer } from "../src/guide/mermaid-drawer.js"

it.each(["none", "block"])("measures initial and replacement diagrams with tab display %s", async (display) => {
  const panel = document.createElement("section")
  panel.style.display = display
  const node = document.createElement("pre")
  node.textContent = "flowchart LR; A-->B"
  panel.append(node)
  document.body.append(panel)
  const sources: Array<string> = []
  const ids: Array<string> = []
  const draw = makeMermaidDrawer({
    initialize: () => {},
    render: async (id, source, container) => {
      sources.push(source)
      ids.push(id)
      const width = container?.closest<HTMLElement>("section")?.style.display === "none" ? 0 : 300
      return { svg: `<svg viewBox="0 0 ${width} 100"></svg>`, diagramType: "flowchart-v2" }
    }
  })
  try {
    const themes: Array<"dark" | "neutral"> = ["dark", "neutral"]
    for (const theme of themes) {
      node.textContent = "flowchart LR; A-->B"
      await draw([node], theme)
      expect(node.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 300 100")
      expect(node.dataset.processed).toBe("true")
    }
    expect(sources).toEqual(["flowchart LR; A-->B", "flowchart LR; A-->B"])
    expect(new Set(ids).size).toBe(2)
  } finally {
    panel.remove()
  }
})
