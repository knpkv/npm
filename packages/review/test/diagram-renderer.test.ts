// @vitest-environment happy-dom
import { expect, it } from "vitest"
import { makeDiagramRenderer } from "../src/guide/diagram-renderer.js"
import { makeMermaidDrawer } from "../src/guide/mermaid-drawer.js"

const diagram = (source: string) => {
  const node = document.createElement("pre")
  node.className = "mermaid"
  node.textContent = source
  return node
}

it("retains a completed system-theme diagram through print media changes and resumes afterward", async () => {
  const root = document.createElement("div")
  const themed = document.createElement("div")
  themed.dataset.theme = "system"
  const node = diagram("flowchart LR; A-->B")
  themed.append(node)
  root.append(themed)
  const preferredDark = { matches: true }
  const printing = { matches: false }
  const themes: Array<string> = []
  const render = makeDiagramRenderer(root, preferredDark, async (nodes, theme) => {
    themes.push(theme)
    for (const node of nodes) {
      node.dataset.processed = "true"
      node.textContent = `${theme} diagram`
    }
  }, printing)
  await render()
  printing.matches = true
  preferredDark.matches = false
  await render()
  expect(node.textContent).toBe("dark diagram")
  expect(node.dataset.diagramTheme).toBe("dark")
  expect(themes).toEqual(["dark"])
  printing.matches = false
  await render()
  expect(node.textContent).toBe("neutral diagram")
  expect(node.dataset.diagramTheme).toBe("neutral")
  expect(themes).toEqual(["dark", "neutral"])
})

it.each(["theme", "tab"])("retains a %s update while diagram rendering is active", async (change) => {
  const root = document.createElement("div")
  const themed = document.createElement("div")
  themed.dataset.theme = "light"
  themed.append(diagram("flowchart LR; A-->B"))
  root.append(themed)
  const release = Promise.withResolvers<void>()
  const calls: Array<{ readonly theme: string; readonly source: string }> = []
  const render = makeDiagramRenderer(root, { matches: false }, async (nodes, theme) => {
    calls.push({ theme, source: nodes.map((node) => node.textContent).join("\n") })
    for (const node of nodes) {
      node.dataset.processed = "true"
      node.textContent = "rendered diagram"
    }
    if (calls.length === 1) await release.promise
  }, { matches: false })
  const active = render()
  if (change === "theme") themed.dataset.theme = "dark"
  else themed.replaceChildren(diagram("flowchart LR; B-->C"))
  await render()
  release.resolve()
  await active
  expect(calls).toEqual([
    { theme: "neutral", source: "flowchart LR; A-->B" },
    {
      theme: change === "theme" ? "dark" : "neutral",
      source: change === "theme" ? "flowchart LR; A-->B" : "flowchart LR; B-->C"
    }
  ])
  await render()
  expect(calls).toHaveLength(2)
})

/** A syntax error belongs to one diagram; adjacent diagrams still render in either order. */
it.each([
  ["invalid", "valid"],
  ["valid", "invalid"],
  ["valid", "valid"]
])("isolates rendering for %s then %s", async (first, second) => {
  const root = document.createElement("div")
  const nodes = [diagram(first), diagram(second)]
  root.append(...nodes)
  const draw = makeMermaidDrawer({
    initialize: () => {},
    render: async (_id, source) => {
      if (source === "invalid") throw new SyntaxError("Invalid synthetic diagram")
      return { svg: "<svg viewBox=\"0 0 300 100\"></svg>", diagramType: "flowchart-v2" }
    }
  })
  const render = makeDiagramRenderer(root, { matches: false }, draw, { matches: false })
  await render()
  for (const [index, source] of [first, second].entries()) {
    const node = nodes[index]
    expect(node?.dataset.processed).toBe("true")
    expect(node?.querySelector("svg") !== null).toBe(source === "valid")
    if (source === "valid") expect(node?.dataset.diagramTheme).toBe("neutral")
  }
  expect(root.querySelectorAll("[role=\"alert\"]")).toHaveLength(first === "invalid" || second === "invalid" ? 1 : 0)
  await render()
  expect(root.querySelectorAll("[role=\"alert\"]")).toHaveLength(first === "invalid" || second === "invalid" ? 1 : 0)
})
