import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fontPreloadLink, PRELOADED_FONT } from "../src/font-preload.js"

describe("approval pages preload Geist", () => {
  it("preloads the Geist file the host serves from /assets", () => {
    const fonts = new Map([[PRELOADED_FONT, new Uint8Array([1])], [
      "geist-mono-latin-wght-normal.woff2",
      new Uint8Array([2])
    ]])
    expect(fontPreloadLink(fonts)).toBe(
      `<link rel="preload" href="/assets/${PRELOADED_FONT}" as="font" type="font/woff2" crossorigin>\n`
    )
  })

  it("names no file the host would 404", () => {
    expect(fontPreloadLink(new Map([["test.woff2", new Uint8Array([1])]]))).toBe("")
  })

  // The name must match what rly's fonts.css references, since esbuild keeps it (`assetNames: "[name]"`).
  it("preloads the file rly's styles load", () => {
    const fonts = readFileSync(join(import.meta.dirname, "../../rly/src/styles/fonts.css"), "utf8")
    expect(fonts).toContain(`/${PRELOADED_FONT}")`)
  })
})
