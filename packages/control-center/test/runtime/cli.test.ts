import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { assert, describe, it } from "@effect/vitest"
import type { FileSystem as FileSystemType } from "effect"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"

import { classifyControlCenterCliArguments } from "../../src/server/cliArguments.js"
import { decodeControlCenterDataPaths, prepareControlCenterDataRoot } from "../../src/server/cliConfiguration.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistenceConfigError } from "../../src/server/persistence/errors.js"
import { migration0001Core } from "../../src/server/persistence/migrations/0001_core.js"

interface RegularFileSnapshot {
  readonly bytes: Uint8Array
  readonly metadata: Omit<FileSystemType.File.Info, "atime">
  readonly name: string
}

const stableFileMetadata = (info: FileSystemType.File.Info): Omit<FileSystemType.File.Info, "atime"> => ({
  // Reading the comparison bytes necessarily advances atime on strict-atime filesystems.
  birthtime: info.birthtime,
  blksize: info.blksize,
  blocks: info.blocks,
  dev: info.dev,
  gid: info.gid,
  ino: info.ino,
  mode: info.mode,
  mtime: info.mtime,
  nlink: info.nlink,
  rdev: info.rdev,
  size: info.size,
  type: info.type,
  uid: info.uid
})

const snapshotDatabaseFiles = Effect.fn("ControlCenterCliTest.snapshotDatabaseFiles")(function*(
  fileSystem: FileSystemType.FileSystem,
  path: Path.Path,
  root: string
) {
  const snapshots: Array<RegularFileSnapshot> = []
  const entries = (yield* fileSystem.readDirectory(root))
    .filter((entry) => entry.startsWith("control-center.db"))
    .sort()
  for (const name of entries) {
    const filePath = path.join(root, name)
    const info = yield* fileSystem.stat(filePath)
    if (info.type !== "File") continue
    const bytes = yield* fileSystem.readFile(filePath)
    snapshots.push({ bytes, metadata: stableFileMetadata(yield* fileSystem.stat(filePath)), name })
  }
  return snapshots
})

const withForeignOwner = (file: FileSystemType.File): FileSystemType.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  fd: file.fd,
  read: file.read,
  readAlloc: file.readAlloc,
  seek: file.seek,
  stat: file.stat.pipe(
    Effect.map((info) => ({
      ...info,
      uid: Option.map(info.uid, (uid) => uid + 1)
    }))
  ),
  sync: file.sync,
  truncate: file.truncate,
  write: file.write,
  writeAll: file.writeAll
})

