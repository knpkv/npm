import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  findFontAsset,
  type FontBundle,
  fontPreloadTags,
  RLY_PRELOADED_FONT,
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

describe("rly font preload", () => {
  it("finds the hashed asset built from Geist and ignores other fonts", () => {
    const assets = bundle(
      ["assets/geist-mono-latin-wght-normal-X.woff2", "geist-mono-latin-wght-normal.woff2"],
      ["assets/geist-latin-wght-normal-Bg.woff2", RLY_PRELOADED_FONT]
    )
    expect(findFontAsset(assets, RLY_PRELOADED_FONT)).toBe("assets/geist-latin-wght-normal-Bg.woff2")
    expect(findFontAsset(bundle(["assets/other.woff2", "other.woff2"]), RLY_PRELOADED_FONT)).toBeUndefined()
  })

  it("preloads that exact file under the configured base", () => {
    const assets = bundle(["assets/geist-latin-wght-normal-Bg.woff2", RLY_PRELOADED_FONT])
    expect(fontPreloadTags(assets, "/app/", "/index.html")).toEqual([{
      attrs: {
        as: "font",
        crossorigin: "",
        href: "/app/assets/geist-latin-wght-normal-Bg.woff2",
        rel: "preload",
        type: "font/woff2"
      },
      injectTo: "head-prepend",
      tag: "link"
    }])
  })

  it("fails the build when no Geist asset was emitted", () => {
    expect(() => fontPreloadTags(bundle(), "/", "/index.html")).toThrow(RlyFontPreloadMissingError)
  })

  it("is the font styles.css loads", () => {
    const fonts = readFileSync(join(repoRoot, "packages/rly/src/styles/fonts.css"), "utf8")
    expect(fonts).toContain(`/${RLY_PRELOADED_FONT}")`)
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
