// @vitest-environment happy-dom

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RelayMark } from "../../src/patterns/RelayMark.js"
import { colorTokenSource } from "../../src/tokens/colors.js"

// The favicon is a static file a browser loads without rly's CSS, so it repeats the mark and the agent
// colour; this keeps both from drifting away from the component and the token.
describe("RelayMark favicon", () => {
  it("draws the same baton on the agent colour", () => {
    const favicon = readFileSync(join(import.meta.dirname, "../../src/assets/relay-mark.svg"), "utf8")
    const agent = colorTokenSource.find(({ name }) => name === "agent")
    expect(favicon).toContain(`fill="${agent?.light}"`)
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(createElement(RelayMark))
    const paths = [...host.querySelectorAll("path")].map((path) => path.getAttribute("d"))
    expect(paths).toHaveLength(3)
    for (const d of paths) expect(favicon).toContain(`d="${d}"`)
    expect(favicon).toContain("stroke-width=\"2.75\"")
  })
})
