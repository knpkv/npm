import { describe, expect, it } from "@effect/vitest"
import { build } from "esbuild"

describe("shared fleet browser bundle", () => {
  it("bundles the real Approvals, Connect, and Work shell without Node modules", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [new URL("../src/approval-client.tsx", import.meta.url).pathname],
      format: "iife",
      metafile: true,
      platform: "browser",
      target: "es2022",
      write: false
    })
    const imports = Object.values(result.metafile.inputs).flatMap(({ imports }) => imports.map(({ path }) => path))
    expect(imports.filter((path) => path.startsWith("node:"))).toEqual([])
    const output = result.outputFiles.map(({ text }) => text).join("\n")
    expect(output).not.toContain("node:sqlite")
    expect(output).not.toContain("node:http")
  })

  it("retains the standalone Connect mount entry", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [new URL("../src/connect-entry.ts", import.meta.url).pathname],
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false
    })
    const output = result.outputFiles.map(({ text }) => text).join("\n")
    expect(output).toContain("fleet-connect-root")
    expect(output).not.toContain("node:sqlite")
    expect(output).not.toContain("node:http")
  })
})
