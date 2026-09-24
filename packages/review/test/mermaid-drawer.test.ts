// @vitest-environment happy-dom
import mermaid from "mermaid"
import { expect, it } from "vitest"
import { makeDiagramRenderer } from "../src/guide/diagram-renderer.js"
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

/** Real Mermaid failures must clean their body containers; valid sibling SVGs use the existing renderer seam. */
it.each(["invalid-first", "valid-first"])("keeps %s errors inline without orphan Mermaid SVGs", async (order) => {
  const root = document.createElement("div")
  const invalid = "deliberately invalid Mermaid syntax"
  const sources = order === "invalid-first"
    ? [invalid, "valid", "valid", invalid]
    : ["valid", invalid, invalid, "valid"]
  const nodes = sources.map((source) => {
    const node = document.createElement("pre")
    node.className = "mermaid"
    node.textContent = source
    root.append(node)
    return node
  })
  document.body.append(root)
  try {
    // Happy DOM sanitizes Mermaid's completed SVG to empty; the visible browser covers real successful rendering.
    const draw = makeMermaidDrawer({
      initialize: mermaid.initialize,
      render: async (id, source, container) =>
        source === "valid"
          ? { svg: "<svg viewBox=\"0 0 300 100\"></svg>", diagramType: "synthetic" }
          : mermaid.render(id, source, container)
    })
    const render = makeDiagramRenderer(root, { matches: false }, draw, { matches: false })
    await render()
    expect(root.querySelectorAll("[role=\"alert\"]")).toHaveLength(2)
    for (const [index, source] of sources.entries()) {
      const node = nodes[index]
      if (source === "valid") {
        expect(node?.querySelector("svg")).not.toBeNull()
        expect(node?.dataset.diagramTheme).toBe("neutral")
      } else {
        expect(node?.querySelector("[role=\"alert\"]")?.textContent).toBe(
          `Diagram rendering failed: UnknownDiagramError: No diagram type detected matching given configuration for text: ${invalid}`
        )
      }
    }
    expect(document.body.querySelectorAll("svg[aria-roledescription=\"error\"]")).toHaveLength(0)
    expect([...document.body.children]).toEqual([root])
  } finally {
    root.remove()
  }
})

/** Production initialization retains Mermaid's default protection against diagram-supplied configuration. */
it.each(["directive", "frontmatter"])("retains protected config through real Mermaid %s parsing", async (kind) => {
  const config = JSON.stringify({
    secure: [],
    securityLevel: "loose",
    startOnLoad: true,
    maxTextSize: 999999,
    suppressErrorRendering: false,
    maxEdges: 999999,
    fontSize: 31
  })
  const diagram = "flowchart LR; A-->B"
  const source = kind === "directive"
    ? `%%{init: ${config}}%%\n${diagram}`
    : `---\nconfig: ${config}\n---\n${diagram}`
  const node = document.createElement("pre")
  node.textContent = source
  const draw = makeMermaidDrawer({
    initialize: mermaid.initialize,
    render: async (_id, text) => {
      await mermaid.parse(text)
      return { svg: "<svg></svg>", diagramType: "flowchart-v2" }
    }
  })
  await draw([node], "neutral")
  expect(mermaid.mermaidAPI.getConfig()).toMatchObject({
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges"],
    securityLevel: "strict",
    startOnLoad: false,
    maxTextSize: 50000,
    suppressErrorRendering: true,
    maxEdges: 500,
    fontSize: 31
  })
})
