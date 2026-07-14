import * as NodeServices from "@effect/platform-node/NodeServices"
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { assert, describe, it } from "@effect/vitest"
import type { FileSystem as FileSystemType } from "effect"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"

import { classifyControlCenterCliArguments } from "../../src/server/cliArguments.js"
import { decodeControlCenterDataPaths, prepareControlCenterDataRoot } from "../../src/server/cliConfiguration.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistenceConfigError } from "../../src/server/persistence/errors.js"
import { migration0001Core } from "../../src/server/persistence/migrations/0001_core.js"

const DATA_ROOT_MARKER_V1_CONTENT = "@knpkv/control-center:data-root:v1\n"
const boundMarkerContent = (claimBasename: string, targetBasename: string): string =>
  `@knpkv/control-center:data-root:v2\nclaim-basename:${Encoding.encodeBase64Url(claimBasename)}\n` +
  `target-basename:${Encoding.encodeBase64Url(targetBasename)}\n`

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

      const reservedPaths = yield* decodeControlCenterDataPaths(".control-center-incoming-reserved")
      const reserved = yield* prepareControlCenterDataRoot(reservedPaths).pipe(Effect.result)
      assert.isTrue(Result.isFailure(reserved))
      if (Result.isFailure(reserved)) assert.instanceOf(reserved.failure, PersistenceConfigError)
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
      assert.deepStrictEqual(
        (yield* fileSystem.readDirectory(parent)).filter((entry) => entry.startsWith(".control-center-incoming-")),
        []
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a protocol-only staged legacy claim without consuming pending evidence", () =>
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
      yield* fileSystem.writeFileString(stagingMarker, DATA_ROOT_MARKER_V1_CONTENT, {
        mode: 0o600
      })
      yield* fileSystem.chmod(stagingMarker, 0o600)
      const pendingMarker = path.join(stagingRoot, `.control-center-root.pending-${"b".repeat(32)}`)
      yield* fileSystem.writeFileString(pendingMarker, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
      yield* fileSystem.chmod(pendingMarker, 0o600)
      const stagingName = path.basename(stagingRoot)
      yield* fileSystem.symlink(stagingName, root)
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const entriesBefore = (yield* fileSystem.readDirectory(stagingRoot)).sort()

      const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(prepared))
      if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
      assert.strictEqual(yield* fileSystem.readLink(root), stagingName)
      assert.deepStrictEqual((yield* fileSystem.readDirectory(stagingRoot)).sort(), entriesBefore)
      assert.strictEqual(yield* fileSystem.readFileString(stagingMarker), DATA_ROOT_MARKER_V1_CONTENT)
      assert.strictEqual(yield* fileSystem.readFileString(pendingMarker), DATA_ROOT_MARKER_V1_CONTENT)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("upgrades a legacy marker on a direct durable root", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-direct-v1-" })
      yield* fileSystem.chmod(root, 0o700)
      const markerPath = path.join(root, ".control-center-root")
      yield* fileSystem.writeFileString(markerPath, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
      yield* fileSystem.chmod(markerPath, 0o600)
      yield* fileSystem.writeFileString(path.join(root, "durable-state"), "preserved")
      const pendingMarker = path.join(root, `.control-center-root.pending-${"c".repeat(32)}`)
      yield* fileSystem.writeFileString(pendingMarker, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
      yield* fileSystem.chmod(pendingMarker, 0o600)

      yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root))

      assert.strictEqual(
        yield* fileSystem.readFileString(markerPath),
        boundMarkerContent(path.basename(root), path.basename(root))
      )
      assert.isFalse(yield* fileSystem.exists(pendingMarker))
      assert.strictEqual(yield* fileSystem.readFileString(path.join(root, "durable-state")), "preserved")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a durable staged legacy root without mutating recovery evidence", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-staged-v1-" })
      const root = path.join(parent, "data")
      const stagingRoot = yield* fileSystem.makeTempDirectory({
        directory: parent,
        prefix: ".control-center-incoming-"
      })
      yield* fileSystem.chmod(stagingRoot, 0o700)
      const markerPath = path.join(stagingRoot, ".control-center-root")
      yield* fileSystem.writeFileString(markerPath, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
      yield* fileSystem.chmod(markerPath, 0o600)
      yield* fileSystem.writeFileString(path.join(stagingRoot, "durable-state"), "preserved")
      yield* fileSystem.symlink(path.basename(stagingRoot), root)
      const entriesBefore = (yield* fileSystem.readDirectory(stagingRoot)).sort()

      const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root)).pipe(
        Effect.result
      )
      const sibling = yield* prepareControlCenterDataRoot(
        yield* decodeControlCenterDataPaths(path.join(parent, "sibling"))
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(prepared))
      if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
      assert.isTrue(Result.isFailure(sibling))
      if (Result.isFailure(sibling)) assert.instanceOf(sibling.failure, PersistenceConfigError)
      assert.strictEqual(yield* fileSystem.readLink(root), path.basename(stagingRoot))
      assert.deepStrictEqual((yield* fileSystem.readDirectory(stagingRoot)).sort(), entriesBefore)
      assert.strictEqual(yield* fileSystem.readFileString(markerPath), DATA_ROOT_MARKER_V1_CONTENT)
      assert.strictEqual(yield* fileSystem.readFileString(path.join(stagingRoot, "durable-state")), "preserved")
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

  it.effect("validates all pending markers on a bound v2 root before cleaning them", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-v2-pending-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      const validPending = path.join(prepared.dataRoot, `.control-center-root.pending-${"7".repeat(32)}`)
      const invalidPending = path.join(prepared.dataRoot, `.control-center-root.pending-${"8".repeat(32)}`)
      yield* fileSystem.writeFileString(
        validPending,
        boundMarkerContent("data", path.basename(prepared.dataRoot)),
        { mode: 0o600 }
      )
      yield* fileSystem.chmod(validPending, 0o600)
      yield* fileSystem.writeFileString(invalidPending, "invalid\n", { mode: 0o600 })
      yield* fileSystem.chmod(invalidPending, 0o600)

      const rejected = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) assert.instanceOf(rejected.failure, PersistenceConfigError)
      assert.isTrue(yield* fileSystem.exists(validPending))
      assert.isTrue(yield* fileSystem.exists(invalidPending))

      yield* fileSystem.remove(invalidPending)
      yield* prepareControlCenterDataRoot(dataPaths)

      assert.isFalse(yield* fileSystem.exists(validPending))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("accepts a pending marker removed concurrently after validation", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-pending-race-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      const pendingMarker = path.join(prepared.dataRoot, `.control-center-root.pending-${"9".repeat(32)}`)
      yield* fileSystem.writeFileString(
        pendingMarker,
        boundMarkerContent("data", path.basename(prepared.dataRoot)),
        { mode: 0o600 }
      )
      yield* fileSystem.chmod(pendingMarker, 0o600)
      const racingFileSystem = FileSystem.make({
        ...fileSystem,
        remove: (target, options) =>
          target === pendingMarker
            ? fileSystem.remove(target, options).pipe(Effect.andThen(fileSystem.remove(target, options)))
            : fileSystem.remove(target, options)
      })

      const reopened = yield* prepareControlCenterDataRoot(dataPaths).pipe(
        Effect.provideService(FileSystem.FileSystem, racingFileSystem)
      )

      assert.strictEqual(reopened.dataRoot, prepared.dataRoot)
      assert.isFalse(yield* fileSystem.exists(pendingMarker))
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

  it.effect("allows a different claim beside an orphan bound to another basename", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-other-orphan-" })
      const firstRoot = path.join(parent, "first")
      const firstPaths = yield* decodeControlCenterDataPaths(firstRoot)
      const first = yield* prepareControlCenterDataRoot(firstPaths)
      yield* fileSystem.writeFileString(path.join(first.dataRoot, "durable-state"), "preserved")
      yield* fileSystem.remove(firstRoot)

      const secondRoot = path.join(parent, "second")
      const second = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(secondRoot))
      const firstRestart = yield* prepareControlCenterDataRoot(firstPaths).pipe(Effect.result)

      assert.strictEqual(yield* fileSystem.readFileString(path.join(first.dataRoot, "durable-state")), "preserved")
      assert.strictEqual(path.join(parent, yield* fileSystem.readLink(secondRoot)), second.dataRoot)
      assert.isTrue(Result.isFailure(firstRestart))
      if (Result.isFailure(firstRestart)) assert.instanceOf(firstRestart.failure, PersistenceConfigError)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("does not let an unrelated stale alias hide a lost claim", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-stale-alias-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      const stagingName = path.basename(prepared.dataRoot)
      yield* fileSystem.writeFileString(path.join(prepared.dataRoot, "durable-state"), "preserved")
      yield* fileSystem.remove(root)
      yield* fileSystem.symlink(stagingName, path.join(parent, "stale-alias"))

      const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(restarted))
      if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
      assert.isFalse(yield* fileSystem.exists(root))
      assert.strictEqual(yield* fileSystem.readFileString(path.join(prepared.dataRoot, "durable-state")), "preserved")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a configured alias whose basename does not match the bound claim", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-bound-alias-" })
      const root = path.join(parent, "data")
      const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root))
      const alias = path.join(parent, "alias")
      yield* fileSystem.symlink(path.basename(prepared.dataRoot), alias)

      const aliased = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(alias)).pipe(
        Effect.result
      )

      assert.isTrue(Result.isFailure(aliased))
      if (Result.isFailure(aliased)) assert.instanceOf(aliased.failure, PersistenceConfigError)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("fails closed when a claimed root cannot be inspected as a symbolic link", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-readlink-error-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      yield* prepareControlCenterDataRoot(dataPaths)
      const failingFileSystem = FileSystem.make({
        ...fileSystem,
        readLink: (target) =>
          target === root
            ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                method: "readLink",
                module: "FileSystem",
                pathOrDescriptor: target
              })
            )
            : fileSystem.readLink(target)
      })

      const reopened = yield* prepareControlCenterDataRoot(dataPaths).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFileSystem),
        Effect.result
      )

      assert.isTrue(Result.isFailure(reopened))
      if (Result.isFailure(reopened)) assert.instanceOf(reopened.failure, PersistenceConfigError)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a bound marker copied to a different staging target", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-copied-marker-" })
      const firstRoot = path.join(parent, "first")
      const secondRoot = path.join(parent, "second")
      const first = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(firstRoot))
      const secondPaths = yield* decodeControlCenterDataPaths(secondRoot)
      const second = yield* prepareControlCenterDataRoot(secondPaths)
      const firstMarker = yield* fileSystem.readFileString(path.join(first.dataRoot, ".control-center-root"))
      yield* fileSystem.writeFileString(path.join(second.dataRoot, ".control-center-root"), firstMarker, {
        mode: 0o600
      })

      const reopened = yield* prepareControlCenterDataRoot(secondPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(reopened))
      if (Result.isFailure(reopened)) assert.instanceOf(reopened.failure, PersistenceConfigError)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks a durable orphan with a legacy unbound marker", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-legacy-orphan-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      yield* fileSystem.writeFileString(
        path.join(prepared.dataRoot, ".control-center-root"),
        DATA_ROOT_MARKER_V1_CONTENT,
        { mode: 0o600 }
      )
      yield* fileSystem.writeFileString(path.join(prepared.dataRoot, "durable-state"), "preserved")
      yield* fileSystem.remove(root)

      const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)
      const sibling = yield* prepareControlCenterDataRoot(
        yield* decodeControlCenterDataPaths(path.join(parent, "other"))
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(restarted))
      if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
      assert.isTrue(Result.isFailure(sibling))
      if (Result.isFailure(sibling)) assert.instanceOf(sibling.failure, PersistenceConfigError)
      assert.isFalse(yield* fileSystem.exists(root))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("does not mistake probe-shaped durable files for transient setup state", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const durableName of [".control-center-owner-backup", ".control-center-root.pending-backup"]) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-shaped-state-" })
        const root = path.join(parent, "data")
        const dataPaths = yield* decodeControlCenterDataPaths(root)
        const prepared = yield* prepareControlCenterDataRoot(dataPaths)
        yield* fileSystem.writeFileString(path.join(prepared.dataRoot, durableName), "preserved")
        yield* fileSystem.remove(root)

        const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

        assert.isTrue(Result.isFailure(restarted))
        if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
        assert.isFalse(yield* fileSystem.exists(root))
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks malformed protocol artifacts with exact random suffixes", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const randomSuffix = "a".repeat(32)
      const artifacts: ReadonlyArray<readonly [string, "directory" | "non-empty-file"]> = [
        [`.control-center-owner-${randomSuffix}`, "non-empty-file"],
        [`.control-center-owner-${randomSuffix}`, "directory"],
        [`.control-center-root.pending-${randomSuffix}`, "non-empty-file"],
        [`.control-center-root.pending-${randomSuffix}`, "directory"]
      ]
      for (const [artifactName, artifactType] of artifacts) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-artifact-" })
        const root = path.join(parent, "data")
        const dataPaths = yield* decodeControlCenterDataPaths(root)
        const prepared = yield* prepareControlCenterDataRoot(dataPaths)
        const artifactPath = path.join(prepared.dataRoot, artifactName)
        if (artifactType === "directory") {
          yield* fileSystem.makeDirectory(artifactPath, { mode: 0o700 })
        } else {
          yield* fileSystem.writeFileString(artifactPath, "not protocol state", { mode: 0o600 })
        }
        yield* fileSystem.remove(root)

        const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

        assert.isTrue(Result.isFailure(restarted))
        if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
        assert.isFalse(yield* fileSystem.exists(root))
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks malformed final marker objects even when no other staging entries exist", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const markerType of ["corrupt-file", "directory", "symlink"]) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-final-marker-" })
        const root = path.join(parent, "data")
        const stagingRoot = yield* fileSystem.makeTempDirectory({
          directory: parent,
          prefix: ".control-center-incoming-"
        })
        yield* fileSystem.chmod(stagingRoot, 0o700)
        const markerPath = path.join(stagingRoot, ".control-center-root")
        if (markerType === "directory") {
          yield* fileSystem.makeDirectory(markerPath, { mode: 0o700 })
          yield* fileSystem.writeFileString(path.join(markerPath, "durable-state"), "preserved")
        } else if (markerType === "symlink") {
          const externalMarker = path.join(parent, "external-marker")
          yield* fileSystem.writeFileString(externalMarker, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
          yield* fileSystem.symlink(externalMarker, markerPath)
        } else {
          yield* fileSystem.writeFileString(
            markerPath,
            "@knpkv/control-center:data-root:v2\nclaim-basename:ZGF0YQ==\ntarget-basename:dGFyZ2V0\n",
            { mode: 0o600 }
          )
        }

        const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root)).pipe(
          Effect.result
        )

        assert.isTrue(Result.isFailure(prepared))
        if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
        assert.isFalse(yield* fileSystem.exists(root))
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects noncanonical marker encodings without mutating staging state", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const markerPrefix = "@knpkv/control-center:data-root:v2\nclaim-basename:"
      for (
        const invalidCase of [
          "padded-base64url",
          "empty-claim",
          "path-like-target",
          "reserved-claim",
          "duplicate-target",
          "trailing-field",
          "control-character",
          "oversized"
        ]
      ) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-marker-codec-" })
        const root = path.join(parent, "data")
        const stagingRoot = yield* fileSystem.makeTempDirectory({
          directory: parent,
          prefix: ".control-center-incoming-"
        })
        yield* fileSystem.chmod(stagingRoot, 0o700)
        const stagingName = path.basename(stagingRoot)
        const encodedClaim = Encoding.encodeBase64Url("data")
        const encodedTarget = Encoding.encodeBase64Url(stagingName)
        const validMarker = `${markerPrefix}${encodedClaim}\ntarget-basename:${encodedTarget}\n`
        const invalidMarker = invalidCase === "padded-base64url"
          ? `${markerPrefix}${encodedClaim}=\ntarget-basename:${encodedTarget}\n`
          : invalidCase === "empty-claim"
          ? `${markerPrefix}\ntarget-basename:${encodedTarget}\n`
          : invalidCase === "path-like-target"
          ? `${markerPrefix}${encodedClaim}\ntarget-basename:${Encoding.encodeBase64Url("../target")}\n`
          : invalidCase === "reserved-claim"
          ? `${markerPrefix}${Encoding.encodeBase64Url(".control-center-incoming-claim")}\n` +
            `target-basename:${encodedTarget}\n`
          : invalidCase === "duplicate-target"
          ? `${validMarker.slice(0, -1)}\ntarget-basename:${encodedTarget}\n`
          : invalidCase === "trailing-field"
          ? `${validMarker}trailing:value\n`
          : invalidCase === "control-character"
          ? `${markerPrefix}${Encoding.encodeBase64Url("data\nother")}\ntarget-basename:${encodedTarget}\n`
          : `${validMarker}${"x".repeat(8_192)}`
        const markerPath = path.join(stagingRoot, ".control-center-root")
        yield* fileSystem.writeFileString(markerPath, invalidMarker, { mode: 0o600 })
        yield* fileSystem.chmod(markerPath, 0o600)
        const parentEntriesBefore = (yield* fileSystem.readDirectory(parent)).sort()
        const stagingEntriesBefore = (yield* fileSystem.readDirectory(stagingRoot)).sort()

        const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root)).pipe(
          Effect.result
        )

        assert.isTrue(Result.isFailure(prepared), invalidCase)
        if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
        assert.isFalse(yield* fileSystem.exists(root), invalidCase)
        assert.deepStrictEqual((yield* fileSystem.readDirectory(parent)).sort(), parentEntriesBefore, invalidCase)
        assert.deepStrictEqual((yield* fileSystem.readDirectory(stagingRoot)).sort(), stagingEntriesBefore, invalidCase)
        assert.strictEqual(yield* fileSystem.readFileString(markerPath), invalidMarker, invalidCase)
        assert.strictEqual((yield* fileSystem.stat(markerPath)).mode & 0o777, 0o600, invalidCase)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("allows fresh publication past empty and valid marker-only staging roots", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const stagingType of ["empty", "partial-pending", "valid-marker"]) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-disposable-" })
        const root = path.join(parent, "data")
        const stagingRoot = yield* fileSystem.makeTempDirectory({
          directory: parent,
          prefix: ".control-center-incoming-"
        })
        yield* fileSystem.chmod(stagingRoot, 0o700)
        if (stagingType !== "empty") {
          const markerPath = path.join(stagingRoot, ".control-center-root")
          yield* fileSystem.writeFileString(markerPath, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
          yield* fileSystem.chmod(markerPath, 0o600)
          if (stagingType === "partial-pending") {
            const pendingMarker = path.join(stagingRoot, `.control-center-root.pending-${"d".repeat(32)}`)
            yield* fileSystem.writeFileString(pendingMarker, "@knpkv/control-center:data-root:v2\nclaim-", {
              mode: 0o600
            })
            yield* fileSystem.chmod(pendingMarker, 0o600)
          }
        }

        const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root))

        assert.notStrictEqual(prepared.dataRoot, stagingRoot)
        assert.strictEqual(path.join(parent, yield* fileSystem.readLink(root)), prepared.dataRoot)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks empty reserved staging entries that are not canonical private directories", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const stagingType of ["wrong-mode", "symlink"]) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-empty-invalid-" })
        const root = path.join(parent, "data")
        const stagingName = `.control-center-incoming-${stagingType}`
        const stagingRoot = path.join(parent, stagingName)
        if (stagingType === "symlink") {
          const externalRoot = path.join(parent, "external")
          yield* fileSystem.makeDirectory(externalRoot, { mode: 0o700 })
          yield* fileSystem.symlink(path.basename(externalRoot), stagingRoot)
        } else {
          yield* fileSystem.makeDirectory(stagingRoot, { mode: 0o755 })
        }

        const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root)).pipe(
          Effect.result
        )

        assert.isTrue(Result.isFailure(prepared), stagingType)
        if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
        assert.isFalse(yield* fileSystem.exists(root), stagingType)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks complete marker-only artifacts copied from another staging target", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const artifactType of ["final", "pending"]) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-marker-target-" })
        const root = path.join(parent, "data")
        const stagingRoot = yield* fileSystem.makeTempDirectory({
          directory: parent,
          prefix: ".control-center-incoming-"
        })
        yield* fileSystem.chmod(stagingRoot, 0o700)
        const markerContent = boundMarkerContent("data", ".control-center-incoming-other")
        if (artifactType === "final") {
          const markerPath = path.join(stagingRoot, ".control-center-root")
          yield* fileSystem.writeFileString(markerPath, markerContent, { mode: 0o600 })
          yield* fileSystem.chmod(markerPath, 0o600)
        } else {
          const finalMarker = path.join(stagingRoot, ".control-center-root")
          yield* fileSystem.writeFileString(finalMarker, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
          yield* fileSystem.chmod(finalMarker, 0o600)
          const pendingMarker = path.join(stagingRoot, `.control-center-root.pending-${"f".repeat(32)}`)
          yield* fileSystem.writeFileString(pendingMarker, markerContent, { mode: 0o600 })
          yield* fileSystem.chmod(pendingMarker, 0o600)
        }

        const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root)).pipe(
          Effect.result
        )

        assert.isTrue(Result.isFailure(prepared), artifactType)
        if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
        assert.isFalse(yield* fileSystem.exists(root), artifactType)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("reinspects transient publication and cleanup directory views", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const race of ["losing-staging", "pending-rename", "probe-removal"]) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-reinspect-" })
        const root = path.join(parent, "data")
        const stagingRoot = race === "losing-staging"
          ? undefined
          : yield* fileSystem.makeTempDirectory({
            directory: parent,
            prefix: ".control-center-incoming-"
          })
        if (stagingRoot !== undefined) {
          yield* fileSystem.chmod(stagingRoot, 0o700)
          const markerPath = path.join(stagingRoot, ".control-center-root")
          yield* fileSystem.writeFileString(markerPath, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
          yield* fileSystem.chmod(markerPath, 0o600)
        }
        let reads = 0
        const disappearingEntry = race === "pending-rename"
          ? `.control-center-root.pending-${"3".repeat(32)}`
          : race === "probe-removal"
          ? `.control-center-owner-${"4".repeat(32)}`
          : ".control-center-incoming-disappearing"
        const racingFileSystem = FileSystem.make({
          ...fileSystem,
          readDirectory: (target) =>
            fileSystem.readDirectory(target).pipe(
              Effect.map((entries) => {
                const isRacingDirectory = race === "losing-staging" ? target === parent : target === stagingRoot
                if (!isRacingDirectory) return entries
                reads += 1
                return reads < 3 ? [...entries, disappearingEntry] : entries
              })
            )
        })

        const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root)).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFileSystem)
        )

        assert.strictEqual(reads, 3, race)
        assert.strictEqual(path.join(parent, yield* fileSystem.readLink(root)), prepared.dataRoot, race)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks durable orphan staging roots with damaged directory metadata", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-damaged-root-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      yield* fileSystem.writeFileString(path.join(prepared.dataRoot, "durable-state"), "preserved")
      yield* fileSystem.remove(root)
      yield* fileSystem.chmod(prepared.dataRoot, 0o755)

      const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(restarted))
      if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
      assert.isFalse(yield* fileSystem.exists(root))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks durable orphan staging roots with a damaged marker", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const damage of ["mode", "content"]) {
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: `control-center-cli-damaged-marker-${damage}-`
        })
        const root = path.join(parent, "data")
        const dataPaths = yield* decodeControlCenterDataPaths(root)
        const prepared = yield* prepareControlCenterDataRoot(dataPaths)
        const markerPath = path.join(prepared.dataRoot, ".control-center-root")
        yield* fileSystem.writeFileString(path.join(prepared.dataRoot, "durable-state"), "preserved")
        yield* fileSystem.remove(root)
        if (damage === "mode") {
          yield* fileSystem.chmod(markerPath, 0o644)
        } else {
          yield* fileSystem.writeFileString(markerPath, "damaged\n", { mode: 0o600 })
        }

        const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

        assert.isTrue(Result.isFailure(restarted))
        if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
        assert.isFalse(yield* fileSystem.exists(root))
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("blocks a durable staging root that cannot be read", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-unreadable-root-" })
      const root = path.join(parent, "data")
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const prepared = yield* prepareControlCenterDataRoot(dataPaths)
      yield* fileSystem.writeFileString(path.join(prepared.dataRoot, "durable-state"), "preserved")
      yield* fileSystem.remove(root)
      yield* fileSystem.chmod(prepared.dataRoot, 0o000)

      const restarted = yield* prepareControlCenterDataRoot(dataPaths).pipe(
        Effect.result,
        Effect.ensuring(fileSystem.chmod(prepared.dataRoot, 0o700).pipe(Effect.ignore))
      )

      assert.isTrue(Result.isFailure(restarted))
      if (Result.isFailure(restarted)) assert.instanceOf(restarted.failure, PersistenceConfigError)
      assert.isFalse(yield* fileSystem.exists(root))
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

  it.effect("rejects malformed pending artifacts before deleting any valid pending marker", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      for (const damage of ["content", "mode", "owner", "type"]) {
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-pending-strict-" })
        yield* fileSystem.chmod(root, 0o700)
        const markerPath = path.join(root, ".control-center-root")
        yield* fileSystem.writeFileString(markerPath, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
        yield* fileSystem.chmod(markerPath, 0o600)
        const validPending = path.join(root, `.control-center-root.pending-${"1".repeat(32)}`)
        const invalidPending = path.join(root, `.control-center-root.pending-${"2".repeat(32)}`)
        yield* fileSystem.writeFileString(validPending, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
        yield* fileSystem.chmod(validPending, 0o600)
        if (damage === "type") {
          yield* fileSystem.makeDirectory(invalidPending, { mode: 0o700 })
        } else {
          yield* fileSystem.writeFileString(
            invalidPending,
            damage === "content" ? "invalid\n" : DATA_ROOT_MARKER_V1_CONTENT,
            { mode: damage === "mode" ? 0o644 : 0o600 }
          )
          yield* fileSystem.chmod(invalidPending, damage === "mode" ? 0o644 : 0o600)
        }
        const entriesBefore = (yield* fileSystem.readDirectory(root)).sort()
        const damagedFileSystem = damage === "owner"
          ? FileSystem.make({
            ...fileSystem,
            stat: (target) =>
              fileSystem.stat(target).pipe(
                Effect.map((info) =>
                  target === invalidPending
                    ? { ...info, uid: Option.map(info.uid, (uid) => uid + 1) }
                    : info
                )
              )
          })
          : fileSystem

        const prepared = yield* prepareControlCenterDataRoot(yield* decodeControlCenterDataPaths(root)).pipe(
          Effect.provideService(FileSystem.FileSystem, damagedFileSystem),
          Effect.result
        )

        assert.isTrue(Result.isFailure(prepared), damage)
        if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
        assert.deepStrictEqual((yield* fileSystem.readDirectory(root)).sort(), entriesBefore, damage)
        assert.strictEqual(yield* fileSystem.readFileString(markerPath), DATA_ROOT_MARKER_V1_CONTENT, damage)
        assert.isTrue(yield* fileSystem.exists(validPending), damage)
        assert.isTrue(yield* fileSystem.exists(invalidPending), damage)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a truncated final marker without deleting pending recovery evidence", () =>
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
      yield* fileSystem.writeFileString(pendingMarkerPath, DATA_ROOT_MARKER_V1_CONTENT, {
        mode: 0o600
      })
      yield* fileSystem.chmod(pendingMarkerPath, 0o600)
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      const entriesBefore = (yield* fileSystem.readDirectory(root)).sort()

      const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(prepared))
      if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
      assert.deepStrictEqual((yield* fileSystem.readDirectory(root)).sort(), entriesBefore)
      assert.strictEqual(yield* fileSystem.readFileString(markerPath), "@knpkv/control-center:data-root:")
      assert.strictEqual(yield* fileSystem.readFileString(pendingMarkerPath), DATA_ROOT_MARKER_V1_CONTENT)
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

  it.effect("does not adopt a direct legacy database with a malformed pending marker", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-cli-legacy-pending-" })
      yield* fileSystem.chmod(root, 0o700)
      const dataPaths = yield* decodeControlCenterDataPaths(root)
      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.validateMigrationLedger
      }).pipe(Effect.provide(databaseLayer(dataPaths.persistenceConfig)), Effect.scoped)
      const validPending = path.join(root, `.control-center-root.pending-${"5".repeat(32)}`)
      const invalidPending = path.join(root, `.control-center-root.pending-${"6".repeat(32)}`)
      yield* fileSystem.writeFileString(validPending, DATA_ROOT_MARKER_V1_CONTENT, { mode: 0o600 })
      yield* fileSystem.chmod(validPending, 0o600)
      yield* fileSystem.writeFileString(invalidPending, "invalid\n", { mode: 0o600 })
      yield* fileSystem.chmod(invalidPending, 0o600)
      const entriesBefore = (yield* fileSystem.readDirectory(root)).sort()

      const prepared = yield* prepareControlCenterDataRoot(dataPaths).pipe(Effect.result)

      assert.isTrue(Result.isFailure(prepared))
      if (Result.isFailure(prepared)) assert.instanceOf(prepared.failure, PersistenceConfigError)
      assert.deepStrictEqual((yield* fileSystem.readDirectory(root)).sort(), entriesBefore)
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".control-center-root")))
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
