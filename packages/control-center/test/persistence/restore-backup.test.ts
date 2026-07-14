import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Option, Path, Ref, Result } from "effect"

import { decodeControlCenterDataPaths, prepareControlCenterDataRoot } from "../../src/server/cliConfiguration.js"
import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  Persistence,
  persistenceLayer,
  ReproducibleContentUnavailableError,
  restoreBackup
} from "../../src/server/persistence/index.js"
import { blobPath } from "../../src/server/persistence/object-store/BlobPath.js"
import {
  assertOwnerOnlyTree,
  makeContentVerifiedArchive,
  makeEmptyVerifiedArchive,
  stagingEntries
} from "./backup-fixtures.js"
import { fixtureTimestamps, fixtureWorkspaceIds } from "./fixtures.js"

const encoder = new TextEncoder()

const withSync = (file: FileSystem.File, sync: FileSystem.File["sync"]): FileSystem.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  fd: file.fd,
  read: file.read,
  readAlloc: file.readAlloc,
  seek: file.seek,
  stat: file.stat,
  sync,
  truncate: file.truncate,
  write: file.write,
  writeAll: file.writeAll
})

const withStat = (file: FileSystem.File, stat: FileSystem.File["stat"]): FileSystem.File => ({
  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
  fd: file.fd,
  read: file.read,
  readAlloc: file.readAlloc,
  seek: file.seek,
  stat,
  sync: file.sync,
  truncate: file.truncate,
  write: file.write,
  writeAll: file.writeAll
})

const restoreStagingRoot = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  destination: string
) =>
  fileSystem.realPath(path.dirname(destination)).pipe(
    Effect.map((root) =>
      path.basename(root).startsWith(".control-center-incoming-") ? Option.some(root) : Option.none()
    ),
    Effect.orElseSucceed(() => Option.none<string>())
  )

