/** An undefined custom property silently falls back, so every Rly token Connect uses must exist. */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const tokens = (css: string): Set<string> =>
  new Set([...css.matchAll(/(--rly-[a-z0-9-]+)\s*:/g)].map((match) => match[1] ?? ""))
/** Rly's stylesheet is an import list; read each imported file beside it. */
const rlyStyles = (): string => {
  const entry = require.resolve("@knpkv/rly/styles.css")
  const css = readFileSync(entry, "utf8")
  const imported = [...css.matchAll(/@import\s+"([^"]+)"/g)]
    .map((match) => join(dirname(entry), match[1] ?? ""))
    .filter(existsSync)
    .map((file) => readFileSync(file, "utf8"))
  return [css, ...imported].join("\n")
}
const references = (css: string): Set<string> =>
  new Set([...css.matchAll(/var\((--rly-[a-z0-9-]+)/g)].map((match) => match[1] ?? ""))

describe("Connect stylesheet", () => {
  it("only references Rly tokens that Rly defines", () => {
    const defined = tokens(rlyStyles())
    const used = references(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"))
    expect([...used].filter((token) => !defined.has(token))).toEqual([])
  })
})
