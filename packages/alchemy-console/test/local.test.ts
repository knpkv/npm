import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { discoverProjects } from "../src/discovery.js"
import { readLocalState } from "../src/local-state.js"
import { readAlchemyVersion } from "../src/version.js"

const setup = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-fixture-" })
  return { fs, path, root }
})

layer(NodeServices.layer)("local readers", (it) => {
  it.effect("discovers nested projects without evaluating entrypoints; skips dependencies and cycles", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const project = path.join(root, "apps", "fixture-app")
      const dependency = path.join(root, "node_modules", "fixture-dependency")
      yield* fs.makeDirectory(project, { recursive: true })
      yield* fs.makeDirectory(dependency, { recursive: true })
      yield* fs.writeFileString(path.join(project, "alchemy.run.ts"), "throw new Error(\"must not execute\")")
      yield* fs.writeFileString(path.join(dependency, "alchemy.run.ts"), "")
      yield* fs.symlink(root, path.join(project, "cycle"))
      expect(yield* discoverProjects(root)).toEqual([{
        directory: project,
        entrypoint: path.join(project, "alchemy.run.ts")
      }])
    }).pipe(Effect.scoped))

  it.effect("rejects discovery symlinks outside the search root", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const outside = yield* fs.makeTempDirectoryScoped()
      yield* fs.symlink(outside, path.join(root, "escape"))
      expect(yield* Effect.flip(discoverProjects(root))).toMatchObject({ reason: "outside-root" })
    }).pipe(Effect.scoped))

  it.effect("reads multiple stages, ignores output/tmp files, and preserves namespace parents", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const fixture = yield* fs.readFileString(path.join(import.meta.dirname, "fixtures/resource.json"))
      const action = yield* fs.readFileString(path.join(import.meta.dirname, "fixtures/action.json"))
      for (const stage of ["preview", "prod"]) {
        const dir = path.join(root, ".alchemy", "state", "fixture-app", stage)
        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(path.join(dir, "Storage__Assets.json"), fixture)
        yield* fs.writeFileString(path.join(dir, "Task.json"), action)
        yield* fs.writeFileString(path.join(dir, "__stack_output__.json"), "fixture-secret")
        yield* fs.writeFileString(path.join(dir, "inflight.tmp"), "partial")
      }
      const result = yield* readLocalState(root, "2.0.0-beta.77")
      expect(result.available).toBe(true)
      expect(result.stacks.map((s) => s.stage)).toEqual(["preview", "prod"])
      expect(result.stacks.every((s) => s.resources.length === 1 && s.lastDeploy === null)).toBe(true)
      expect(JSON.stringify(result)).not.toContain("fixture-secret")
      expect(JSON.stringify(result)).not.toContain(root)
    }).pipe(Effect.scoped))

  it.effect("distinguishes absent state from an empty stage and rejects unknown versions", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      expect(yield* readLocalState(root, "2.0.0-beta.74")).toEqual({ available: false, stacks: [] })
      yield* fs.makeDirectory(path.join(root, ".alchemy", "state", "fixture-app", "prod"), { recursive: true })
      const result = yield* readLocalState(root, "2.0.0-beta.74")
      expect(result.available).toBe(true)
      expect(result.stacks[0]?.resources).toEqual([])
      expect(yield* Effect.flip(readLocalState(root, "2.0.0-beta.999"))).toMatchObject({
        reason: "unsupported-version"
      })
    }).pipe(Effect.scoped))

  it.effect("rejects mismatched resource filenames and state symlinks", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const dir = path.join(root, ".alchemy", "state", "fixture-app", "prod")
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(
        path.join(dir, "Wrong.json"),
        yield* fs.readFileString(path.join(import.meta.dirname, "fixtures/resource.json"))
      )
      expect(yield* Effect.flip(readLocalState(root, "2.0.0-beta.77"))).toMatchObject({ reason: "invalid-state" })
      const outside = yield* fs.makeTempDirectoryScoped()
      yield* fs.symlink(outside, path.join(root, ".alchemy", "state", "escape"))
      expect(yield* Effect.flip(readLocalState(root, "2.0.0-beta.77"))).toMatchObject({ reason: "outside-root" })
    }).pipe(Effect.scoped))

  it.effect("resolves the project's pnpm importer, not another workspace's version", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const project = path.join(root, "apps", "fixture-app")
      yield* fs.makeDirectory(project, { recursive: true })
      yield* fs.writeFileString(
        path.join(root, "pnpm-lock.yaml"),
        `importers:
  .:
    devDependencies:
      alchemy:
        version: 2.0.0-beta.74(effect@4.0.0)
  apps/fixture-app:
    dependencies:
      alchemy:
        version: 2.0.0-beta.77(effect@4.0.0)
`
      )
      expect(yield* readAlchemyVersion(project, root)).toBe("2.0.0-beta.77")
      expect(yield* readAlchemyVersion(root, root)).toBe("2.0.0-beta.74")
    }).pipe(Effect.scoped))

  it.effect("fails a state read at its byte limit without retaining contents in the error", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const dir = path.join(root, ".alchemy", "state", "fixture-app", "prod")
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(path.join(dir, "Assets.json"), "fixture-secret".repeat(700_000))
      const error = yield* Effect.flip(readLocalState(root, "2.0.0-beta.77"))
      expect(error.reason).toBe("limit")
      expect(JSON.stringify(error)).not.toContain("fixture-secret")
    }).pipe(Effect.scoped))

  it.effect("reads Bun JSONC with comments/trailing commas and sanitizes malformed lock errors", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const lock = path.join(root, "bun.lock")
      expect(yield* readAlchemyVersion(root, root)).toBeNull()
      yield* fs.writeFileString(
        lock,
        "{ // fixture\n\"packages\": { \"alchemy\": [\"alchemy@2.0.0-beta.77\", \"\", {}, \"fixture-integrity\"], }, }"
      )
      expect(yield* readAlchemyVersion(root, root)).toBe("2.0.0-beta.77")
      yield* fs.writeFileString(lock, "fixture-secret")
      const error = yield* Effect.flip(readAlchemyVersion(root, root))
      expect(error.reason).toBe("invalid-lockfile")
      expect(JSON.stringify(error)).not.toContain("fixture-secret")
    }).pipe(Effect.scoped))
})
