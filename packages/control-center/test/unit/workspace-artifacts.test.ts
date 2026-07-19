import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { expect } from "vitest"
import {
  ensureWorkspaceArtifactContracts,
  packagesMissingPublishedArtifacts,
  publishedArtifactPaths
} from "../../scripts/workspace-artifacts.js"

describe("workspace package artifacts", () => {
  it("collects concrete package entry files and ignores wildcard templates", () => {
    expect(
      publishedArtifactPaths({
        bin: { tool: "./dist/bin.js" },
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
          "./styles.css": "./dist/styles.css",
          "./*.js": "./src/*.ts"
        },
        main: "./dist/index.js",
        name: "@example/package",
        types: "./dist/index.d.ts"
      })
    ).toEqual(["dist/bin.js", "dist/index.d.ts", "dist/index.js", "dist/styles.css"])
  })

  it("builds only packages whose declared entry artifacts are missing", () => {
    const existing = new Set(["/workspace/ready/dist/index.js", "/workspace/ready/dist/index.d.ts"])
    const missing = packagesMissingPublishedArtifacts(
      [
        {
          artifactPaths: ["dist/index.js", "dist/index.d.ts"],
          name: "@example/ready",
          packageRoot: "/workspace/ready"
        },
        {
          artifactPaths: ["dist/index.js", "dist/index.d.ts"],
          name: "@example/missing",
          packageRoot: "/workspace/missing"
        },
        { artifactPaths: [], name: "@example/source", packageRoot: "/workspace/source" }
      ],
      (path) => existing.has(path),
      (root, artifact) => `${root}/${artifact}`
    )

    expect(missing).toEqual(["@example/missing"])
  })

  it.effect("fails when a successful dependency build leaves an advertised artifact missing", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-missing-artifact-"
      })
      const contracts = [
        {
          artifactPaths: ["dist/index.js"],
          name: "@example/missing",
          packageRoot
        }
      ]

      const error = yield* ensureWorkspaceArtifactContracts(contracts, () => Effect.void).pipe(
        Effect.flip
      )

      assert.strictEqual(error._tag, "WorkspaceArtifactError")
      assert.strictEqual(
        error.reason,
        "dependency build completed successfully but advertised artifacts are still missing for: @example/missing"
      )
      assert.strictEqual(yield* fileSystem.exists(path.join(packageRoot, "dist", "index.js")), false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("accepts a successful dependency build that creates every advertised artifact", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-built-artifact-"
      })
      const artifactDirectory = path.join(packageRoot, "dist")
      const artifactPath = path.join(artifactDirectory, "index.js")
      const contracts = [
        {
          artifactPaths: ["dist/index.js"],
          name: "@example/built",
          packageRoot
        }
      ]
      const buildMissing = Effect.fn("test.buildMissingWorkspaceArtifacts")(function*(
        missingPackages: ReadonlyArray<string>
      ) {
        assert.deepStrictEqual(missingPackages, ["@example/built"])
        yield* fileSystem.makeDirectory(artifactDirectory, { recursive: true })
        yield* fileSystem.writeFileString(artifactPath, "export {}\n")
      }, Effect.orDie)

      const builtPackages = yield* ensureWorkspaceArtifactContracts(contracts, buildMissing)

      assert.deepStrictEqual(builtPackages, ["@example/built"])
      assert.strictEqual(yield* fileSystem.exists(artifactPath), true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
