import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { collectBoundedText } from "@knpkv/bounded-io"
import { Effect, FileSystem, Path, Result } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { resourcesStates } from "./superapp-browser/resources-fixture.js"
import { checkResourcesReferences, validateResourcesReferences } from "./superapp-browser/resources-references.js"

const collect = Effect.fn("ResourcesTest.collect")(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const paths = yield* Path.Path
  const cwd = yield* paths.fromFileUrl(new URL("../", import.meta.url))
  const handle = yield* spawner.spawn(ChildProcess.make("pnpm", [
    "exec",
    "playwright",
    "test",
    "--config",
    "playwright.superapp.config.ts",
    "test/superapp-browser/resources.spec.ts",
    "--list"
  ], { cwd, env: { HOST_RESOURCES_DESIGN_DIRECTORY: undefined }, extendEnv: true }))
  const { code, stderr, stdout } = yield* Effect.all({
    code: handle.exitCode,
    stdout: collectBoundedText(handle.stdout, 256 * 1024),
    stderr: collectBoundedText(handle.stderr, 256 * 1024)
  }, { concurrency: "unbounded" })
  return { code: Number(code), output: stdout + stderr }
})

const referenceDirectory = "/fixtures/design"
const completeFiles = resourcesStates.flatMap((state) =>
  [390, 1280].flatMap((width) => ["light", "dark"].map((theme) => `host-resources--${state}--${width}-${theme}.png`))
)

it("names a missing configured reference directory", () => {
  const result = validateResourcesReferences(referenceDirectory, null)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure.reason).toBe("missing_directory")
    expect(result.failure.message).toContain(referenceDirectory)
  }
})

it("requires all 44 reference names in an empty configured directory", () => {
  const result = validateResourcesReferences(referenceDirectory, [])
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure.reason).toBe("missing_files")
    expect(result.failure.missingFiles).toHaveLength(44)
    expect(result.failure.missingFiles).toContain("host-resources--gate-holder-unknown--1280-dark.png")
  }
})

it("accepts the complete reference inventory and unrelated directory entries", () => {
  expect(validateResourcesReferences(referenceDirectory, completeFiles)).toEqual(Result.succeed(undefined))
  expect(validateResourcesReferences(referenceDirectory, [...completeFiles, "unrelated.png"])).toEqual(
    Result.succeed(undefined)
  )
})

it("names a missing reference even when an unrelated file keeps the entry count at 44", () => {
  const missing = "host-resources--gate-holder-unknown--1280-dark.png"
  const listing = [...completeFiles.filter((name) => name !== missing), "unrelated.png"]
  const result = validateResourcesReferences(referenceDirectory, listing)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure.missingFiles).toEqual([missing])
    expect(result.failure.message).toContain(missing)
    expect(result.failure.message).toContain(referenceDirectory)
  }
})

it.layer(NodeServices.layer, { excludeTestServices: true })("resources browser collection", (it) => {
  it.effect("rejects a dangling reference and accepts it once the symlink resolves to a file", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "resources-refs-" })
      const missing = "host-resources--loading--1280-dark.png"
      for (const name of completeFiles.filter((name) => name !== missing)) {
        yield* fs.writeFileString(paths.join(directory, name), "reference")
      }
      const target = paths.join(directory, "target.png")
      yield* fs.symlink(target, paths.join(directory, missing))
      expect(validateResourcesReferences(directory, yield* fs.readDirectory(directory))).toEqual(
        Result.succeed(undefined)
      )
      const dangling = yield* checkResourcesReferences(directory).pipe(Effect.result)
      expect(Result.isFailure(dangling)).toBe(true)
      if (Result.isFailure(dangling)) {
        expect(dangling.failure).toMatchObject({
          _tag: "ResourcesReferenceInventoryError",
          directory,
          missingFiles: [missing]
        })
      }
      yield* fs.writeFileString(target, "reference")
      yield* checkResourcesReferences(directory)
    }))

  it.effect("rejects a directory in place of a required reference file", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "resources-refs-" })
      const missing = "host-resources--loading--1280-dark.png"
      for (const name of completeFiles.filter((name) => name !== missing)) {
        yield* fs.writeFileString(paths.join(directory, name), "reference")
      }
      yield* fs.makeDirectory(paths.join(directory, missing))
      const nonFile = yield* checkResourcesReferences(directory).pipe(Effect.result)
      expect(Result.isFailure(nonFile)).toBe(true)
      if (Result.isFailure(nonFile)) {
        expect(nonFile.failure).toMatchObject({ missingFiles: [missing] })
      }
    }))

  // Five local runs: slowest smoke 1.63s; allow 10s for CI process-startup contention.
  it.effect(
    "collects every resources behavior case from a checkout without private design references",
    () =>
      Effect.gen(function*() {
        const result = yield* collect()
        expect(result.code, result.output).toBe(0)
        expect(result.output).toContain("Total: 44 tests in 1 file")
      }),
    10_000
  )
})
