import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { RLY_FONT_FACES } from "../../src/tokens/fonts.js"

const css = readFileSync(join(import.meta.dirname, "../../src/styles/fonts.css"), "utf8")
/** The @font-face rules that load a file, as opposed to the local() fallbacks. */
const webFaces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)]
  .map(([, body = ""]) => body)
  .filter((body) => /url\(/.test(body))

// Shells preload exactly this list; a face missing from it would load late and, being optional,
// never render on first visit.
describe("RLY_FONT_FACES", () => {
  it("names every web font fonts.css loads, by family and file", () => {
    const loaded = webFaces.map((body) => ({
      family: /font-family:\s*"([^"]+)"/.exec(body)?.[1],
      file: /url\("[^"]*\/([^/"]+\.woff2)"\)/.exec(body)?.[1]
    }))
    expect(loaded).toEqual(RLY_FONT_FACES.map(({ family, file }) => ({ family, file })))
  })

  it("loads every web font with font-display: optional, so a late face never swaps", () => {
    expect(webFaces.length).toBeGreaterThan(0)
    for (const body of webFaces) expect(body).toMatch(/font-display:\s*optional;/)
  })
})
