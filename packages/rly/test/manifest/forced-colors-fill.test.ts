import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { componentManifest } from "../../component-manifest.js"

const root = fileURLToPath(new URL("../../", import.meta.url))
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8")

/** Class selectors whose own rule fills with the action background (pseudo-elements carry no text). */
const actionFilled = (css: string): ReadonlyArray<string> =>
  [...css.matchAll(/(^|\n)\s*\.([A-Za-z_][\w-]*)\s*\{[^}]*background:\s*var\(--rly-color-action-background\)/g)].map(
    (match) => match[2] ?? ""
  )

const optsOutInMedia = (css: string, name: string): boolean =>
  new RegExp(`@media \\(forced-colors: active\\)\\s*\\{[^@]*\\.${name}\\s*\\{[^}]*forced-color-adjust:\\s*none`).test(
    css
  )

const optsOutUnderToolbar = (css: string, name: string): boolean =>
  new RegExp(
    `:where\\(\\[data-forced-colors="active"\\], \\[data-rly-forced-colors="active"\\]\\) \\.${name}\\s*\\{[^}]*forced-color-adjust:\\s*none`
  ).test(css)

// In forced colours the action fill is ButtonText and its label ButtonFace. Chromium paints a Canvas
// backplate behind adjusted text, which hides a ButtonFace label on that fill (the Approve button in
// the Approvals countdown rendered as a solid block). Every action-filled control keeps its own
// system colours unadjusted, under the real media query and the Storybook toolbar attribute alike.
describe("action-filled controls in forced colours", () => {
  it("opt out of forced colour adjustment, so the browser's backplate cannot hide their label", () => {
    const missing = componentManifest.components.flatMap((component) => {
      const css = component.styles.map(read).join("\n")
      return actionFilled(css).flatMap((name) => [
        ...(optsOutInMedia(css, name) ? [] : [`${component.name}: .${name} (@media forced-colors)`]),
        ...(optsOutUnderToolbar(css, name) ? [] : [`${component.name}: .${name} (toolbar attribute)`])
      ])
    })
    expect(missing).toEqual([])
  })
})
