import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { componentManifest } from "../../component-manifest.js"

const root = fileURLToPath(new URL("../../", import.meta.url))
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8")

/** Class names a component asks for with a literal `style("name")`; dynamic lookups are not covered. */
const referencedClasses = (source: string): ReadonlyArray<string> =>
  [...new Set([...source.matchAll(/\bstyle\("([A-Za-z_][\w-]*)"\)/g)].map((match) => match[1] ?? ""))].filter(
    (name) => name.length > 0
  )

// `cssClass` throws at render when a class is missing from the module, but unit tests stub CSS
// modules, so a missing class only shows up as a crash in Storybook or the app.
describe("component stylesheets", () => {
  it("define every class their component references", () => {
    const missing = componentManifest.components.flatMap((component) => {
      if (component.styles.length === 0) return []
      const css = component.styles.map(read).join("\n")
      return referencedClasses(read(component.source))
        .filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css))
        .map((name) => `${component.name}: .${name}`)
    })
    expect(missing).toEqual([])
  })
})
