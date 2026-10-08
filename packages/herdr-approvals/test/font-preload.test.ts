import { describe, expect, it } from "@effect/vitest"
import { RLY_FONT_FACES } from "@knpkv/rly/tokens"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fontPreloadLink, PRELOADED_FONTS } from "../src/font-preload.js"

const link = (font: string) => `<link rel="preload" href="/assets/${font}" as="font" type="font/woff2" crossorigin>\n`

describe("approval pages preload Geist", () => {
  it("preloads both Geist faces the host serves, UI and mono", () => {
    const fonts = new Map(PRELOADED_FONTS.map((font, index) => [font, new Uint8Array([index])]))
    expect(fontPreloadLink(fonts)).toBe(PRELOADED_FONTS.map(link).join(""))
    expect(fontPreloadLink(fonts)).toContain("geist-mono-latin-wght-normal.woff2")
  })

  it("preloads only the faces the host serves", () => {
    const ui = RLY_FONT_FACES[0].file
    expect(fontPreloadLink(new Map([[ui, new Uint8Array([1])]]))).toBe(link(ui))
  })

  it("names no file the host would 404", () => {
    expect(fontPreloadLink(new Map([["test.woff2", new Uint8Array([1])]]))).toBe("")
  })

  // The names must match what rly's fonts.css references, since esbuild keeps them (`assetNames: "[name]"`).
  it("preloads every face rly's styles load", () => {
    const fonts = readFileSync(join(import.meta.dirname, "../../rly/src/styles/fonts.css"), "utf8")
    const loaded = [...fonts.matchAll(/url\("[^"]*\/([^"/]+\.woff2)"\)/g)].map(([, file]) => file)
    expect([...loaded].sort()).toEqual([...PRELOADED_FONTS].sort())
  })
})
