import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import postcss, { type Rule } from "postcss"
import { describe, expect, it } from "vitest"
import { componentManifest } from "../../component-manifest.js"

const root = fileURLToPath(new URL("../../", import.meta.url))
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8")

const subjectClass = (selector: string): string | undefined =>
  [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]).at(-1)

/** Classes that declare a size container, and @container rules whose subject is one of them. */
const selfQueries = (css: string): ReadonlyArray<string> => {
  const containers = new Set<string>()
  const queried: Array<Rule> = []
  postcss.parse(css).walkRules((rule) => {
    if (rule.nodes.some((node) => node.type === "decl" && node.prop === "container-type")) {
      for (const selector of rule.selectors) {
        const name = subjectClass(selector)
        if (name !== undefined) containers.add(name)
      }
    }
    for (let node = rule.parent; node !== undefined && node.type !== "root"; node = node.parent) {
      if (node.type === "atrule" && node.name === "container") queried.push(rule)
    }
  })
  return queried.flatMap((rule) =>
    rule.selectors.flatMap((selector) => {
      const name = subjectClass(selector)
      return name !== undefined && containers.has(name) ? [`.${name}`] : []
    })
  )
}

const storyFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(`${root}${dir}`, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? storyFiles(`${dir}/${entry.name}`)
      : entry.name.endsWith(".stories.tsx")
      ? [`${dir}/${entry.name}`]
      : []
  )

describe("layout guardrails", () => {
  // An element cannot query its own size: a rule on the container inside its own @container block
  // never applies (DiffHeader's narrow layout never stacked, so its count ran over the title).
  it("never styles a container from inside its own container query", () => {
    const offenders = componentManifest.components.flatMap((component) =>
      component.styles.flatMap((path) => selfQueries(read(path)).map((name) => `${path}: ${name}`))
    )
    expect(offenders).toEqual([])
    expect(selfQueries(".root { container-type: inline-size } @container (max-width: 10rem) { .root { gap: 0 } }"))
      .toEqual([
        ".root"
      ])
    expect(selfQueries(".root { container-type: inline-size } @container (max-width: 10rem) { .child { gap: 0 } }"))
      .toEqual([])
  })

  // pageStyle pads by viewport width, so narrowing it squeezes the slot to a sliver on a wide
  // viewport (a 320px canary rendered 135px at 1280). Narrow an inner wrapper instead.
  it("never narrows the padded page wrapper in a story", () => {
    // A style object that keeps pageStyle's padding but narrows it; one that sets its own fixed
    // padding (a deliberate phone frame) is fine.
    const narrowed = (source: string): boolean =>
      [...source.matchAll(/\{[^{}]*\.\.\.pageStyle,[^{}]*\}/g)].some(
        ([object]) => /maxInlineSize|maxWidth|\.\.\.\w*(narrow|compact)\w*/i.test(object) && !/padding:/.test(object)
      )
    const offenders = storyFiles("stories").filter((path) => narrowed(read(path)))
    expect(offenders).toEqual([])
    expect(narrowed("style={{ ...pageStyle, maxInlineSize: \"20rem\" }}")).toBe(true)
    expect(narrowed("style={{ ...pageStyle, ...narrowStyle }}")).toBe(true)
    expect(narrowed("style={{ display: \"grid\", ...narrowStyle }}")).toBe(false)
    expect(narrowed("const frame = { ...pageStyle, maxWidth: \"24.5rem\", padding: \"var(--rly-space-16)\" }")).toBe(
      false
    )
  })
})
