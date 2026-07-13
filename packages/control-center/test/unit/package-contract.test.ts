import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
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

  it("keeps the checked-in first-release manifest at 0.0.0", async () => {
    const version = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
        const source = yield* fs.readFileString(path.join(packageRoot, "package.json"))
        const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(
          source
        )
        if (Result.isFailure(decoded)) return yield* Effect.die("package.json version could not be decoded")
        return decoded.success.version
      }).pipe(Effect.provide(NodeServices.layer))
    )
    expect(version).toBe("0.0.0")
  })

  it("accepts the changeset-produced 0.1.0 version", () => {
    expect(inspectPackageContract({ ...validManifest, version: "0.1.0" })).toEqual([])
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
