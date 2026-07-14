import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { inspectPackageContract } from "../../scripts/package-contract.js"

const validManifest = {
  bin: { "control-center": "./dist/server/server/cli.js" },
  dependencies: {
    "@effect/platform-node": "4.0.0-beta.97",
    "@effect/sql-libsql": "4.0.0-beta.97",
    "@knpkv/rly": "workspace:^",
    effect: "4.0.0-beta.97",
    react: "^19.2.7",
    "react-dom": "^19.2.7",
    "react-router": "^8.2.0"
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
  scripts: { start: "node ./dist/server/server/cli.js" },
  types: "./dist/server/index.d.ts",
  version: "0.0.0"
}

describe("package contract", () => {
  it("accepts the reviewed T01 manifest surface", () => {
    expect(inspectPackageContract(validManifest)).toEqual([])
  })

  it.effect("keeps the checked-in manifest compatible with release versioning", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
      const source = yield* fs.readFileString(path.join(packageRoot, "package.json"))
      const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(source)
      if (Result.isFailure(decoded)) return yield* Effect.die("package.json version could not be decoded")
      expect(inspectPackageContract(decoded.success)).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it("accepts the changeset-produced 0.1.0 version", () => {
    expect(inspectPackageContract({ ...validManifest, version: "0.1.0" })).toEqual([])
  })

  it("rejects a version that is not semantic versioning", () => {
    expect(inspectPackageContract({ ...validManifest, version: "next" })).toEqual([
      "package manifest does not match its required structure"
    ])
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
        "runtime dependencies must remain the reviewed set",
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

  it("rejects a CLI that bypasses the built server boundary", () => {
    expect(
      inspectPackageContract({
        ...validManifest,
        bin: { "control-center": "./src/server/cli.ts" }
      })
    ).toContain("control-center bin must reference the built server CLI")
  })

  it("rejects a start script that consumes or drops recovery arguments", () => {
    expect(
      inspectPackageContract({
        ...validManifest,
        scripts: { start: "node ./dist/server/server/cli.js serve" }
      })
    ).toContain("start must forward arguments to the built server CLI")
  })

  it("rejects a libSQL adapter from a different Effect release", () => {
    expect(
      inspectPackageContract({
        ...validManifest,
        dependencies: { ...validManifest.dependencies, "@effect/sql-libsql": "4.0.0-beta.98" }
      })
    ).toContain("@effect/sql-libsql must align with the pinned Effect beta")
  })
})
