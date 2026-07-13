import { describe, expect, it } from "vitest"
import { inspectPackageContract } from "../../scripts/package-contract.js"

const validManifest = {
  dependencies: {
    "@knpkv/rly": "workspace:^",
    react: "^19.2.7",
    "react-dom": "^19.2.7"
  },
  engines: { node: ">=24" },
  exports: {
    ".": { import: "./dist/server/index.js", types: "./dist/server/index.d.ts" },
    "./api": { import: "./dist/server/api/index.js", types: "./dist/server/api/index.d.ts" },
    "./domain": { import: "./dist/server/domain/index.js", types: "./dist/server/domain/index.d.ts" },
    "./server": { import: "./dist/server/server/index.js", types: "./dist/server/server/index.d.ts" }
  },
  main: "./dist/server/index.js",
  name: "@knpkv/control-center",
  types: "./dist/server/index.d.ts",
  version: "0.0.0"
}

describe("package contract", () => {
  it("accepts the reviewed T01 manifest surface", () => {
    expect(inspectPackageContract(validManifest)).toEqual([])
  })

  it("rejects copied dependencies and accidental browser/server exports", () => {
    expect(
      inspectPackageContract({
        ...validManifest,
        dependencies: { ...validManifest.dependencies, "@knpkv/codecommit-web": "workspace:^" },
        exports: { ...validManifest.exports, "./client": "./dist/client/index.js" }
      })
    ).toEqual(
      expect.arrayContaining([
        "T01 runtime dependencies must remain the reviewed minimal set",
        "package exports must contain only ., ./api, ./domain, ./server"
      ])
    )
  })

  it("rejects a non-workspace rly dependency", () => {
    expect(
      inspectPackageContract({
        ...validManifest,
        dependencies: { ...validManifest.dependencies, "@knpkv/rly": "^0.1.0" }
      })
    ).toContain("@knpkv/rly must use workspace:^")
  })
})
