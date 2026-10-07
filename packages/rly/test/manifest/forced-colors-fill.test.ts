import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import postcss, { type AtRule, type Rule } from "postcss"
import { describe, expect, it } from "vitest"
import { componentManifest } from "../../component-manifest.js"

const root = fileURLToPath(new URL("../../", import.meta.url))
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8")

const TOOLBAR = "[data-rly-forced-colors=\"active\"]"

const classesOf = (selector: string): ReadonlyArray<string> =>
  [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1] ?? "")

const insideForcedColorsMedia = (rule: Rule): boolean => {
  for (let node = rule.parent; node !== undefined && node.type !== "root"; node = node.parent) {
    if (node.type === "atrule") {
      const at: AtRule = node
      if (at.name === "media" && at.params.includes("forced-colors: active")) return true
    }
  }
  return false
}

const optsOut = (rule: Rule): boolean =>
  rule.nodes.some((node) => node.type === "decl" && node.prop === "forced-color-adjust" && node.value === "none")

/** The classes a rule fills with the action background, outside any forced-colours override. */
const actionFilled = (rule: Rule): ReadonlyArray<string> =>
  !insideForcedColorsMedia(rule) &&
    !rule.selector.includes(TOOLBAR) &&
    rule.nodes.some(
      (node) =>
        node.type === "decl" && node.prop === "background" && node.value === "var(--rly-color-action-background)"
    )
    ? rule.selectors.flatMap((selector) => classesOf(selector).slice(-1))
    : []

/**
 * Classes whose override opts out of adjustment. `inMedia` selects the real media query; otherwise
 * the Storybook toolbar attribute.
 */
const optedOut = (rules: ReadonlyArray<Rule>, inMedia: boolean): ReadonlySet<string> =>
  new Set(
    rules
      .filter((rule) => optsOut(rule) && (inMedia ? insideForcedColorsMedia(rule) : rule.selector.includes(TOOLBAR)))
      .flatMap((rule) => rule.selectors.flatMap((selector) => classesOf(selector)))
  )

// Chromium paints a Canvas backplate behind text that still gets forced-colour adjustment, which hides
// the label of a filled control whatever system colours the fill and label use (found by ui2-b on the
// Approvals countdown's Approve button). Every action-filled class therefore opts out, under the real
// media query and under the Storybook toolbar attribute alike.
describe("action-filled controls in forced colours", () => {
  it("opt out of forced colour adjustment, so the browser's backplate cannot hide their label", () => {
    const missing = componentManifest.components.flatMap((component) => {
      const rules: Array<Rule> = []
      for (const path of component.styles) postcss.parse(read(path)).walkRules((rule) => void rules.push(rule))
      const media = optedOut(rules, true)
      const toolbar = optedOut(rules, false)
      return [...new Set(rules.flatMap(actionFilled))].flatMap((name) => [
        ...(media.has(name) ? [] : [`${component.name}: .${name} (@media forced-colors)`]),
        ...(toolbar.has(name) ? [] : [`${component.name}: .${name} (toolbar attribute)`])
      ])
    })
    expect(missing).toEqual([])
  })

  it("flags an action fill that does not opt out", () => {
    const rules: Array<Rule> = []
    postcss
      .parse(".primary { background: var(--rly-color-action-background); }")
      .walkRules((rule) => void rules.push(rule))
    expect(rules.flatMap(actionFilled)).toEqual(["primary"])
    expect(optedOut(rules, true).has("primary")).toBe(false)
  })
})
