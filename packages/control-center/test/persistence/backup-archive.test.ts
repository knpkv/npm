import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Path, Ref, Result } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import { createVerifiedBackup, decodePersistenceConfig, verifyBackup } from "../../src/server/persistence/index.js"
import { blobPath } from "../../src/server/persistence/object-store/BlobPath.js"
import {
  assertOwnerOnlyTree,
  makeContentVerifiedArchive,
  makeEmptyVerifiedArchive,
  stagingEntries
} from "./backup-fixtures.js"
import { fixtureWorkspaceIds, makePersistenceTestConfig } from "./fixtures.js"

const encoder = new TextEncoder()

const ownerMarkerFailure = (failureMoment: "after-rename" | "before-rename") =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* makePersistenceTestConfig(`control-center-backup-owner-${failureMoment}-`).pipe(
      Effect.flatMap(decodePersistenceConfig)
    )
    const root = path.dirname(config.blobRoot)
    const destination = path.join(root, "retryable")
    const destinationOwnerId = path.join(destination, "backup.id")
    const missing = path.join(root, "missing-parent", "missing-owner-id")
    yield* Effect.gen(function*() {
      const database = yield* Database
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (source, target) =>
          target === destinationOwnerId
            ? failureMoment === "before-rename"
              ? fileSystem.rename(missing, target)
              : fileSystem.rename(source, target).pipe(Effect.andThen(fileSystem.rename(missing, target)))
            : fileSystem.rename(source, target),
        writeFile: (target, contents, options) =>
          target === destinationOwnerId
            ? fileSystem
              .writeFile(target, encoder.encode("short"), options)
              .pipe(Effect.andThen(fileSystem.writeFile(missing, contents, options)))
            : fileSystem.writeFile(target, contents, options),
        writeFileString: (target, contents, options) =>
          target === destinationOwnerId
            ? fileSystem
              .writeFileString(target, "short", options)
              .pipe(Effect.andThen(fileSystem.writeFileString(missing, contents, options)))
            : fileSystem.writeFileString(target, contents, options)
      })
      const failed = yield* Effect.scoped(
        createVerifiedBackup({
          destination,
          persistenceConfig: config,
          sql: database.sql
        }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.result)
      )
      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) {
        assert.strictEqual(failed.failure._tag, "BackupStorageError")
        if (failed.failure._tag === "BackupStorageError") {
          assert.strictEqual(failed.failure.operation, "publish-destination-owner-id")
        }
      }
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-backup-incoming-"), [])
      assert.isFalse(yield* fileSystem.exists(destination))
      const retried = yield* Effect.scoped(
        createVerifiedBackup({ destination, persistenceConfig: config, sql: database.sql })
      )
      assert.strictEqual(retried.verification._tag, "Complete")
    }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
  })

