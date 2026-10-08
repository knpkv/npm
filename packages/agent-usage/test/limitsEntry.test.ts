import { describe, expect, it } from "@effect/vitest"
import { build } from "esbuild"

// Connect bundles `@knpkv/agent-usage/limits` for the browser: the entry must not reach the server,
// the store or the filesystem the way the package root does.
describe("limits entry", () => {
  it("bundles for a browser without Node modules", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [new URL("../src/limits.ts", import.meta.url).pathname],
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
  })
})
