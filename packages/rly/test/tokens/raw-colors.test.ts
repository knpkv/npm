import { describe, expect, it } from "vitest"
import { findColorPolicyViolations } from "../../scripts/tokens/raw-colors.js"

const rules = (path: string, source: string): ReadonlyArray<string> =>
  findColorPolicyViolations(path, source).map(({ rule }) => rule)

describe("component color policy", () => {
  it("rejects raw CSS colors, primitive palettes, and local theme overrides", () => {
    expect(rules(
      "src/primitives/Button.css",
      `
      .a { color: #fff; background: rgb(1 2 3); border: var(--rly-palette-blue-5); }
      [data-theme="dark"] .a { color-scheme: dark; }
      @media (prefers-color-scheme: dark) { .a { display: block; } }
    `
    )).toEqual([
      "raw-color",
      "raw-color",
      "primitive-palette",
      "local-theme",
      "local-theme",
      "local-theme"
    ])
  })

  it("permits semantic CSS, system-safe values, URL fragments, and comments", () => {
    expect(rules(
      "src/primitives/Icon.css",
      `
      /* #fff and rgb(1 2 3) are documentation, not declarations. */
      .icon { color: var(--rly-color-text-1); fill: currentColor; background: transparent; mask: url("#face"); }
    `
    )).toEqual([])
  })

  it("rejects color literals in typed inline-style contexts", () => {
    expect(rules(
      "src/primitives/Button.tsx",
      `
      const focusColor = "oklch(60% .2 250)"
      export const Demo = () => <svg fill="#fff" style={{ backgroundColor: "hsl(0 0% 0%)" }} />
    `
    )).toEqual(["raw-color", "raw-color", "raw-color"])
  })

  it("rejects raw colors nested inside conditional style expressions", () => {
    expect(rules(
      "src/primitives/Button.tsx",
      `
      export const Button = ({ dark }: { readonly dark: boolean }) => (
        <button style={{ color: dark ? "#fff" : "#000" }}>Ship</button>
      )
    `
    )).toEqual(["raw-color", "raw-color"])
  })

  it("does not flag prose, imports, or non-color URL attributes", () => {
    expect(rules(
      "src/primitives/Note.tsx",
      `
      import value from "#fixture"
      const message = "The old example used #fff and rgb(1 2 3)."
      export const Note = () => <a href="#face">{message}{value}</a>
    `
    )).toEqual([])
  })
})
