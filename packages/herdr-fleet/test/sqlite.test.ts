/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * The private SQLite opener every Herdr store goes through. Its promise: database
 * files are only ever readable by the owner, a path someone else could have
 * written or substituted is refused untouched, and a directory the caller already
 * owns keeps its mode.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openPrivateSqlite, type OpenPrivateSqliteOptions, type PrivateSqlite } from "../src/sqlite.js"

const posix = platform() !== "win32"
const mode = (path: string) => statSync(path).mode & 0o777

const tempRoot = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = mkdtempSync(join(tmpdir(), prefix))
      chmodSync(root, 0o700)
      return root
    }),
    (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true }))
  )

const createTable = (database: DatabaseSync) => database.exec("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY)")

const openScopedWith = (path: string, options: OpenPrivateSqliteOptions) =>
  Effect.acquireRelease(
    openPrivateSqlite(path, options),
    (opened: PrivateSqlite) => Effect.sync(() => opened.database.close())
  )

const openScoped = (path: string) => openScopedWith(path, { initialize: createTable })

const openResult = (path: string) =>
  Effect.result(
    Effect.acquireUseRelease(
      openPrivateSqlite(path, { initialize: createTable }),
      () => Effect.void,
      (opened) => Effect.sync(() => opened.database.close())
    )
  )

describe("openPrivateSqlite", () => {
  it.effect("creates a 0700 directory and 0600 database files, including WAL siblings after a write", () =>
    Effect.gen(function*() {
      const root = yield* tempRoot("herdr-sqlite-create-")
      const directory = join(root, "state")
      const path = join(directory, "store.sqlite")
      const opened = yield* openScoped(path)

      opened.database.prepare("INSERT INTO items (id) VALUES (?)").run("a")
      yield* opened.secureFiles

      if (posix) {
        expect(mode(directory)).toBe(0o700)
        for (const file of [path, `${path}-wal`, `${path}-shm`]) {
          if (existsSync(file)) expect(mode(file)).toBe(0o600)
        }
      }
      expect(opened.database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("restricts a pre-existing readable state directory to 0700", () =>
    Effect.gen(function*() {
      const root = yield* tempRoot("herdr-sqlite-shared-")
      const directory = join(root, "shared")
      mkdirSync(directory, { mode: 0o755 })
      chmodSync(directory, 0o755)
      yield* openScoped(join(directory, "store.sqlite"))
      if (posix) expect(mode(directory)).toBe(0o700)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a group- or other-writable directory and leaves it untouched", () =>
    Effect.gen(function*() {
      if (!posix) return
      const root = yield* tempRoot("herdr-sqlite-unsafe-dir-")
      for (const unsafe of [0o775, 0o777]) {
        const directory = join(root, unsafe.toString(8))
        mkdirSync(directory)
        chmodSync(directory, unsafe)
        const path = join(directory, "store.sqlite")
        const result = yield* openResult(path)
        expect(result).toMatchObject({ failure: { _tag: "PrivateDatabaseError", operation: "open.directory.unsafe" } })
        expect(existsSync(path)).toBe(false)
        expect(mode(directory)).toBe(unsafe)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a symlinked state directory or database, but allows a symlinked ancestor", () =>
    Effect.gen(function*() {
      if (!posix) return
      const root = yield* tempRoot("herdr-sqlite-links-")

      const realDirectory = join(root, "real")
      mkdirSync(realDirectory, { mode: 0o700 })
      const linkedDirectory = join(root, "linked")
      symlinkSync(realDirectory, linkedDirectory)
      expect(yield* openResult(join(linkedDirectory, "store.sqlite"))).toMatchObject({
        failure: { _tag: "PrivateDatabaseError", operation: "open.directory.path-identity" }
      })
      expect(existsSync(join(realDirectory, "store.sqlite"))).toBe(false)

      const safeDirectory = join(root, "safe")
      mkdirSync(safeDirectory, { mode: 0o700 })
      const danglingTarget = join(safeDirectory, "missing-target")
      const database = join(safeDirectory, "store.sqlite")
      symlinkSync(danglingTarget, database)
      expect(yield* openResult(database)).toMatchObject({
        failure: { _tag: "PrivateDatabaseError", operation: "open.path-identity" }
      })
      expect(existsSync(danglingTarget)).toBe(false)

      // macOS /var and Nix-managed homes are symlinked ancestors; they must keep working.
      const ancestorTarget = join(root, "ancestor-target")
      mkdirSync(ancestorTarget, { mode: 0o700 })
      const ancestorLink = join(root, "ancestor")
      symlinkSync(ancestorTarget, ancestorLink)
      yield* openScoped(join(ancestorLink, "state", "store.sqlite"))
      expect(existsSync(join(ancestorTarget, "state", "store.sqlite"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses an unsafe existing database before initialization and leaves it unchanged", () =>
    Effect.gen(function*() {
      if (!posix) return
      const root = yield* tempRoot("herdr-sqlite-unsafe-file-")
      const unsafePath = join(root, "unsafe.sqlite")
      const unsafe = new DatabaseSync(unsafePath)
      unsafe.exec("CREATE TABLE preserved (id TEXT PRIMARY KEY)")
      unsafe.close()
      chmodSync(unsafePath, 0o660)

      expect(yield* openResult(unsafePath)).toMatchObject({
        failure: { _tag: "PrivateDatabaseError", operation: "open.file.unsafe" }
      })
      expect(mode(unsafePath)).toBe(0o660)
      const unchanged = new DatabaseSync(unsafePath, { readOnly: true })
      expect(unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get())
        .toEqual({ count: 1 })
      unchanged.close()

      const safePath = join(root, "safe.sqlite")
      new DatabaseSync(safePath).close()
      chmodSync(safePath, 0o644)
      yield* openScoped(safePath)
      expect(mode(safePath)).toBe(0o600)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("closes the connection when initialization throws", () =>
    Effect.gen(function*() {
      const root = yield* tempRoot("herdr-sqlite-init-")
      const path = join(root, "store.sqlite")
      const result = yield* Effect.result(openPrivateSqlite(path, {
        initialize: (database) => {
          database.exec("BEGIN EXCLUSIVE")
          throw new Error("migration failed")
        }
      }))
      expect(result).toMatchObject({ failure: { _tag: "PrivateDatabaseError", operation: "open.database" } })

      // The exclusive lock went with the closed connection, so a fresh open can write.
      const reopened = yield* openScoped(path)
      reopened.database.prepare("INSERT INTO items (id) VALUES (?)").run("after")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("applies a busy timeout only when asked", () =>
    Effect.gen(function*() {
      const root = yield* tempRoot("herdr-sqlite-busy-")
      const waiting = yield* openScopedWith(join(root, "waiting.sqlite"), {
        initialize: createTable,
        busyTimeoutMillis: 5_000
      })
      const immediate = yield* openScoped(join(root, "immediate.sqlite"))
      expect(waiting.database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 })
      expect(immediate.database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
