import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { expect } from "vitest"
import {
  clearWorkspaceIncrementalBuildState,
  ensureWorkspaceArtifactContracts,
  packagesMissingPublishedArtifacts,
  packagesRequiringPublishedArtifactBuild,
  publishedArtifactPaths,
  resolveWorkspaceArtifactFingerprints,
  WorkspaceArtifactError,
  workspaceArtifactInputFingerprint
} from "../../scripts/workspace-artifacts.js"

const contract = (
  packageRoot: string,
  name: string,
  artifactPaths: ReadonlyArray<string> = ["dist/index.js"]
) => ({
  artifactPaths,
  fingerprintPath: `${packageRoot}/node_modules/.cache/control-center-workspace-artifact.sha256`,
  inputFingerprint: "current-fingerprint",
  name,
  packageRoot
})

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
        contract("/workspace/ready", "@example/ready", ["dist/index.js", "dist/index.d.ts"]),
        contract("/workspace/missing", "@example/missing", ["dist/index.js", "dist/index.d.ts"]),
        contract("/workspace/source", "@example/source", [])
      ],
      (path) => existing.has(path),
      (root, artifact) => `${root}/${artifact}`
    )

    expect(missing).toEqual(["@example/missing"])
  })

  it("rebuilds stale source fingerprints while skipping matching published output", () => {
    const ready = contract("/workspace/ready", "@example/ready")
    const stale = contract("/workspace/stale", "@example/stale")
    const existing = new Set(["/workspace/ready/dist/index.js", "/workspace/stale/dist/index.js"])
    const fingerprints = new Map([
      [ready.fingerprintPath, ready.inputFingerprint],
      [stale.fingerprintPath, "previous-fingerprint"]
    ])

    expect(
      packagesRequiringPublishedArtifactBuild(
        [ready, stale],
        (candidate) => existing.has(candidate),
        (candidate) => fingerprints.get(candidate),
        (root, artifact) => `${root}/${artifact}`
      )
    ).toEqual(["@example/stale"])
  })

  it.effect("clears stale TypeScript state before repairing missing output", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-stale-build-state-"
      })
      const cacheRoot = path.join(packageRoot, "node_modules", ".cache")
      const rootBuildInfo = path.join(packageRoot, "tsconfig.tsbuildinfo")
      const cachedBuildInfo = path.join(cacheRoot, "tsconfig.build.tsbuildinfo")
      const sourceMarker = path.join(packageRoot, "src", "index.ts")
      yield* fileSystem.makeDirectory(cacheRoot, { recursive: true })
      yield* fileSystem.makeDirectory(path.dirname(sourceMarker), { recursive: true })
      yield* fileSystem.writeFileString(rootBuildInfo, "stale")
      yield* fileSystem.writeFileString(cachedBuildInfo, "stale")
      yield* fileSystem.writeFileString(sourceMarker, "export {}\n")

      yield* clearWorkspaceIncrementalBuildState([packageRoot])

      assert.strictEqual(yield* fileSystem.exists(rootBuildInfo), false)
      assert.strictEqual(yield* fileSystem.exists(cachedBuildInfo), false)
      assert.strictEqual(yield* fileSystem.exists(sourceMarker), true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("changes the dependency fingerprint for every local build input, but not tests or docs", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-artifact-fingerprint-"
      })
      const packageRoot = path.join(workspaceRoot, "packages", "example")
      const sourcePath = path.join(packageRoot, "src", "index.ts")
      const testPath = path.join(packageRoot, "test", "index.test.ts")
      const readmePath = path.join(packageRoot, "README.md")
      const sharedConfigPath = path.join(workspaceRoot, "tsconfig.base.jsonc")
      const lockfilePath = path.join(workspaceRoot, "pnpm-lock.yaml")
      const boundedViteConfigPath = path.join(packageRoot, "vite.bounded.config.ts")
      const manifestMetadataPath = path.join(packageRoot, "manifest", "registry-metadata.ts")
      const registryComponentsPath = path.join(packageRoot, "registry", "components.json")
      const generatedArtifactPath = path.join(packageRoot, "dist", "index.js")
      yield* fileSystem.makeDirectory(path.dirname(sourcePath), { recursive: true })
      yield* fileSystem.makeDirectory(path.dirname(testPath), { recursive: true })
      yield* fileSystem.makeDirectory(path.dirname(manifestMetadataPath), { recursive: true })
      yield* fileSystem.makeDirectory(path.dirname(registryComponentsPath), { recursive: true })
      yield* fileSystem.makeDirectory(path.dirname(generatedArtifactPath), { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          exports: {
            ".": "./dist/index.js",
            "./registry/components.json": "./registry/components.json"
          },
          name: "@knpkv/rly"
        })
      )
      yield* fileSystem.writeFileString(
        path.join(packageRoot, "component-manifest.ts"),
        "export { metadata } from \"./manifest/registry-metadata.js\"\n"
      )
      yield* fileSystem.writeFileString(
        path.join(packageRoot, "tsconfig.json"),
        "{\"extends\":\"../../tsconfig.base.jsonc\"}"
      )
      yield* fileSystem.writeFileString(boundedViteConfigPath, "export default { build: { emptyOutDir: false } }\n")
      yield* fileSystem.writeFileString(manifestMetadataPath, "export const metadata = { state: \"stable\" }\n")
      yield* fileSystem.writeFileString(sharedConfigPath, "{\"compilerOptions\":{\"strict\":true}}")
      yield* fileSystem.writeFileString(
        lockfilePath,
        "lockfileVersion: '9.0'\nimporters:\n  packages/example:\n    dependencies:\n      bundled:\n        version: 1.0.0\n"
      )
      yield* fileSystem.writeFileString(sourcePath, "export const value = 1\n")
      yield* fileSystem.writeFileString(testPath, "expect(value).toBe(1)\n")
      yield* fileSystem.writeFileString(readmePath, "Example package\n")
      yield* fileSystem.writeFileString(registryComponentsPath, "{\"components\":[]}\n")
      yield* fileSystem.writeFileString(generatedArtifactPath, "export const generated = 1\n")

      const initial = yield* workspaceArtifactInputFingerprint(packageRoot)
      yield* fileSystem.writeFileString(testPath, "expect(value).toBe(2)\n")
      assert.strictEqual(yield* workspaceArtifactInputFingerprint(packageRoot), initial)
      yield* fileSystem.writeFileString(readmePath, "Updated package documentation\n")
      assert.strictEqual(yield* workspaceArtifactInputFingerprint(packageRoot), initial)
      yield* fileSystem.writeFileString(generatedArtifactPath, "export const generated = 2\n")
      assert.strictEqual(yield* workspaceArtifactInputFingerprint(packageRoot), initial)

      yield* fileSystem.writeFileString(registryComponentsPath, "{\"components\":[\"Button\"]}\n")
      const registryChanged = yield* workspaceArtifactInputFingerprint(packageRoot)
      assert.notStrictEqual(registryChanged, initial)
      assert.deepStrictEqual(
        packagesRequiringPublishedArtifactBuild(
          [
            {
              artifactPaths: ["dist/index.js", "registry/components.json"],
              fingerprintPath: path.join(packageRoot, "node_modules", ".cache", "artifact.sha256"),
              inputFingerprint: registryChanged,
              name: "@knpkv/rly",
              packageRoot
            }
          ],
          (candidate) => candidate === generatedArtifactPath || candidate === registryComponentsPath,
          () => initial,
          (root, artifact) => path.join(root, artifact)
        ),
        ["@knpkv/rly"]
      )

      yield* fileSystem.writeFileString(manifestMetadataPath, "export const metadata = { state: \"experimental\" }\n")
      const manifestChanged = yield* workspaceArtifactInputFingerprint(packageRoot)
      assert.notStrictEqual(manifestChanged, registryChanged)

      yield* fileSystem.writeFileString(boundedViteConfigPath, "export default { build: { emptyOutDir: true } }\n")
      const boundedConfigChanged = yield* workspaceArtifactInputFingerprint(packageRoot)
      assert.notStrictEqual(boundedConfigChanged, manifestChanged)

      yield* fileSystem.writeFileString(sharedConfigPath, "{\"compilerOptions\":{\"strict\":false}}")
      const sharedConfigChanged = yield* workspaceArtifactInputFingerprint(packageRoot)
      assert.notStrictEqual(sharedConfigChanged, boundedConfigChanged)

      yield* fileSystem.writeFileString(sourcePath, "export const value = 2\n")
      const sourceChanged = yield* workspaceArtifactInputFingerprint(packageRoot)
      assert.notStrictEqual(sourceChanged, sharedConfigChanged)

      yield* fileSystem.writeFileString(path.join(packageRoot, "tsconfig.build.json"), "{\"compilerOptions\":{}}")
      const buildConfigChanged = yield* workspaceArtifactInputFingerprint(packageRoot)
      assert.notStrictEqual(buildConfigChanged, sourceChanged)

      yield* fileSystem.writeFileString(
        lockfilePath,
        "lockfileVersion: '9.0'\nimporters:\n  packages/example:\n    dependencies:\n      bundled:\n        version: 2.0.0\n"
      )
      assert.notStrictEqual(yield* workspaceArtifactInputFingerprint(packageRoot), buildConfigChanged)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rebuilds workspace consumers when an emitted dependency changes", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-workspace-dependency-fingerprint-"
      })
      const atlassianRoot = path.join(workspaceRoot, "packages", "atlassian-common")
      const confluenceRoot = path.join(workspaceRoot, "packages", "confluence-to-markdown")
      const atlassianSource = path.join(atlassianRoot, "src", "index.ts")
      const atlassianReadme = path.join(atlassianRoot, "README.md")
      const confluenceSource = path.join(confluenceRoot, "src", "index.ts")
      yield* fileSystem.makeDirectory(path.dirname(atlassianSource), { recursive: true })
      yield* fileSystem.makeDirectory(path.dirname(confluenceSource), { recursive: true })
      yield* fileSystem.writeFileString(
        path.join(atlassianRoot, "package.json"),
        "{\"name\":\"@knpkv/atlassian-common\"}"
      )
      yield* fileSystem.writeFileString(
        path.join(confluenceRoot, "package.json"),
        "{\"name\":\"@knpkv/confluence-to-markdown\",\"dependencies\":{\"@knpkv/atlassian-common\":\"workspace:*\"}}"
      )
      yield* fileSystem.writeFileString(atlassianSource, "export const api = 1\n")
      yield* fileSystem.writeFileString(atlassianReadme, "Atlassian common\n")
      yield* fileSystem.writeFileString(
        confluenceSource,
        "export { api } from \"@knpkv/atlassian-common\"\n"
      )

      const resolveFingerprints = Effect.fn("test.resolveWorkspaceDependencyFingerprints")(function*() {
        const atlassianFingerprint = yield* workspaceArtifactInputFingerprint(atlassianRoot)
        const confluenceFingerprint = yield* workspaceArtifactInputFingerprint(confluenceRoot)
        return yield* resolveWorkspaceArtifactFingerprints([
          {
            name: "@knpkv/atlassian-common",
            ownFingerprint: atlassianFingerprint,
            workspaceDependencies: []
          },
          {
            name: "@knpkv/confluence-to-markdown",
            ownFingerprint: confluenceFingerprint,
            workspaceDependencies: ["@knpkv/atlassian-common"]
          }
        ])
      })

      const initial = yield* resolveFingerprints()
      yield* fileSystem.writeFileString(atlassianReadme, "Updated Atlassian common documentation\n")
      const documentationChanged = yield* resolveFingerprints()
      assert.deepStrictEqual(documentationChanged, initial)

      yield* fileSystem.writeFileString(atlassianSource, "export const api = 2\n")
      const dependencyChanged = yield* resolveFingerprints()
      assert.notStrictEqual(
        dependencyChanged.get("@knpkv/atlassian-common"),
        initial.get("@knpkv/atlassian-common")
      )
      assert.notStrictEqual(
        dependencyChanged.get("@knpkv/confluence-to-markdown"),
        initial.get("@knpkv/confluence-to-markdown")
      )

      const atlassian = contract(atlassianRoot, "@knpkv/atlassian-common")
      const confluence = contract(confluenceRoot, "@knpkv/confluence-to-markdown")
      const changedContracts = [
        { ...atlassian, inputFingerprint: dependencyChanged.get(atlassian.name) ?? "" },
        { ...confluence, inputFingerprint: dependencyChanged.get(confluence.name) ?? "" }
      ]
      const existingArtifacts = new Set([
        path.join(atlassianRoot, "dist/index.js"),
        path.join(confluenceRoot, "dist/index.js")
      ])
      const existingFingerprints = new Map([
        [atlassian.fingerprintPath, initial.get(atlassian.name)],
        [confluence.fingerprintPath, initial.get(confluence.name)]
      ])
      assert.deepStrictEqual(
        packagesRequiringPublishedArtifactBuild(
          changedContracts,
          (candidate) => existingArtifacts.has(candidate),
          (candidate) => existingFingerprints.get(candidate),
          (root, artifact) => path.join(root, artifact)
        ),
        ["@knpkv/atlassian-common", "@knpkv/confluence-to-markdown"]
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects workspace dependency cycles before computing artifact fingerprints", () =>
    Effect.gen(function*() {
      const error = yield* resolveWorkspaceArtifactFingerprints([
        { name: "@example/a", ownFingerprint: "a", workspaceDependencies: ["@example/b"] },
        { name: "@example/b", ownFingerprint: "b", workspaceDependencies: ["@example/a"] }
      ]).pipe(Effect.flip)

      assert.strictEqual(
        error.reason,
        "workspace dependency cycle prevents artifact fingerprinting: @example/a, @example/b"
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails when a successful dependency build leaves an advertised artifact missing", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const packageRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-missing-artifact-"
      })
      const contracts = [contract(packageRoot, "@example/missing")]

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
      const contracts = [contract(packageRoot, "@example/built")]
      const builtContract = contracts[0]
      if (builtContract === undefined) throw new Error("expected a built artifact contract")
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
      assert.strictEqual(
        yield* fileSystem.readFileString(builtContract.fingerprintPath),
        builtContract.inputFingerprint
      )

      const skippedPackages = yield* ensureWorkspaceArtifactContracts(
        contracts,
        () => Effect.fail(new WorkspaceArtifactError({ reason: "matching fingerprints must skip the build" }))
      )
      assert.deepStrictEqual(skippedPackages, [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
