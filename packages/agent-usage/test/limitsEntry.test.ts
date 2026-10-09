import { describe, expect, it } from "@effect/vitest"
import { build } from "esbuild"
import packageJson from "../package.json" with { type: "json" }

// Connect bundles `@knpkv/agent-usage/limits` and the herdr hub `@knpkv/agent-usage/usage` for the
// browser: neither entry may reach the server, the store or the filesystem the way the package root does.
const entries: ReadonlyArray<{
  readonly name: "./limits" | "./usage"
  readonly source: string
  readonly published: string
}> = [
  { name: "./limits", source: "../src/limits/index.ts", published: "./dist/limits/index.js" },
  { name: "./usage", source: "../src/usage/index.ts", published: "./dist/usage/index.js" }
]

describe.each(entries)("$name entry", ({ name, published, source }) => {
  it("bundles for a browser without Node modules", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [new URL(source, import.meta.url).pathname],
      format: "esm",
      jsx: "automatic",
      metafile: true,
      platform: "browser",
      target: "es2022",
      write: false
    })
    const imports = Object.values(result.metafile.inputs).flatMap(({ imports }) => imports.map(({ path }) => path))
    expect(imports.filter((path) => path.startsWith("node:"))).toEqual([])
    const sources = Object.keys(result.metafile.inputs)
    expect(sources.filter((path) => /agent-usage\/src\/(server|core\/(Store|Database|Ingest))/.test(path))).toEqual([])
    // tsc emits src/client/* to dist/client, which `vite build` then empties for the page: a module
    // the published entry reaches there is missing from dist (#704's CI). Keep the whole graph out.
    expect(sources.filter((path) => /agent-usage\/src\/client\//.test(path))).toEqual([])
  })

  it("publishes the entry outside the directory the page build empties", () => {
    const entry = packageJson.exports[name].default
    expect(entry).toBe(published)
    expect(entry.startsWith("./dist/client/")).toBe(false)
    expect(packageJson.publishConfig.exports[name].default).toBe(published)
  })
})
