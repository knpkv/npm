import { describe, expect, it } from "vitest"
import { findProjectDeclarationShims } from "../../scripts/source-contract.js"

describe("source contract", () => {
  it("rejects project-owned declaration shims", () => {
    expect(findProjectDeclarationShims([
      "src/css-modules.d.ts",
      "src/environment.d.mts",
      "test/browser.shims.d.ts",
      "vitest.shims.d.cts"
    ])).toEqual([
      "src/css-modules.d.ts",
      "src/environment.d.mts",
      "test/browser.shims.d.ts",
      "vitest.shims.d.cts"
    ])
  })

  it("allows compiler output, dependencies, and generated declarations", () => {
    expect(findProjectDeclarationShims([
      "dist/dts/index.d.ts",
      "generated/schema.d.ts",
      "src/generated/schema.d.ts",
      "node_modules/library/index.d.ts",
      "src/Button.tsx"
    ])).toEqual([])
  })
})
