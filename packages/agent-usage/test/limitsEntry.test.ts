import { describe, expect, it } from "@effect/vitest"
import { build } from "esbuild"
import packageJson from "../package.json" with { type: "json" }

// Connect bundles `@knpkv/agent-usage/limits` for the browser: the entry must not reach the server,
// the store or the filesystem the way the package root does.
describe("limits entry", () => {
  it("bundles for a browser without Node modules", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [new URL("../src/limits/index.ts", import.meta.url).pathname],
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
    const entry = packageJson.exports["./limits"].default
    expect(entry).toBe("./dist/limits/index.js")
    expect(entry.startsWith("./dist/client/")).toBe(false)
  })
})
