import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AppId, type AppsConfig } from "@knpkv/hub-app"
import { Duration, Effect, Fiber, FileSystem, PlatformError, Schedule } from "effect"
import { tmpdir } from "node:os"
import { AppsLockBusy, type AppsStoreOptions, emptyAppsConfig, makeAppsStore } from "../src/apps/store.js"

const host = "this-host"

const storeIn = (root: string, overrides: Partial<AppsStoreOptions> = {}) =>
  makeAppsStore({
    configPath: `${root}/config/apps.json`,
    lockPath: `${root}/data/hub-apps/.lock`,
    self: { pid: 101, host },
    processAlive: () => Effect.succeed(true),
    ...overrides
  })

const tempRoot = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* fileSystem.makeTempDirectoryScoped({ directory: tmpdir(), prefix: "apps-store-" })
})

const withApp: AppsConfig = {
  ...emptyAppsConfig,
  apps: [{
    id: AppId.make("usage"),
    package: "@knpkv/herdr-usage",
    version: "1.0.0",
    dir: "/data/hub-apps/usage/1.0.0",
    bin: "node_modules/@knpkv/herdr-usage/dist/bin.js",
    enabled: true,
    memoryMb: 256,
    allowScripts: false
  }]
}

/** Writes another CLI's lock as `{pid, startedAt, host}`, optionally aged by `ageMillis`. */
const foreignLock = (root: string, lock: { pid: number; host: string }, ageMillis = 0) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = `${root}/data/hub-apps/.lock`
    yield* fileSystem.makeDirectory(`${root}/data/hub-apps`, { recursive: true })
    yield* fileSystem.writeFileString(path, JSON.stringify({ ...lock, startedAt: 1 }))
    const when = new Date(Date.now() - ageMillis)
    yield* fileSystem.utimes(path, when, when)
    return path
  })

describe("AppsStore", () => {
  it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect("reads an absent apps.json as an empty cli config and creates it on the first write", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const store = yield* storeIn(root)
        expect(yield* store.read).toEqual(emptyAppsConfig)
        yield* store.withLock((locked) => locked.write(withApp))
        expect(yield* store.read).toEqual(withApp)
      }).pipe(Effect.scoped))

    // Nix's file is a store symlink; only the marker on disk decides, never the caller's copy.
    it.effect("refuses every write while apps.json on disk says managedBy nix", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        const store = yield* storeIn(root)
        yield* fileSystem.makeDirectory(`${root}/config`)
        const nix = JSON.stringify({ ...emptyAppsConfig, managedBy: "nix" })
        yield* fileSystem.writeFileString(`${root}/config/apps.json`, nix)
        const error = yield* store.withLock((locked) => locked.write(withApp)).pipe(Effect.flip)
        expect(error._tag).toBe("AppsConfigManaged")
        expect(yield* fileSystem.readFileString(`${root}/config/apps.json`)).toBe(nix)
      }).pipe(Effect.scoped))

    it.effect("leaves no temp file and the old apps.json when the rename fails", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.makeDirectory(`${root}/config`)
        const before = JSON.stringify(emptyAppsConfig)
        yield* fileSystem.writeFileString(`${root}/config/apps.json`, before)
        const failingRename: FileSystem.FileSystem = {
          ...fileSystem,
          rename: (from) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Busy",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: from
              })
            )
        }
        const store = yield* storeIn(root).pipe(Effect.provideService(FileSystem.FileSystem, failingRename))
        const error = yield* store.withLock((locked) => locked.write(withApp)).pipe(Effect.flip)
        expect(error._tag).toBe("PlatformError")
        expect(yield* fileSystem.readDirectory(`${root}/config`)).toEqual(["apps.json"])
        expect(yield* fileSystem.readFileString(`${root}/config/apps.json`)).toBe(before)
      }).pipe(Effect.scoped))

    it.effect("refuses a live lock and releases its own when the command ends", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        const store = yield* storeIn(root)
        const lockPath = yield* foreignLock(root, { pid: 202, host })
        const busy = yield* store.withLock(() => Effect.void).pipe(Effect.flip)
        expect(busy).toEqual(new AppsLockBusy({ pid: 202 }))
        yield* fileSystem.remove(lockPath)
        yield* store.withLock(() => Effect.void)
        expect(yield* fileSystem.exists(lockPath)).toBe(false)
      }).pipe(Effect.scoped))

    it.effect("takes over a lock whose pid is gone on this host, or whose mtime is over 10 minutes old", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const dead = yield* storeIn(root, { processAlive: (pid) => Effect.succeed(pid !== 202) })
        yield* foreignLock(root, { pid: 202, host })
        expect(yield* dead.withLock(() => Effect.succeed("ran"))).toBe("ran")

        const old = yield* storeIn(root)
        yield* foreignLock(root, { pid: 303, host: "other-host" }, 11 * 60_000)
        expect(yield* old.withLock(() => Effect.succeed("ran"))).toBe("ran")
      }).pipe(Effect.scoped))

    // A pid names nothing on another host, so a dead-looking pid there is not evidence; only age is.
    it.effect("does not take over another host's fresh lock even when that pid is not running here", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const store = yield* storeIn(root, { processAlive: () => Effect.succeed(false) })
        yield* foreignLock(root, { pid: 404, host: "other-host" })
        expect(yield* store.withLock(() => Effect.void).pipe(Effect.flip)).toEqual(new AppsLockBusy({ pid: 404 }))
      }).pipe(Effect.scoped))

    // Two CLIs judge the same lock stale; the first replaces it, and the second must not remove the new one.
    it.effect("does not steal a lock replaced between the stale judgment and the removal", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        const lockPath = yield* foreignLock(root, { pid: 202, host })
        const replacement = JSON.stringify({ pid: 505, startedAt: 2, host })
        const store = yield* storeIn(root, {
          // The liveness question comes between the judgment's read and the re-read: replace the lock there.
          processAlive: () => fileSystem.writeFileString(lockPath, replacement).pipe(Effect.as(false), Effect.orDie)
        })
        expect(yield* store.withLock(() => Effect.void).pipe(Effect.flip)).toEqual(new AppsLockBusy({ pid: 505 }))
        expect(yield* fileSystem.readFileString(lockPath)).toBe(replacement)
      }).pipe(Effect.scoped))

    it.effect("refreshes a held lock's mtime so a long command is not taken over", () =>
      Effect.gen(function*() {
        const root = yield* tempRoot
        const fileSystem = yield* FileSystem.FileSystem
        const store = yield* storeIn(root, { refreshEvery: Duration.millis(20) })
        const lockPath = `${root}/data/hub-apps/.lock`
        const held = yield* Effect.forkScoped(store.withLock(() => Effect.never))
        const ageMillis = fileSystem.stat(lockPath).pipe(
          Effect.map((info) => info.mtime._tag === "Some" ? Date.now() - info.mtime.value.getTime() : Infinity),
          Effect.orElseSucceed(() => Infinity)
        )
        // Poll (bounded) rather than sleep a fixed time: a loaded runner may take a while per step.
        const until = (done: (age: number) => boolean) =>
          ageMillis.pipe(
            Effect.repeat({ until: done, schedule: Schedule.spaced(Duration.millis(20)), times: 500 }),
            Effect.map(done)
          )
        expect(yield* until((age) => age < 60_000)).toBe(true)
        const past = new Date(Date.now() - 11 * 60_000)
        yield* fileSystem.utimes(lockPath, past, past)
        expect(yield* until((age) => age < 60_000)).toBe(true)
        yield* Fiber.interrupt(held)
      }).pipe(Effect.scoped))
  })
})
