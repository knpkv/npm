import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { readFileSync } from "node:fs"

const Manifest = Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Json) })

describe("published Connect styles", () => {
  it("loads the Rly base layer before the Connect layer", () => {
    const stylesheet = readFileSync(
      new URL("../src/styles.css", import.meta.url),
      "utf8"
    )
    expect(stylesheet.startsWith("@import \"@knpkv/rly/styles.css\";")).toBe(
      true
    )
    expect(stylesheet.indexOf("@import")).toBeLessThan(
      stylesheet.indexOf("@layer connect")
    )
  })

  it("exports the embeddable surface separately from the mounting entry", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)(
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    )
    expect(Object.keys(manifest.exports)).toContain("./surface")
    expect(Object.keys(manifest.exports)).toContain("./client")
  })
})
