import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(join(import.meta.dirname, "../../src/patterns/RelayMark.module.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
)

/** Every `animation` or longhand declaration with the text before it, so its enclosing at-rules can be read back. */
const animations = [...css.matchAll(/(?<![-\w])animation(?:-[a-z-]+)?\s*:\s*([^;]+);/g)].map((match) => ({
  before: css.slice(0, match.index),
  declaration: match[0].slice(0, match[0].indexOf(":")).trim(),
  value: match[1] ?? ""
}))

/** The innermost `@media` prelude still open at a point in the sheet. */
const openMedia = (before: string): string | undefined => {
  const stack: Array<string> = []
  for (const token of before.matchAll(/([^{}]*)\{|\}/g)) {
    if (token[1] === undefined) stack.pop()
    else stack.push(token[1].trim())
  }
  return [...stack].reverse().find((prelude) => prelude.startsWith("@media"))
}

// Storybook and Playwright see a running animation; these keep the two opt-outs honest at the source.
describe("RelayMark motion CSS", () => {
  it("animates something", () => {
    expect(animations.length).toBeGreaterThanOrEqual(4)
  })

  it("moves only for a reader with no reduced-motion preference", () => {
    for (const { before } of animations) expect(openMedia(before)).toMatch(/prefers-reduced-motion:\s*no-preference/)
  })

  it("times every movement by a motion token, so the in-app reduced-motion setting stops it", () => {
    for (const { value } of animations.filter(({ declaration }) => /^animation(-duration)?$/.test(declaration))) {
      expect(value).toMatch(/var\(--rly-motion-[a-z]+-duration\)/)
      expect(value).not.toMatch(/\d(ms|s)\b/)
    }
  })
})