describe("restore backup", () => {
  it.effect("publishes a fresh relative-symlink claim without exposing its physical paths", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-paths-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const configuredRoot = path.join(root, "restored")
      const restored = yield* restoreBackup({ archiveRoot, configuredDataRoot: configuredRoot })
      assert.strictEqual(restored.verification._tag, "Complete")
      assert.strictEqual(restored.configuredDataRoot, configuredRoot)
      assert.deepStrictEqual(Object.keys(restored).sort(), ["configuredDataRoot", "verification"])
      const claimTarget = yield* fileSystem.readLink(configuredRoot)
      assert.match(claimTarget, /^\.control-center-incoming-/u)
      assert.notInclude(JSON.stringify(restored), claimTarget)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("creates, hardens, and durably syncs each missing configured-root parent", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-parents-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const first = path.join(root, "parent-a")
      const second = path.join(first, "parent-b")
      const configuredRoot = path.join(second, "restored")
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (event: string) => Ref.update(events, (all) => [...all, event])
      const recording = FileSystem.make({
        ...fileSystem,
        chmod: (target, mode) => record(`chmod:${target}:${mode}`).pipe(Effect.andThen(fileSystem.chmod(target, mode))),
        makeDirectory: (target, options) =>
          record(`mkdir:${target}`).pipe(Effect.andThen(fileSystem.makeDirectory(target, options))),
        open: (target, options) => record(`open:${target}`).pipe(Effect.andThen(fileSystem.open(target, options)))
      })
      yield* restoreBackup({ archiveRoot, configuredDataRoot: configuredRoot }).pipe(
        Effect.provideService(FileSystem.FileSystem, recording)
      )
      const recorded = yield* Ref.get(events)
      for (const directory of [first, second]) {
        const mkdir = recorded.indexOf(`mkdir:${directory}`)
        const chmod = recorded.indexOf(`chmod:${directory}:${0o700}`)
        const sync = recorded.indexOf(`open:${directory}`)
        assert.isAtLeast(mkdir, 0)
        assert.isBelow(mkdir, chmod)
        assert.isBelow(chmod, sync)
        assert.strictEqual((yield* fileSystem.stat(directory)).mode & 0o777, 0o700)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("restores every owned directory and file with private modes", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeContentVerifiedArchive("control-center-restore-modes-")
      const path = yield* Path.Path
      const restored = yield* restoreBackup({
        archiveRoot,
        configuredDataRoot: path.join(root, "restored")
      })
      const prepared = yield* prepareControlCenterDataRoot(
        yield* decodeControlCenterDataPaths(restored.configuredDataRoot)
      )
      yield* assertOwnerOnlyTree(prepared.dataRoot)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("survives data-root preparation and database reopen after restart", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-restart-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const restored = yield* restoreBackup({
        archiveRoot,
        configuredDataRoot: path.join(root, "restored")
      })
      const restarted = yield* prepareControlCenterDataRoot(
        yield* decodeControlCenterDataPaths(restored.configuredDataRoot)
      )
      assert.notStrictEqual(restarted.dataRoot, restored.configuredDataRoot)
      assert.strictEqual(yield* fileSystem.readLink(restored.configuredDataRoot), path.basename(restarted.dataRoot))
      yield* Effect.gen(function*() {
        yield* Database
      }).pipe(Effect.provide(databaseLayer(restarted.persistenceConfig)), Effect.scoped)
      assert.isFalse(
        yield* fileSystem.exists(path.join(restarted.dataRoot, "backups", "pre-migration"))
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects an existing directory without changing its contents", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-existing-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "occupied")
      const sentinel = path.join(target, "sentinel")
      yield* fileSystem.makeDirectory(target)
      yield* fileSystem.writeFileString(sentinel, "preserve me")
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupInputError")
      if (Result.isFailure(result) && result.failure._tag === "BackupInputError") {
        assert.strictEqual(result.failure.reason, "already-exists")
      }
      assert.strictEqual(yield* fileSystem.readFileString(sentinel), "preserve me")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects an existing dangling symlink without replacing it", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-dangling-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "dangling")
      yield* fileSystem.symlink("missing-owner", target)
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupInputError")
      if (Result.isFailure(result) && result.failure._tag === "BackupInputError") {
        assert.strictEqual(result.failure.reason, "already-exists")
      }
      assert.strictEqual(yield* fileSystem.readLink(target), "missing-owner")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("preserves racer-owned data when claim publication loses the target race", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-race-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "raced")
      const sentinel = path.join(target, "racer-owned")
      const racing = FileSystem.make({
        ...fileSystem,
        symlink: (source, destination) =>
          path.basename(destination) === path.basename(target)
            ? fileSystem
              .makeDirectory(target)
              .pipe(
                Effect.andThen(fileSystem.writeFileString(sentinel, "preserve racer")),
                Effect.andThen(fileSystem.symlink(source, destination))
              )
            : fileSystem.symlink(source, destination)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "BackupInputError")
      }
      if (Result.isFailure(result) && result.failure._tag === "BackupInputError") {
        assert.strictEqual(result.failure.reason, "target-raced")
      }
      assert.strictEqual(yield* fileSystem.readFileString(sentinel), "preserve racer")
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-incoming-"), [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains a resolvable same-target claim when AlreadyExists ownership is ambiguous", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-same-target-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const sameTargetRace = FileSystem.make({
        ...fileSystem,
        symlink: (source, destination) =>
          path.basename(destination) === path.basename(target)
            ? fileSystem.symlink(source, destination).pipe(
              Effect.andThen(fileSystem.symlink(source, destination))
            )
            : fileSystem.symlink(source, destination)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, sameTargetRace),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      const stageName = yield* fileSystem.readLink(target)
      assert.strictEqual(path.basename(stageName), stageName)
      assert.isTrue(yield* fileSystem.exists(path.join(root, stageName)))
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-incoming-"), [stageName])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rolls back a claim when the pinned stage is substituted during publication", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-stage-race-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const displaced = path.join(root, "displaced-pinned-stage")
      const racing = FileSystem.make({
        ...fileSystem,
        symlink: (source, destination) =>
          path.basename(destination) === path.basename(target)
            ? fileSystem.rename(path.join(root, source), displaced).pipe(
              Effect.andThen(fileSystem.makeDirectory(path.join(root, source), { mode: 0o700 })),
              Effect.andThen(fileSystem.writeFileString(
                path.join(root, source, "racer-owned"),
                "preserve me"
              )),
              Effect.andThen(fileSystem.symlink(source, destination))
            )
            : fileSystem.symlink(source, destination)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      assert.isFalse(yield* fileSystem.exists(target))
      const retained = yield* stagingEntries(fileSystem, root, ".control-center-incoming-")
      assert.strictEqual(retained.length, 1)
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, retained[0] ?? "missing", "racer-owned")),
        "preserve me"
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects archive and restore-root overlap in either nesting direction", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-overlap-")
      const path = yield* Path.Path
      for (const target of [path.join(archiveRoot, "nested"), root]) {
        const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(Effect.result)
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupInputError")
        if (Result.isFailure(result) && result.failure._tag === "BackupInputError") {
          assert.strictEqual(result.failure.reason, "overlap")
        }
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("detects overlap through a symlink alias without changing the archive", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-alias-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const before = yield* fileSystem.readDirectory(archiveRoot)
      const alias = path.join(root, "archive-alias")
      yield* fileSystem.symlink(path.basename(archiveRoot), alias)
      const result = yield* restoreBackup({
        archiveRoot,
        configuredDataRoot: path.join(alias, "nested")
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupInputError")
      if (Result.isFailure(result) && result.failure._tag === "BackupInputError") {
        assert.strictEqual(result.failure.reason, "overlap")
      }
      assert.deepStrictEqual(yield* fileSystem.readDirectory(archiveRoot), before)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a configured-parent identity swap and removes its unclaimed staging root", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-parent-race-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const claimedParent = path.join(root, "claimed-parent")
      const swappedParent = path.join(root, "swapped-parent")
      const alias = path.join(root, "parent-alias")
      yield* fileSystem.makeDirectory(claimedParent)
      yield* fileSystem.makeDirectory(swappedParent)
      yield* fileSystem.symlink(path.basename(claimedParent), alias)
      const swapping = FileSystem.make({
        ...fileSystem,
        makeTempDirectory: (options) =>
          options?.prefix === ".control-center-incoming-"
            ? fileSystem.makeTempDirectory(options).pipe(
              Effect.tap(() => fileSystem.remove(alias)),
              Effect.tap(() => fileSystem.symlink(path.basename(swappedParent), alias))
            )
            : fileSystem.makeTempDirectory(options)
      })
      const result = yield* restoreBackup({
        archiveRoot,
        configuredDataRoot: path.join(alias, "restored")
      }).pipe(Effect.provideService(FileSystem.FileSystem, swapping), Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, claimedParent, ".control-center-incoming-"), [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rolls back an exact configured-parent alias swap during claim publication", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-alias-swap-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const claimedParent = path.join(root, "claimed-parent")
      const swappedParent = path.join(root, "swapped-parent")
      const alias = path.join(root, "parent-alias")
      yield* fileSystem.makeDirectory(claimedParent)
      yield* fileSystem.makeDirectory(swappedParent)
      yield* fileSystem.symlink(path.basename(claimedParent), alias)
      const target = path.join(alias, "restored")
      const archiveEntries = yield* fileSystem.readDirectory(archiveRoot)
      const swapping = FileSystem.make({
        ...fileSystem,
        symlink: (source, destination) =>
          path.basename(destination) === path.basename(target)
            ? fileSystem.remove(alias).pipe(
              Effect.andThen(fileSystem.symlink(path.basename(swappedParent), alias)),
              Effect.andThen(fileSystem.symlink(source, destination))
            )
            : fileSystem.symlink(source, destination)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, swapping),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-parent-changed")
      }
      assert.isFalse(yield* fileSystem.exists(path.join(claimedParent, "restored")))
      assert.isFalse(yield* fileSystem.exists(path.join(swappedParent, "restored")))
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, claimedParent, ".control-center-incoming-"), [])
      assert.deepStrictEqual(yield* fileSystem.readDirectory(archiveRoot), archiveEntries)
      const retry = yield* restoreBackup({
        archiveRoot,
        configuredDataRoot: path.join(claimedParent, "stable-retry")
      })
      assert.strictEqual(retry.verification._tag, "Complete")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a reserved incoming basename before making filesystem changes", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-reserved-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const before = yield* fileSystem.readDirectory(root)
      const result = yield* restoreBackup({
        archiveRoot,
        configuredDataRoot: path.join(root, ".control-center-incoming-forbidden")
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupInputError")
      if (Result.isFailure(result) && result.failure._tag === "BackupInputError") {
        assert.strictEqual(result.failure.reason, "invalid-path")
      }
      assert.deepStrictEqual(yield* fileSystem.readDirectory(root), before)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("removes unclaimed restore staging when interrupted during database copy", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-copy-interrupt-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const started = yield* Deferred.make<void>()
      const interrupting = FileSystem.make({
        ...fileSystem,
        copyFile: (source, destination) =>
          restoreStagingRoot(fileSystem, path, destination).pipe(
            Effect.flatMap((staging) =>
              Option.isSome(staging) && destination.endsWith("control-center.db")
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : fileSystem.copyFile(source, destination)
            )
          )
      })
      const fiber = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, interrupting),
        Effect.forkScoped
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
      yield* Effect.yieldNow
      assert.isFalse(yield* fileSystem.exists(target))
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-incoming-"), [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains pinned staging and surfaces uncertainty when interrupt cleanup cannot sync", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-interrupt-sync-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const started = yield* Deferred.make<void>()
      const failing = FileSystem.make({
        ...fileSystem,
        copyFile: (source, destination) =>
          restoreStagingRoot(fileSystem, path, destination).pipe(
            Effect.flatMap((staging) =>
              Option.isSome(staging) && destination.endsWith("control-center.db")
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                : fileSystem.copyFile(source, destination)
            )
          ),
        open: (opened, options) =>
          fileSystem.open(opened, options).pipe(
            Effect.map((handle) =>
              opened === root
                ? withSync(handle, fileSystem.stat(path.join(root, "missing-cleanup-sync")).pipe(Effect.asVoid))
                : handle
            )
          )
      })
      const fiber = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, failing),
        Effect.forkScoped
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause)
        assert.isTrue(Option.isSome(failure))
        if (Option.isSome(failure)) {
          assert.strictEqual(failure.value._tag, "BackupStorageError")
          if (failure.value._tag === "BackupStorageError") {
            assert.strictEqual(failure.value.operation, "publish-restore-cleanup-uncertain")
          }
        }
      }
      assert.strictEqual((yield* stagingEntries(fileSystem, root, ".control-center-incoming-")).length, 1)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains unverified staging and reports cleanup uncertainty when interrupted before identity capture", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-identity-interrupt-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const started = yield* Deferred.make<void>()
      const interrupting = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          opened.includes(".control-center-incoming-")
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : fileSystem.open(opened, options)
      })
      const fiber = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, interrupting),
        Effect.forkScoped
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause)
        assert.isTrue(Option.isSome(failure))
        if (Option.isSome(failure)) {
          assert.strictEqual(failure.value._tag, "BackupStorageError")
          if (failure.value._tag === "BackupStorageError") {
            assert.strictEqual(failure.value.operation, "publish-restore-cleanup-uncertain")
          }
        }
      }
      assert.isFalse(yield* fileSystem.exists(target))
      assert.strictEqual((yield* stagingEntries(fileSystem, root, ".control-center-incoming-")).length, 1)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains unverified staging when opening it fails before identity capture", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-identity-open-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const failingOpen = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          opened.includes(".control-center-incoming-")
            ? fileSystem.open(path.join(root, "missing-staging-open"), options)
            : fileSystem.open(opened, options)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingOpen),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      assert.isFalse(yield* fileSystem.exists(target))
      assert.strictEqual((yield* stagingEntries(fileSystem, root, ".control-center-incoming-")).length, 1)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains unverified staging when stat fails before identity capture", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-identity-stat-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const failingStat = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          fileSystem
            .open(opened, options)
            .pipe(
              Effect.map((handle) =>
                opened.includes(".control-center-incoming-")
                  ? withStat(handle, fileSystem.stat(path.join(root, "missing-staging-stat")))
                  : handle
              )
            )
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingStat),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      assert.isFalse(yield* fileSystem.exists(target))
      assert.strictEqual((yield* stagingEntries(fileSystem, root, ".control-center-incoming-")).length, 1)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains racer data when staging is substituted before identity pinning", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-pre-pin-swap-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const substituting = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          opened.includes(".control-center-incoming-")
            ? fileSystem.open(opened, options).pipe(
              Effect.tap(() =>
                fileSystem.realPath(opened).pipe(
                  Effect.flatMap((canonical) =>
                    fileSystem.rename(canonical, path.join(root, "displaced-pre-pin-stage")).pipe(
                      Effect.andThen(fileSystem.makeDirectory(canonical, { mode: 0o700 })),
                      Effect.andThen(fileSystem.writeFileString(path.join(canonical, "racer-owned"), "preserve me"))
                    )
                  )
                )
              )
            )
            : fileSystem.open(opened, options)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, substituting),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      assert.isFalse(yield* fileSystem.exists(target))
      const retained = yield* stagingEntries(fileSystem, root, ".control-center-incoming-")
      assert.strictEqual(retained.length, 1)
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, retained[0] ?? "missing", "racer-owned")),
        "preserve me"
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rolls back claim and staging when the first post-claim parent sync fails", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-sync-once-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const parentOpens = yield* Ref.make(0)
      const failingOnce = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          opened === root
            ? fileSystem.open(opened, options).pipe(
              Effect.map((handle) =>
                withSync(
                  handle,
                  Ref.getAndUpdate(parentOpens, (count) => count + 1).pipe(
                    Effect.flatMap((count) =>
                      count === 0
                        ? fileSystem.stat(path.join(root, "missing-sync")).pipe(Effect.asVoid)
                        : handle.sync
                    )
                  )
                )
              )
            )
            : fileSystem.open(opened, options)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingOnce),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-post-claim-sync-failed")
      }
      assert.isFalse(yield* fileSystem.exists(target))
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-incoming-"), [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains proven-owned staging when post-claim rollback cannot be durably synced", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-sync-always-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const alwaysFailParentSync = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          opened === root
            ? fileSystem.open(opened, options).pipe(
              Effect.map((handle) =>
                withSync(
                  handle,
                  fileSystem.stat(path.join(root, "missing-sync")).pipe(Effect.asVoid)
                )
              )
            )
            : fileSystem.open(opened, options)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, alwaysFailParentSync),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      assert.isFalse(yield* fileSystem.exists(target))
      const retained = yield* stagingEntries(fileSystem, root, ".control-center-incoming-")
      assert.strictEqual(retained.length, 1)
      const retry = yield* restoreBackup({ archiveRoot, configuredDataRoot: target })
      assert.strictEqual(retry.verification._tag, "Complete")
      assert.isTrue(yield* fileSystem.exists(path.join(root, retained[0] ?? "missing")))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains a valid claimed target when cleanup cannot establish claim ownership", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-uncertain-claim-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const uncertain = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          opened === root
            ? fileSystem.open(opened, options).pipe(
              Effect.map((handle) =>
                withSync(
                  handle,
                  fileSystem.stat(path.join(root, "missing-sync")).pipe(Effect.asVoid)
                )
              )
            )
            : fileSystem.open(opened, options),
        readLink: (opened) =>
          path.basename(opened) === path.basename(target)
            ? fileSystem.readLink(path.join(root, "missing-observation"))
            : fileSystem.readLink(opened)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, uncertain),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      const retained = yield* fileSystem.readLink(target)
      assert.isTrue(yield* fileSystem.exists(path.join(root, retained)))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("retains staging when rollback observes a racer-owned dangling claim", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-dangling-rollback-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const parentSyncs = yield* Ref.make(0)
      const racing = FileSystem.make({
        ...fileSystem,
        open: (opened, options) =>
          opened === root
            ? fileSystem.open(opened, options).pipe(
              Effect.map((handle) =>
                withSync(
                  handle,
                  Ref.getAndUpdate(parentSyncs, (count) => count + 1).pipe(
                    Effect.flatMap((count) =>
                      count === 0
                        ? fileSystem.stat(path.join(root, "missing-sync")).pipe(Effect.asVoid)
                        : handle.sync
                    )
                  )
                )
              )
            )
            : fileSystem.open(opened, options),
        readLink: (opened) =>
          path.basename(opened) === path.basename(target)
            ? fileSystem.exists(target).pipe(
              Effect.flatMap((exists) =>
                exists
                  ? fileSystem.remove(target).pipe(
                    Effect.andThen(fileSystem.symlink("missing-stage", target)),
                    Effect.andThen(fileSystem.readLink(opened))
                  )
                  : fileSystem.readLink(opened)
              )
            )
            : fileSystem.readLink(opened)
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      assert.strictEqual(yield* fileSystem.readLink(target), "missing-stage")
      assert.strictEqual((yield* stagingEntries(fileSystem, root, ".control-center-incoming-")).length, 1)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("does not remove a racer-substituted staging directory during cleanup", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeEmptyVerifiedArchive("control-center-restore-substitution-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const before = yield* fileSystem.readDirectory(root)
      const substitution = FileSystem.make({
        ...fileSystem,
        copyFile: (source, destination) =>
          restoreStagingRoot(fileSystem, path, destination).pipe(
            Effect.flatMap((staging) =>
              Option.isSome(staging) && destination.endsWith("control-center.db")
                ? fileSystem.rename(staging.value, path.join(root, "displaced-owned-stage")).pipe(
                  Effect.andThen(fileSystem.makeDirectory(staging.value, { mode: 0o700 })),
                  Effect.andThen(fileSystem.writeFileString(path.join(staging.value, "racer-owned"), "preserve me")),
                  Effect.andThen(fileSystem.copyFile(path.join(root, "missing-source"), destination))
                )
                : fileSystem.copyFile(source, destination)
            )
          )
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, substitution),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
      if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
        assert.strictEqual(result.failure.operation, "publish-restore-cleanup-uncertain")
      }
      assert.isFalse(yield* fileSystem.exists(target))
      const created = (yield* fileSystem.readDirectory(root)).filter(
        (entry) => !before.includes(entry) && entry.startsWith(".control-center-incoming-")
      )
      assert.strictEqual(created.length, 1)
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, created[0] ?? "missing", "racer-owned")),
        "preserve me"
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a database copy changed before claim publication", () =>
    Effect.gen(function*() {
      const { archiveRoot, root } = yield* makeContentVerifiedArchive("control-center-restore-db-tamper-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const tampering = FileSystem.make({
        ...fileSystem,
        copyFile: (source, destination) =>
          restoreStagingRoot(fileSystem, path, destination).pipe(
            Effect.flatMap((staging) =>
              fileSystem.copyFile(source, destination).pipe(
                Effect.andThen(
                  Option.isSome(staging) && destination.endsWith("control-center.db")
                    ? fileSystem.writeFileString(destination, "tampered", { mode: 0o600 })
                    : Effect.void
                )
              )
            )
          )
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, tampering),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupIntegrityError")
      if (Result.isFailure(result) && result.failure._tag === "BackupIntegrityError") {
        assert.strictEqual(result.failure.reason, "database-digest-mismatch")
      }
      assert.isFalse(yield* fileSystem.exists(target))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a durable-blob copy changed before claim publication", () =>
    Effect.gen(function*() {
      const { archiveRoot, digests, root } = yield* makeContentVerifiedArchive("control-center-restore-blob-tamper-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const tampering = FileSystem.make({
        ...fileSystem,
        copyFile: (source, destination) =>
          fileSystem
            .copyFile(source, destination)
            .pipe(
              Effect.andThen(
                path.basename(destination) === digests.durable
                  ? fileSystem.writeFileString(destination, "tampered", { mode: 0o600 })
                  : Effect.void
              )
            )
      })
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, tampering),
        Effect.result
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupIntegrityError")
      if (Result.isFailure(result) && result.failure._tag === "BackupIntegrityError") {
        assert.strictEqual(result.failure.reason, "blob-corrupt")
      }
      assert.isFalse(yield* fileSystem.exists(target))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("restores cache gaps as restart-visible refetch state and repairs regenerated bytes", () =>
    Effect.gen(function*() {
      const { archiveRoot, digests, root } = yield* makeContentVerifiedArchive("control-center-restore-cache-gap-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.remove(
        blobPath(path, path.join(archiveRoot, "blobs"), fixtureWorkspaceIds.alpha, digests.cache).file
      )
      const configuredDataRoot = path.join(root, "restored")
      const restored = yield* restoreBackup({ archiveRoot, configuredDataRoot })
      assert.strictEqual(restored.verification._tag, "RecoverableCacheGaps")
      const prepared = yield* prepareControlCenterDataRoot(
        yield* decodeControlCenterDataPaths(restored.configuredDataRoot)
      )
      assert.isFalse(
        yield* fileSystem.exists(
          blobPath(path, prepared.persistenceConfig.blobRoot, fixtureWorkspaceIds.alpha, digests.cache).file
        )
      )
      assert.isTrue(
        yield* fileSystem.exists(
          blobPath(path, prepared.persistenceConfig.blobRoot, fixtureWorkspaceIds.alpha, digests.durable).file
        )
      )

      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        const metadata = yield* persistence.content.getMetadata(fixtureWorkspaceIds.alpha, digests.cache)
        assert.strictEqual(metadata.storageClass, "reproducible-cache")

        const unavailable = yield* persistence.content.readAll(fixtureWorkspaceIds.alpha, digests.cache).pipe(
          Effect.result
        )
        assert.isTrue(Result.isFailure(unavailable))
        if (Result.isFailure(unavailable)) {
          assert.strictEqual(unavailable.failure._tag, "ReproducibleContentUnavailableError")
          assert.instanceOf(unavailable.failure, ReproducibleContentUnavailableError)
          if (unavailable.failure._tag === "ReproducibleContentUnavailableError") {
            assert.strictEqual(unavailable.failure.reason, "missing")
            assert.strictEqual(unavailable.failure.recovery, "refetch")
          }
        }

        assert.deepStrictEqual(
          yield* persistence.content.readAll(fixtureWorkspaceIds.alpha, digests.durable),
          encoder.encode("authoritative release evidence")
        )
        const repaired = yield* persistence.content.put(fixtureWorkspaceIds.alpha, {
          bytes: encoder.encode("reproducible provider cache"),
          classification: "reproducible-cache",
          createdAt: fixtureTimestamps.created,
          mimeType: "text/plain"
        })
        assert.isTrue(repaired.stored)
        assert.strictEqual(repaired.metadata.digest, digests.cache)
      }).pipe(Effect.provide(persistenceLayer(prepared.persistenceConfig)), Effect.scoped)

      yield* Effect.gen(function*() {
        const persistence = yield* Persistence
        assert.deepStrictEqual(
          yield* persistence.content.readAll(fixtureWorkspaceIds.alpha, digests.cache),
          encoder.encode("reproducible provider cache")
        )
      }).pipe(Effect.provide(persistenceLayer(prepared.persistenceConfig)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("syncs restored data and publishes the owner marker before publishing the claim", () =>
    Effect.gen(function*() {
      const { archiveRoot, digests, root } = yield* makeContentVerifiedArchive("control-center-restore-order-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const target = path.join(root, "restored")
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (event: string) => Ref.update(events, (all) => [...all, event])
      const recording = FileSystem.make({
        ...fileSystem,
        chmod: (opened, mode) => record(`chmod:${opened}:${mode}`).pipe(Effect.andThen(fileSystem.chmod(opened, mode))),
        copyFile: (source, destination) =>
          record(`copy:${destination}`).pipe(Effect.andThen(fileSystem.copyFile(source, destination))),
        makeDirectory: (directory, options) =>
          record(`mkdir:${directory}`).pipe(Effect.andThen(fileSystem.makeDirectory(directory, options))),
        open: (opened, options) => record(`open:${opened}`).pipe(Effect.andThen(fileSystem.open(opened, options))),
        rename: (source, destination) =>
          record(`rename:${destination}`).pipe(Effect.andThen(fileSystem.rename(source, destination))),
        symlink: (source, destination) =>
          record(`symlink:${destination}`).pipe(Effect.andThen(fileSystem.symlink(source, destination)))
      })
      const restored = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(
        Effect.provideService(FileSystem.FileSystem, recording)
      )
      const all = yield* Ref.get(events)
      const claim = all.findIndex((event) => {
        if (!event.startsWith("symlink:")) return false
        return path.basename(event.slice("symlink:".length)) === path.basename(target)
      })
      const marker = all.findIndex((event) => event.endsWith("/.control-center-root"))
      const databaseCopy = all.findIndex((event) => event.startsWith("copy:") && event.endsWith("/control-center.db"))
      const durableCopy = all.findIndex((event) => event.endsWith(`/${digests.durable}`))
      assert.isAtLeast(claim, 0)
      assert.isAtLeast(marker, 0)
      assert.isBelow(databaseCopy, marker)
      assert.isBelow(durableCopy, marker)
      assert.isBelow(marker, claim)
      const prepared = yield* prepareControlCenterDataRoot(
        yield* decodeControlCenterDataPaths(restored.configuredDataRoot)
      )
      const blobRoot = prepared.persistenceConfig.blobRoot
      const durablePath = blobPath(path, blobRoot, fixtureWorkspaceIds.alpha, digests.durable)
      for (
        const directory of [
          blobRoot,
          path.join(blobRoot, "objects"),
          durablePath.workspaceDirectory,
          path.join(durablePath.workspaceDirectory, "sha256"),
          path.dirname(durablePath.objectDirectory),
          durablePath.objectDirectory
        ]
      ) {
        const relative = path.relative(prepared.dataRoot, directory)
        const suffix = relative.length === 0 ? "" : `/${relative}`
        const chmod = all.findIndex((event) => event.startsWith("chmod:") && event.endsWith(`${suffix}:${0o700}`))
        const sync = all.findIndex((event) => event.startsWith("open:") && event.endsWith(suffix))
        assert.isAtLeast(chmod, 0)
        assert.isAtLeast(sync, 0)
        assert.isBelow(chmod, sync)
        assert.isBelow(sync, claim)
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("verifies a missing durable blob before creating destination state", () =>
    Effect.gen(function*() {
      const { archiveRoot, digests, root } = yield* makeContentVerifiedArchive(
        "control-center-restore-missing-durable-"
      )
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.remove(
        blobPath(path, path.join(archiveRoot, "blobs"), fixtureWorkspaceIds.alpha, digests.durable).file
      )
      const before = yield* fileSystem.readDirectory(root)
      const target = path.join(root, "restored")
      const result = yield* restoreBackup({ archiveRoot, configuredDataRoot: target }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      assert.isFalse(yield* fileSystem.exists(target))
      assert.deepStrictEqual(yield* fileSystem.readDirectory(root), before)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