describe("verified backup archive", () => {
  it.effect("publishes an owner-only physical archive without changing caller-owned ancestors", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* makePersistenceTestConfig("control-center-backup-private-").pipe(
        Effect.flatMap(decodePersistenceConfig)
      )
      const root = path.dirname(config.blobRoot)
      yield* fileSystem.chmod(root, 0o755)
      const sibling = path.join(root, "caller-owned")
      yield* fileSystem.makeDirectory(sibling, { mode: 0o755 })
      yield* fileSystem.chmod(sibling, 0o755)
      const destination = path.join(root, "archive")
      const published = yield* Effect.gen(function*() {
        const database = yield* Database
        return yield* createVerifiedBackup({ destination, persistenceConfig: config, sql: database.sql })
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
      assert.strictEqual(published.verification._tag, "Complete")
      assert.strictEqual((yield* fileSystem.stat(root)).mode & 0o777, 0o755)
      assert.strictEqual((yield* fileSystem.stat(sibling)).mode & 0o777, 0o755)
      assert.strictEqual((yield* fileSystem.stat(destination)).type, "Directory")
      assert.strictEqual(yield* fileSystem.realPath(destination), destination)
      yield* assertOwnerOnlyTree(destination)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("preserves a racer-owned destination when archive publication loses the destination race", () =>
    Effect.gen(function*() {
      const { root, sourceConfig } = yield* makeEmptyVerifiedArchive("control-center-backup-race-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const destination = path.join(root, "raced-backup")
      const sentinel = path.join(destination, "racer-owned")
      const racingFileSystem = FileSystem.make({
        ...fileSystem,
        makeDirectory: (target, options) =>
          target === destination
            ? fileSystem
              .makeDirectory(destination, { mode: 0o700 })
              .pipe(
                Effect.andThen(fileSystem.writeFileString(sentinel, "preserve me", { mode: 0o600 })),
                Effect.andThen(fileSystem.makeDirectory(target, options))
              )
            : fileSystem.makeDirectory(target, options)
      })
      const result = yield* Effect.gen(function*() {
        const database = yield* Database
        return yield* createVerifiedBackup({ destination, persistenceConfig: sourceConfig, sql: database.sql }).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFileSystem),
          Effect.result
        )
      }).pipe(Effect.provide(databaseLayer(sourceConfig)), Effect.scoped)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupInputError")
      if (Result.isFailure(result) && result.failure._tag === "BackupInputError") {
        assert.strictEqual(result.failure.reason, "target-raced")
      }
      assert.strictEqual(yield* fileSystem.readFileString(sentinel), "preserve me")
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-backup-incoming-"), [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("removes unclaimed archive staging after interruption", () =>
    Effect.gen(function*() {
      const { root, sourceConfig } = yield* makeEmptyVerifiedArchive("control-center-backup-interrupt-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const destination = path.join(root, "interrupted")
      const started = yield* Deferred.make<void>()
      const interrupting = FileSystem.make({
        ...fileSystem,
        chmod: (target, mode) =>
          target.startsWith(path.join(root, ".control-center-backup-incoming-")) && mode === 0o700
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : fileSystem.chmod(target, mode)
      })
      yield* Effect.gen(function*() {
        const database = yield* Database
        const fiber = yield* createVerifiedBackup({
          destination,
          persistenceConfig: sourceConfig,
          sql: database.sql
        }).pipe(Effect.provideService(FileSystem.FileSystem, interrupting), Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        yield* Fiber.await(fiber)
      }).pipe(Effect.provide(databaseLayer(sourceConfig)), Effect.scoped)
      assert.isFalse(yield* fileSystem.exists(destination))
      assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-backup-incoming-"), [])
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a foreign-key-invalid snapshot before publishing a destination", () =>
    Effect.gen(function*() {
      const { root, sourceConfig } = yield* makeEmptyVerifiedArchive("control-center-backup-fk-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const destination = path.join(root, "invalid")
      const result = yield* Effect.gen(function*() {
        const database = yield* Database
        yield* database.sql`PRAGMA foreign_keys = OFF`
        yield* database.sql`INSERT INTO content_blobs (
          workspace_id, digest, storage_class, byte_length, mime_type, created_at, last_verified_at
        ) VALUES (
          ${"01890f6f-6d6a-7cc0-98d2-000000000099"}, ${"0".repeat(64)}, 'durable', 0,
          'text/plain', ${"2026-07-14T09:00:00.000Z"}, NULL
        )`
        yield* database.sql`PRAGMA foreign_keys = ON`
        return yield* createVerifiedBackup({ destination, persistenceConfig: sourceConfig, sql: database.sql }).pipe(
          Effect.result
        )
      }).pipe(Effect.provide(databaseLayer(sourceConfig)), Effect.scoped)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupIntegrityError")
      if (Result.isFailure(result) && result.failure._tag === "BackupIntegrityError") {
        assert.strictEqual(result.failure.reason, "foreign-key-violation")
      }
      assert.isFalse(yield* fileSystem.exists(destination))
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rolls back an owner-marker failure before rename and permits retry", () =>
    ownerMarkerFailure("before-rename").pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rolls back an owner-marker failure after rename and permits retry", () =>
    ownerMarkerFailure("after-rename").pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("removes an owned archive when post-publication verification fails and resyncs its parent", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* makePersistenceTestConfig("control-center-backup-post-verify-").pipe(
        Effect.flatMap(decodePersistenceConfig)
      )
      const root = path.dirname(config.blobRoot)
      const destination = path.join(root, "failed")
      const manifest = path.join(destination, "manifest.json")
      yield* Effect.gen(function*() {
        const database = yield* Database
        const parentSyncs = yield* Ref.make(0)
        const failing = FileSystem.make({
          ...fileSystem,
          open: (target, options) =>
            target === root
              ? Ref.update(parentSyncs, (count) => count + 1).pipe(Effect.andThen(fileSystem.open(target, options)))
              : fileSystem.open(target, options),
          readFile: (target) =>
            target === manifest
              ? fileSystem.readFile(path.join(root, "missing", "manifest"))
              : fileSystem.readFile(target)
        })
        const result = yield* Effect.scoped(
          createVerifiedBackup({ destination, persistenceConfig: config, sql: database.sql }).pipe(
            Effect.provideService(FileSystem.FileSystem, failing),
            Effect.result
          )
        )
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupStorageError")
        if (Result.isFailure(result) && result.failure._tag === "BackupStorageError") {
          assert.strictEqual(result.failure.operation, "read-manifest")
        }
        assert.isFalse(yield* fileSystem.exists(destination))
        assert.deepStrictEqual(yield* stagingEntries(fileSystem, root, ".control-center-backup-incoming-"), [])
        assert.strictEqual(yield* Ref.get(parentSyncs), 3)
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("remains verifiable after physical relocation and removal of the original parent", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sourceParent = yield* fileSystem.makeTempDirectory({ prefix: "control-center-backup-move-source-" })
      yield* Effect.addFinalizer(() =>
        fileSystem.remove(sourceParent, { force: true, recursive: true }).pipe(Effect.ignore)
      )
      const config = yield* decodePersistenceConfig({
        blobRoot: path.join(sourceParent, "blobs"),
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: `file:${path.join(sourceParent, "control-center.db")}`,
        maxConnections: 1
      })
      const sourceArchive = path.join(sourceParent, "portable")
      const targetParent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-backup-move-target-" })
      const targetArchive = path.join(targetParent, "portable")
      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* createVerifiedBackup({ destination: sourceArchive, persistenceConfig: config, sql: database.sql })
      }).pipe(Effect.provide(databaseLayer(config)), Effect.scoped)
      yield* fileSystem.rename(sourceArchive, targetArchive)
      yield* fileSystem.remove(sourceParent, { recursive: true })
      assert.strictEqual((yield* verifyBackup(targetArchive))._tag, "Complete")
      assert.strictEqual(yield* fileSystem.realPath(targetArchive), targetArchive)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects an owner-id mismatch as an unexpected artifact", () =>
    Effect.gen(function*() {
      const { archiveRoot } = yield* makeEmptyVerifiedArchive("control-center-backup-owner-mismatch-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const owner = path.join(archiveRoot, "backup.id")
      yield* fileSystem.writeFileString(owner, "00000000-0000-7000-8000-000000000000", { mode: 0o600 })
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupIntegrityError")
      if (Result.isFailure(result) && result.failure._tag === "BackupIntegrityError") {
        assert.strictEqual(result.failure.reason, "unexpected-artifact")
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects an unknown top-level manifest field", () =>
    Effect.gen(function*() {
      const { archiveRoot } = yield* makeEmptyVerifiedArchive("control-center-backup-manifest-top-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifest = path.join(archiveRoot, "manifest.json")
      const source = yield* fileSystem.readFileString(manifest)
      yield* fileSystem.writeFileString(
        manifest,
        source.replace(
          "\"format\":\"@knpkv/control-center-backup\"",
          "\"unexpected\":true,\"format\":\"@knpkv/control-center-backup\""
        ),
        { mode: 0o600 }
      )
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupManifestError")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects an unknown nested manifest field", () =>
    Effect.gen(function*() {
      const { archiveRoot } = yield* makeEmptyVerifiedArchive("control-center-backup-manifest-nested-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifest = path.join(archiveRoot, "manifest.json")
      const source = yield* fileSystem.readFileString(manifest)
      yield* fileSystem.writeFileString(
        manifest,
        source.replace("\"database\":{", "\"database\":{\"unexpected\":true,"),
        {
          mode: 0o600
        }
      )
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupManifestError")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a manifest migration ledger that differs from the database", () =>
    Effect.gen(function*() {
      const { archiveRoot } = yield* makeEmptyVerifiedArchive("control-center-backup-ledger-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifest = path.join(archiveRoot, "manifest.json")
      const source = yield* fileSystem.readFileString(manifest)
      yield* fileSystem.writeFileString(manifest, source.replace("\"migrationId\":1", "\"migrationId\":99"), {
        mode: 0o600
      })
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupManifestError")
      if (Result.isFailure(result) && result.failure._tag === "BackupManifestError") {
        assert.strictEqual(result.failure.reason, "migration-ledger-mismatch")
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects manifest boundary counts that differ from the database", () =>
    Effect.gen(function*() {
      const { archiveRoot } = yield* makeEmptyVerifiedArchive("control-center-backup-boundary-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifest = path.join(archiveRoot, "manifest.json")
      const source = yield* fileSystem.readFileString(manifest)
      yield* fileSystem.writeFileString(
        manifest,
        source.replace(/"domainEventRows":(\d+)/u, (_match, rows: string) => `"domainEventRows":${Number(rows) + 1}`),
        { mode: 0o600 }
      )
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupManifestError")
      if (Result.isFailure(result) && result.failure._tag === "BackupManifestError") {
        assert.strictEqual(result.failure.reason, "boundary-mismatch")
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects an unexpected archive directory", () =>
    Effect.gen(function*() {
      const { archiveRoot } = yield* makeEmptyVerifiedArchive("control-center-backup-extra-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.makeDirectory(path.join(archiveRoot, "unexpected"), { mode: 0o700 })
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupIntegrityError")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a database digest mismatch", () =>
    Effect.gen(function*() {
      const { archiveRoot } = yield* makeEmptyVerifiedArchive("control-center-backup-db-digest-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const database = path.join(archiveRoot, "control-center.db")
      const bytes = Uint8Array.from(yield* fileSystem.readFile(database))
      bytes[0] = (bytes[0] ?? 0) ^ 0xff
      yield* fileSystem.writeFile(database, bytes, { mode: 0o600 })
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupIntegrityError")
      if (Result.isFailure(result) && result.failure._tag === "BackupIntegrityError") {
        assert.strictEqual(result.failure.reason, "database-digest-mismatch")
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("reports a missing reproducible-cache blob as RecoverableCacheGaps", () =>
    Effect.gen(function*() {
      const { archiveRoot, digests } = yield* makeContentVerifiedArchive("control-center-backup-cache-gap-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.remove(
        blobPath(path, path.join(archiveRoot, "blobs"), fixtureWorkspaceIds.alpha, digests.cache).file
      )
      const result = yield* verifyBackup(archiveRoot)
      assert.strictEqual(result._tag, "RecoverableCacheGaps")
      if (result._tag === "RecoverableCacheGaps") {
        assert.deepStrictEqual(result.reproducibleBlobGaps, [
          {
            digest: digests.cache,
            reason: "missing",
            workspaceId: fixtureWorkspaceIds.alpha
          }
        ])
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("rejects a missing durable blob", () =>
    Effect.gen(function*() {
      const { archiveRoot, digests } = yield* makeContentVerifiedArchive("control-center-backup-durable-gap-")
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.remove(
        blobPath(path, path.join(archiveRoot, "blobs"), fixtureWorkspaceIds.alpha, digests.durable).file
      )
      const result = yield* verifyBackup(archiveRoot).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "BackupIntegrityError")
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
})
