import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  findFontAsset,
  type FontBundle,
  fontPreloadTags,
  RLY_PRELOADED_FONTS,
  RlyFontPreloadMissingError
} from "../../../vite-font-preload.ts"

const repoRoot = join(import.meta.dirname, "../../..")
const bundle = (...assets: ReadonlyArray<readonly [fileName: string, name: string]>): FontBundle =>
  Object.fromEntries(assets.map(([fileName, name]) => [fileName, { fileName, names: [name], type: "asset" }]))

/**
 * Packages whose built client imports rly's styles but needs no preload. herdr-monitor inlines its
 * assets (`assetsInlineLimit: 100000`), so Geist arrives inside board.css.
 */
const INLINED_FONTS = new Set(["herdr-monitor"])

const [UI_FONT, MONO_FONT] = RLY_PRELOADED_FONTS
const bothFaces = bundle(
  ["assets/geist-mono-latin-wght-normal-X.woff2", "geist-mono-latin-wght-normal.woff2"],
  ["assets/geist-latin-wght-normal-Bg.woff2", "geist-latin-wght-normal.woff2"]
)

describe("rly font preload", () => {
  it("finds the hashed asset built from each Geist face and ignores other fonts", () => {
    expect(findFontAsset(bothFaces, UI_FONT)).toBe("assets/geist-latin-wght-normal-Bg.woff2")
    expect(findFontAsset(bothFaces, MONO_FONT)).toBe("assets/geist-mono-latin-wght-normal-X.woff2")
    expect(findFontAsset(bundle(["assets/other.woff2", "other.woff2"]), UI_FONT)).toBeUndefined()
  })

  it("preloads both exact files under the configured base, UI and mono", () => {
    const preload = (href: string) => ({
      attrs: { as: "font", crossorigin: "", href, rel: "preload", type: "font/woff2" },
      injectTo: "head-prepend",
      tag: "link"
    })
    expect(fontPreloadTags(bothFaces, "/app/", "/index.html")).toEqual([
      preload("/app/assets/geist-latin-wght-normal-Bg.woff2"),
      preload("/app/assets/geist-mono-latin-wght-normal-X.woff2")
    ])
  })

  it("fails the build when either Geist face was not emitted", () => {
    expect(() => fontPreloadTags(bundle(), "/", "/index.html")).toThrow(RlyFontPreloadMissingError)
    const uiOnly = bundle(["assets/geist-latin-wght-normal-Bg.woff2", UI_FONT])
    expect(() => fontPreloadTags(uiOnly, "/", "/index.html")).toThrow(RlyFontPreloadMissingError)
  })

  // Guardrail: a face rly loads but no shell preloads swaps in late and re-wraps text.
  it("preloads every face styles.css loads", () => {
    const fonts = readFileSync(join(repoRoot, "packages/rly/src/styles/fonts.css"), "utf8")
    const loaded = [...fonts.matchAll(/url\("[^"]*\/([^"/]+\.woff2)"\)/g)].map(([, file]) => file)
    expect(loaded.toSorted()).toEqual([...RLY_PRELOADED_FONTS].toSorted())
  })

  // Guardrail: a Vite shell that loads rly styles without the plugin paints its first text in the fallback.
  it("is used by every Vite shell that loads rly styles", () => {
    const missing = readdirSync(join(repoRoot, "packages")).filter((name) => {
      const config = join(repoRoot, "packages", name, "vite.config.ts")
      if (INLINED_FONTS.has(name) || !existsSync(config)) return false
      const manifest = join(repoRoot, "packages", name, "package.json")
      const dependsOnRly = existsSync(manifest) && readFileSync(manifest, "utf8").includes("\"@knpkv/rly\"")
      const hasShell = existsSync(join(repoRoot, "packages", name, "index.html")) ||
        existsSync(join(repoRoot, "packages", name, "src/client/index.html"))
      return name !== "rly" && dependsOnRly && hasShell && !readFileSync(config, "utf8").includes("rlyFontPreload()")
    })
    expect(missing).toEqual([])
  })

  it("keeps the inlined-font exemption true", () => {
    for (const name of INLINED_FONTS) {
      expect(readFileSync(join(repoRoot, "packages", name, "vite.config.ts"), "utf8")).toMatch(
        /assetsInlineLimit: 100000/
      )
    }
  })
})
