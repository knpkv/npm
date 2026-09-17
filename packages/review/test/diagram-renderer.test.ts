// @vitest-environment happy-dom
import { expect, it } from "vitest"
import { makeDiagramRenderer } from "../src/guide/diagram-renderer.js"

const diagram = (source: string) => {
  const node = document.createElement("pre")
  node.className = "mermaid"
  node.textContent = source
  return node
}

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
  })
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
