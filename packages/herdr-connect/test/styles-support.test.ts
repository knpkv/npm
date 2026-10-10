/** Connect's stylesheet must work in every browser BROWSER_TARGET names; layout must not lean on newer CSS. */
import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

describe("Connect stylesheet support", () => {
  // :has() shipped in Firefox 121 and BROWSER_TARGET includes Firefox 120: a :has() rule there silently does
  // nothing (the floating pin then covered the last row). Set a data attribute from React instead.
  it("uses no :has() selector", () => {
    expect([...css.matchAll(/:has\(/g)]).toHaveLength(0)
  })
})
