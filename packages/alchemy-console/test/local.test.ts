import * as NodeServices from "@effect/platform-node/NodeServices"
import { expect, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { TestClock } from "effect/testing"
import * as NodeFs from "node:fs"
import { discoverProjects } from "../src/discovery.js"
import { readLocalState } from "../src/local-state.js"
import { readAlchemyVersion } from "../src/version.js"
import { clockedFileSystem, type ClockedIo } from "./clockedFileSystem.js"
import { lockedFileSystem } from "./lockedFileSystem.js"

const nodeClockIo: ClockedIo = {
  readDirectory: (directory) => NodeFs.readdirSync(directory),
  realPath: (path) => NodeFs.realpathSync(path),
  exists: (path) => NodeFs.existsSync(path),
  stat: (path) => NodeFs.statSync(path)
}

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
      expect(yield* discoverProjects(root)).toEqual({
        projects: [{ directory: project, entrypoint: path.join(project, "alchemy.run.ts") }],
        unreadable: 0,
        truncated: false
      })
    }).pipe(Effect.scoped))

  // A link that leaves the root is never followed; a dangling one leads nowhere. Neither stops the walk.
  it.effect("skips symlinks that escape the root or dangle, and keeps discovering", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-outside-" })
      yield* fs.writeFileString(path.join(outside, "alchemy.run.ts"), "")
      yield* fs.symlink(outside, path.join(root, "escape"))
      yield* fs.symlink(path.join(root, "missing"), path.join(root, "dangling"))
      const project = path.join(root, "app")
      yield* fs.makeDirectory(project)
      yield* fs.writeFileString(path.join(project, "alchemy.run.ts"), "")
      expect(yield* discoverProjects(root)).toEqual({
        projects: [{ directory: project, entrypoint: path.join(project, "alchemy.run.ts") }],
        unreadable: 0,
        truncated: false
      })
    }).pipe(Effect.scoped))

  it.effect("counts a directory it can't read and keeps discovering the rest", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const locked = path.join(root, "locked")
      yield* fs.makeDirectory(path.join(locked, "inner"), { recursive: true })
      const project = path.join(root, "app")
      yield* fs.makeDirectory(project)
      yield* fs.writeFileString(path.join(project, "alchemy.run.ts"), "")
      const found = yield* discoverProjects(root).pipe(
        Effect.provideService(FileSystem.FileSystem, yield* lockedFileSystem(yield* fs.realPath(locked)))
      )
      expect(found.projects.map((item) => item.directory)).toEqual([project])
      expect(found.unreadable).toBe(1)
    }).pipe(Effect.scoped))

  // The cap is the same stop as the time budget: projects already visited stay, and the walk says it stopped.
  it.effect("keeps projects already found when the directory cap is hit", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const project = path.join(root, "z-app")
      yield* fs.makeDirectory(project)
      yield* fs.writeFileString(path.join(project, "alchemy.run.ts"), "")
      yield* fs.makeDirectory(path.join(root, "a-later"))
      yield* fs.makeDirectory(path.join(root, "b-later"))
      const found = yield* discoverProjects(root, { maxDirectories: 2 })
      expect(found.truncated).toBe(true)
      expect(found.projects.map((item) => item.directory)).toEqual([project])
    }).pipe(Effect.scoped))

  it.effect("returns projects found when the walk budget runs out", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const project = path.join(root, "z-app")
      yield* fs.makeDirectory(project)
      yield* fs.writeFileString(path.join(project, "alchemy.run.ts"), "")
      for (const name of ["a", "b", "c", "d", "e", "f"]) yield* fs.makeDirectory(path.join(root, name))
      // Root, the project, then three later folders. The next one sees the 5 second budget.
      const slow = yield* clockedFileSystem(5, nodeClockIo)
      const fiber = yield* discoverProjects(root).pipe(
        Effect.provideService(FileSystem.FileSystem, slow.fs),
        Effect.forkChild
      )
      yield* Deferred.await(slow.started)
      yield* TestClock.adjust("6 seconds")
      expect(fiber.pollUnsafe()?._tag).toBe("Success")
      const found = yield* Fiber.join(fiber)
      expect(found.truncated).toBe(true)
      expect(found.projects.map((item) => item.directory)).toEqual([project])
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

  it.effect("distinguishes missing, proven-empty, hidden, malformed and inaccessible output state", () =>
    Effect.gen(function*() {
      const { fs, path, root } = yield* setup
      const dir = path.join(root, ".alchemy", "state", "docs", "preview")
      yield* fs.makeDirectory(dir, { recursive: true })
      const file = path.join(dir, "__stack_output__.json")
      const read = readLocalState(root, "2.0.0-beta.74")
      expect((yield* read).stacks[0]?.outputs).toBeNull()
      yield* fs.writeFileString(file, "{}")
      expect((yield* read).stacks[0]?.outputs).toEqual([])
      yield* fs.writeFileString(file, JSON.stringify({ Endpoint: "fixture-secret" }))
      expect((yield* read).stacks[0]?.outputs).toEqual([{
        key: "Endpoint",
        value: { _tag: "Hidden" },
        description: null
      }])
      yield* fs.writeFileString(file, "{")
      expect((yield* read).stacks[0]?.outputs).toBeNull()
      yield* fs.remove(file)
      const outside = yield* fs.makeTempDirectoryScoped()
      const foreign = path.join(outside, "output.json")
      yield* fs.writeFileString(foreign, "{}")
      yield* fs.symlink(foreign, file)
      expect((yield* read).stacks[0]?.outputs).toBeNull()
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