describe("Control Center CLI", () => {
  it("accepts exactly the serve and recover-owner argument shapes", () => {
    assert.deepStrictEqual(classifyControlCenterCliArguments([]), { _tag: "serve" })
    assert.deepStrictEqual(classifyControlCenterCliArguments(["recover-owner"]), { _tag: "recover-owner" })
    assert.deepStrictEqual(classifyControlCenterCliArguments(["recover-owner", "unexpected"]), {
      _tag: "invalid",
      command: "recover-owner unexpected"
    })
  })

  it.effect("decodes derived data paths without defecting on invalid environment input", () =>
    Effect.gen(function*() {
      const valid = yield* decodeControlCenterDataPaths(".control-center")
      assert.match(valid.persistenceConfig.databaseUrl, /^file:\//u)
      assert.match(valid.persistenceConfig.blobRoot, /\/blobs$/u)
      assert.match(valid.secretRoot, /\/secrets$/u)

      const invalid = yield* decodeControlCenterDataPaths(`root-${"a".repeat(4_096)}`).pipe(Effect.result)
      assert.isTrue(Result.isFailure(invalid))
      if (Result.isFailure(invalid)) {
        assert.instanceOf(invalid.failure, PersistenceConfigError)
      }

      for (const unsafeRoot of ["", " ", "/"]) {
        const result = yield* decodeControlCenterDataPaths(unsafeRoot).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, PersistenceConfigError)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses an unrelated existing directory without changing its mode", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-unrelated-" })
      const privateRoot = path.join(parent, "private")
      yield* fileSystem.chmod(parent, 0o755)
      yield* fileSystem.makeDirectory(privateRoot, { mode: 0o700 })

      const unrelatedRoots: ReadonlyArray<readonly [string, number]> = [
        [parent, 0o755],
        [privateRoot, 0o700]
      ]
      for (const [root, expectedMode] of unrelatedRoots) {
        const dataPaths = yield* decodeControlCenterDataPaths(root)
        const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)
        assert.isTrue(Result.isFailure(prepared))
        if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
        assert.strictEqual((yield* fileSystem.stat(root)).mode & 0o777, expectedMode)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("creates a marked root and accepts it again without changing its identity", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-fresh-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)

      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      const before = yield* fileSystem.stat(root)
      const preparedAgain = yield* prepareControlCenterDataRoot(dataPaths)
      const after = yield* fileSystem.stat(root)

      assert.strictEqual(path.join(parent, yield* fileSystem.readLink(root)), prepared.dataRoot)
      assert.strictEqual(preparedAgain.dataRoot, prepared.dataRoot)
      assert.strictEqual(before.ino._tag, "Some")
      assert.deepStrictEqual(after.ino, before.ino)
      assert.strictEqual(after.mode & 0o777, 0o700)
      assert.include(yield* fileSystem.readDirectory(root), ".control-center-root")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("does not replace an empty root that appears during atomic publication", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-no-clobber-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const racingFileSystem = FileSystem.make({
        ...fileSystem,
        symlink: (target, linkPath) =>
          linkPath === root
            ? fileSystem.makeDirectory(root, { mode: 0o700 }).pipe(
              Effect.andThen(fileSystem.symlink(target, linkPath))
            )
            : fileSystem.symlink(target, linkPath)
      })

      const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFileSystem),
        Effect.result
      )

      assert.isTrue(Result.isFailure(prepared))
      assert.deepStrictEqual(yield* fileSystem.readDirectory(root), [])
      assert.strictEqual((yield* fileSystem.stat(root)).mode & 0o777, 0o700)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("uses a durable relative no-replace claim as the configured data root", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-claim-" })
      const root = path.join(parent, "data")
      const stagingRoot = yield* fileSystem.makeTempDirectory({
        directory: parent,
        prefix: ".control-center-incoming-"
      })
      yield* fileSystem.chmod(stagingRoot, 0o700)
      const stagingMarker = path.join(stagingRoot, ".control-center-root")
      yield* fileSystem.writeFileString(stagingMarker, "@knpkv/control-center:data-root:v1\n", {
        mode: 0o600
      })
      yield* fileSystem.chmod(stagingMarker, 0o600)
      const stagingName = path.basename(stagingRoot)
      yield* fileSystem.symlink(stagingName, root)
      const dataPaths = yield* decodeControlCenterDataPaths(root)

      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      const preparedAgain = yield* prepareControlCenterDataRoot(dataPaths)

      assert.strictEqual(yield* fileSystem.readLink(root), stagingName)
      assert.strictEqual(prepared.dataRoot, stagingRoot)
      assert.strictEqual(preparedAgain.dataRoot, stagingRoot)
      assert.strictEqual((yield* fileSystem.stat(root)).type, "Directory")
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, ".control-center-root")),
        "@knpkv/control-center:data-root:v1\n"
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("reopens a relative claim after its parent directory is moved", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const outer = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-move-" })
      const originalParent = path.join(outer, "original")
      const movedParent = path.join(outer, "moved")
      const originalRoot = path.join(originalParent, "data")
      yield* fileSystem.makeDirectory(originalParent)

      const originalPaths = yield* decodeControlCenterDataPaths(originalRoot)
      const prepared = yield* prepareControlCenterDataRoot(originalPaths)
      const stagingName = path.basename(prepared.dataRoot)
      yield* fileSystem.writeFileString(path.join(prepared.dataRoot, "durable-state"), "preserved")

      yield* fileSystem.rename(originalParent, movedParent)
      const movedRoot = path.join(movedParent, "data")
      const movedPaths = yield* decodeControlCenterDataPaths(movedRoot)
      const reopened = yield* prepareControlCenterDataRoot(movedPaths)
      const expectedOperationalRoot = path.join(movedParent, stagingName)

      assert.strictEqual(yield* fileSystem.readLink(movedRoot), stagingName)
      assert.strictEqual(reopened.dataRoot, expectedOperationalRoot)
      assert.strictEqual(
        reopened.persistenceConfig.databaseUrl,
        `file:${path.join(expectedOperationalRoot, "control-center.db")}`
      )
      assert.strictEqual(reopened.persistenceConfig.blobRoot, path.join(expectedOperationalRoot, "blobs"))
      assert.strictEqual(reopened.secretRoot, path.join(expectedOperationalRoot, "secrets"))
      assert.strictEqual(yield* fileSystem.readFileString(path.join(reopened.dataRoot, "durable-state")), "preserved")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("refuses to create a fresh root when a durable sibling has lost its claim", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-lost-claim-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.validateMigrationLedger
      }).pipe(Effect.provide(databaseLayer(prepared.persistenceConfig)), Effect.scoped)
      const durableEntries = (yield* fileSystem.readDirectory(prepared.dataRoot)).sort()
      const parentEntries = (yield* fileSystem.readDirectory(parent)).sort()

      yield* fileSystem.remove(root)
      const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(restarted))
      if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
      assert.isFalse(yield* fileSystem.exists(root))
      assert.deepStrictEqual(
        (yield* fileSystem.readDirectory(parent)).sort(),
        parentEntries.filter((entry) => entry !== "data")
      )
      assert.deepStrictEqual((yield* fileSystem.readDirectory(prepared.dataRoot)).sort(), durableEntries)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("creates multiple independent durable roots beneath the same parent", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-multiple-roots-" })
      const firstRoot = path.join(parent, "first")
      const secondRoot = path.join(parent, "second")
      const firstPaths = yield* decodeControlCenterDataPaths(firstRoot)
      const firstPrepared = yield* prepareControlCenterDataRoot(firstPaths)
      yield* fileSystem.writeFileString(path.join(firstPrepared.dataRoot, "durable-state"), "first")

      const secondPaths = yield* decodeControlCenterDataPaths(secondRoot)
      const secondPrepared = yield* prepareControlCenterDataRoot(secondPaths)

      assert.notStrictEqual(secondPrepared.dataRoot, firstPrepared.dataRoot)
      assert.strictEqual(
        path.join(parent, yield* fileSystem.readLink(firstRoot)),
        firstPrepared.dataRoot
      )
      assert.strictEqual(
        path.join(parent, yield* fileSystem.readLink(secondRoot)),
        secondPrepared.dataRoot
      )
      assert.strictEqual(yield* fileSystem.readFileString(path.join(firstPrepared.dataRoot, "durable-state")), "first")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("repairs a durable partial marker left by interrupted setup", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-interrupted-" })
      yield* fileSystem.chmod(root, 0o700)
      const markerPath = path.join(root, ".control-center-root")
      yield* fileSystem.writeFileString(markerPath, "@knpkv/control-center:data-root:", { mode: 0o600 })
      yield* fileSystem.chmod(markerPath, 0o600)
      const pendingMarkerName = `.control-center-root.pending-${"a".repeat(32)}`
      const pendingMarkerPath = path.join(root, pendingMarkerName)
      yield* fileSystem.writeFileString(pendingMarkerPath, "@knpkv/control-center:data-root:v1\n", {
        mode: 0o600
      })
      yield* fileSystem.chmod(pendingMarkerPath, 0o600)
      const dataPaths = yield* decodeControlCenterDataPaths(root)

      yield* prepareControlCenterDataRoot(dataPaths)
      yield* prepareControlCenterDataRoot(dataPaths)

      assert.strictEqual(
        yield* fileSystem.readFileString(markerPath),
        "@knpkv/control-center:data-root:v1\n"
      )
      assert.notInclude(yield* fileSystem.readDirectory(root), pendingMarkerName)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a root when files created by this process have a different owner", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-owner-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      yield* prepareControlCenterDataRoot(dataPaths)

      const foreignOwnerFileSystem = FileSystem.make({
        ...fileSystem,
        open: (target, options) =>
          fileSystem.open(target, options).pipe(
            Effect.map((file) => target.includes(".control-center-owner-") ? withForeignOwner(file) : file)
          )
      })
      const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(
        Effect.provideService(FileSystem.FileSystem, foreignOwnerFileSystem),
        Effect.result
      )

      assert.isTrue(Result.isFailure(prepared))
      if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("adopts an existing private legacy Control Center root", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-legacy-" })
      yield* fileSystem.chmod(root, 0o700)
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.validateMigrationLedger
      }).pipe(Effect.provide(databaseLayer(dataPaths.persistenceConfig)), Effect.scoped)

      yield* prepareControlCenterDataRoot(dataPaths)
      yield* prepareControlCenterDataRoot(dataPaths)

      assert.strictEqual((yield* fileSystem.stat(root)).mode & 0o777, 0o700)
      assert.include(yield* fileSystem.readDirectory(root), ".control-center-root")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a SQLite database without the Control Center migration identity", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-invalid-legacy-" })
      yield* fileSystem.chmod(root, 0o700)
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.sql`DROP TABLE control_center_migrations`
      }).pipe(Effect.provide(databaseLayer(dataPaths.persistenceConfig)), Effect.scoped)
      const databasePath = path.join(root, "control-center.db")
      yield* fileSystem.writeFile(`${databasePath}-wal`, Uint8Array.from([1, 2, 3, 4]), { mode: 0o600 })
      yield* fileSystem.writeFile(`${databasePath}-journal`, Uint8Array.from([5, 6, 7, 8]), { mode: 0o600 })
      yield* fileSystem.writeFile(`${databasePath}-shm`, Uint8Array.from([9, 10, 11, 12]), { mode: 0o600 })
      const entriesBefore = (yield* fileSystem.readDirectory(root)).sort()
      const databaseFilesBefore = yield* snapshotDatabaseFiles(fileSystem, path, root)

      const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(prepared))
      if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
      assert.notInclude(yield* fileSystem.readDirectory(root), ".control-center-root")
      assert.deepStrictEqual((yield* fileSystem.readDirectory(root)).sort(), entriesBefore)
      assert.deepStrictEqual(yield* snapshotDatabaseFiles(fileSystem, path, root), databaseFilesBefore)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("adopts a legacy database with an older supported migration prefix", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-prefix-" })
      yield* fileSystem.chmod(root, 0o700)
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      yield* LibsqlMigrator.run({
        loader: LibsqlMigrator.fromRecord({ "0001_core_heads": migration0001Core }),
        table: "control_center_migrations"
      }).pipe(
        Effect.provide(
          LibsqlClient.layer({
            concurrency: 1,
            url: dataPaths.persistenceConfig.databaseUrl
          })
        ),
        Effect.scoped
      )

      yield* prepareControlCenterDataRoot(dataPaths)

      assert.include(yield* fileSystem.readDirectory(root), ".control-center-root")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
