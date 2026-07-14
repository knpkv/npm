import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Ref, Result } from "effect"

import { Database, databaseLayer } from "../../src/server/persistence/Database.js"
import {
  createVerifiedBackup,
  decodePersistenceConfig,
  Persistence,
  verifyBackup
} from "../../src/server/persistence/index.js"
import { blobPath } from "../../src/server/persistence/object-store/BlobStore.js"
import { persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { fixtureTimestamps, fixtureWorkspaceIds, makePersistenceTestConfig } from "./fixtures.js"

const encoder = new TextEncoder()

describe("verified backup archive", () => {
  it.effect("rolls back owner-marker publication failures so each destination can be retried", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* makePersistenceTestConfig("control-center-backup-owner-failure-").pipe(
        Effect.flatMap(decodePersistenceConfig)
      )
      const root = path.dirname(config.blobRoot)

      yield* Effect.gen(function*() {
        const database = yield* Database
        const failureMoments: ReadonlyArray<"after-rename" | "before-rename"> = [
          "before-rename",
          "after-rename"
        ]
        for (const failureMoment of failureMoments) {
          const destination = path.join(root, `retryable-${failureMoment}`)
          const destinationOwnerId = path.join(destination, "backup.id")
          const injectedMissingSource = path.join(root, "missing-parent", `missing-${failureMoment}`)
          const failingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            rename: (source, target) =>
              target === destinationOwnerId
                ? failureMoment === "before-rename"
                  ? fileSystem.rename(injectedMissingSource, target)
                  : fileSystem.rename(source, target).pipe(
                    Effect.andThen(fileSystem.rename(injectedMissingSource, target))
                  )
                : fileSystem.rename(source, target),
            writeFile: (target, contents, options) =>
              target === destinationOwnerId
                ? fileSystem.writeFile(target, encoder.encode("short"), options).pipe(
                  Effect.andThen(fileSystem.writeFile(injectedMissingSource, contents, options))
                )
                : fileSystem.writeFile(target, contents, options),
            writeFileString: (target, contents, options) =>
              target === destinationOwnerId
                ? fileSystem.writeFileString(target, "short", options).pipe(
                  Effect.andThen(fileSystem.writeFileString(injectedMissingSource, contents, options))
                )
                : fileSystem.writeFileString(target, contents, options)
          })
          const failed = yield* Effect.scoped(
            createVerifiedBackup({
              destination,
              persistenceConfig: config,
              sql: database.sql
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, failingFileSystem),
              Effect.result
            )
          )

          assert.isTrue(Result.isFailure(failed))
          if (Result.isFailure(failed)) {
            assert.strictEqual(failed.failure._tag, "BackupStorageError")
            if (failed.failure._tag === "BackupStorageError") {
              assert.strictEqual(failed.failure.operation, "publish-destination-owner-id")
            }
          }
          const stagingEntries = (yield* fileSystem.readDirectory(root)).filter((entry) =>
            entry.startsWith(".control-center-backup-incoming-")
          )
          assert.deepStrictEqual(stagingEntries, [])
          assert.isFalse(yield* fileSystem.exists(destination))

          const retried = yield* Effect.scoped(
            createVerifiedBackup({
              destination,
              persistenceConfig: config,
              sql: database.sql
            })
          )
          assert.strictEqual(retried.verification._tag, "Complete")
        }
      }).pipe(
        Effect.provide(databaseLayer(config)),
        Effect.scoped
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("removes an owned post-manifest failure and durably resyncs its parent", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* makePersistenceTestConfig("control-center-backup-post-manifest-").pipe(
        Effect.flatMap(decodePersistenceConfig)
      )
      const root = path.dirname(config.blobRoot)
      const destination = path.join(root, "failed-published-backup")
      const destinationManifest = path.join(destination, "manifest.json")

      yield* Effect.gen(function*() {
        const database = yield* Database
        const parentSyncs = yield* Ref.make(0)
        const failingFileSystem = FileSystem.make({
          ...fileSystem,
          open: (target, options) =>
            target === root
              ? Ref.update(parentSyncs, (count) => count + 1).pipe(
                Effect.andThen(fileSystem.open(target, options))
              )
              : fileSystem.open(target, options),
          readFile: (target) =>
            target === destinationManifest
              ? fileSystem.readFile(path.join(root, "missing-parent", "missing-manifest"))
              : fileSystem.readFile(target)
        })
        const failed = yield* Effect.scoped(
          createVerifiedBackup({
            destination,
            persistenceConfig: config,
            sql: database.sql
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
            Effect.result
          )
        )

        assert.isTrue(Result.isFailure(failed))
        if (Result.isFailure(failed)) {
          assert.strictEqual(failed.failure._tag, "BackupStorageError")
          if (failed.failure._tag === "BackupStorageError") {
            assert.strictEqual(failed.failure.operation, "read-manifest")
          }
        }
        assert.isFalse(yield* fileSystem.exists(destination))
        assert.deepStrictEqual(
          (yield* fileSystem.readDirectory(root)).filter((entry) =>
            entry.startsWith(".control-center-backup-incoming-")
          ),
          []
        )
        assert.strictEqual(yield* Ref.get(parentSyncs), 3)
      }).pipe(
        Effect.provide(databaseLayer(config)),
        Effect.scoped
      )
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("remains verifiable after moving the physical archive and removing its original parent", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const sourceParent = yield* fileSystem.makeTempDirectory({
        prefix: "control-center-backup-move-source-"
      })
      yield* Effect.addFinalizer(() =>
        fileSystem.remove(sourceParent, { force: true, recursive: true }).pipe(Effect.ignore)
      )
      const config = yield* decodePersistenceConfig({
        blobRoot: path.join(sourceParent, "blobs"),
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: `file:${path.join(sourceParent, "control-center.db")}`,
        maxConnections: 1
      })
      const sourceArchive = path.join(sourceParent, "portable-backup")
      const relocationParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-backup-move-target-"
      })
      const relocatedArchive = path.join(relocationParent, "portable-backup")

      yield* Effect.gen(function*() {
        const database = yield* Database
        yield* createVerifiedBackup({
          destination: sourceArchive,
          persistenceConfig: config,
          sql: database.sql
        })
      }).pipe(
        Effect.provide(databaseLayer(config)),
        Effect.scoped
      )

      assert.deepStrictEqual(
        (yield* fileSystem.readDirectory(sourceParent)).filter((entry) =>
          entry.startsWith(".control-center-backup-incoming-")
        ),
        []
      )
      yield* fileSystem.rename(sourceArchive, relocatedArchive)
      yield* fileSystem.remove(sourceParent, { recursive: true })

      const verification = yield* verifyBackup(relocatedArchive)
      assert.strictEqual(verification._tag, "Complete")
      assert.strictEqual((yield* fileSystem.stat(relocatedArchive)).type, "Directory")
      assert.strictEqual(yield* fileSystem.realPath(relocatedArchive), relocatedArchive)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect(
    "publishes a strict owner-only archive and classifies cache loss without weakening durable integrity",
    () =>
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const config = yield* makePersistenceTestConfig("control-center-backup-").pipe(
          Effect.flatMap(decodePersistenceConfig)
        )
        const root = path.dirname(config.blobRoot)
        yield* fileSystem.chmod(root, 0o755)
        const callerSibling = path.join(root, "caller-owned")
        yield* fileSystem.makeDirectory(callerSibling, { mode: 0o755 })
        yield* fileSystem.chmod(callerSibling, 0o755)
        const destination = path.join(root, "manual-backup")
        const racedDestination = path.join(root, "raced-backup")
        const interruptedDestination = path.join(root, "interrupted-backup")
        const foreignKeyDestination = path.join(root, "foreign-key-backup")
        const services = persistenceLayerFromDatabase(config).pipe(
          Layer.provideMerge(databaseLayer(config))
        )
        const result = yield* Effect.gen(function*() {
          const persistence = yield* Persistence
          const database = yield* Database
          yield* persistence.workspaces.create(fixtureWorkspaceIds.alpha, {
            createdAt: fixtureTimestamps.created,
            displayName: WorkspaceName.make("Payments")
          })
          const durable = yield* persistence.content.put(fixtureWorkspaceIds.alpha, {
            bytes: encoder.encode("authoritative release evidence"),
            classification: "durable",
            createdAt: fixtureTimestamps.created,
            mimeType: "text/plain"
          })
          const cache = yield* persistence.content.put(fixtureWorkspaceIds.alpha, {
            bytes: encoder.encode("reproducible provider cache"),
            classification: "reproducible-cache",
            createdAt: fixtureTimestamps.created,
            mimeType: "text/plain"
          })
          const published = yield* createVerifiedBackup({
            destination,
            persistenceConfig: config,
            sql: database.sql
          })
          const entriesBeforeRace = yield* fileSystem.readDirectory(root)
          const racingFileSystem = FileSystem.make({
            ...fileSystem,
            makeDirectory: (target, options) =>
              target === racedDestination
                ? fileSystem.makeDirectory(racedDestination, { mode: 0o700 }).pipe(
                  Effect.andThen(fileSystem.writeFileString(
                    path.join(racedDestination, "racer-owned"),
                    "preserve me",
                    { mode: 0o600 }
                  )),
                  Effect.andThen(fileSystem.makeDirectory(target, options))
                )
                : fileSystem.makeDirectory(target, options)
          })
          const raced = yield* createVerifiedBackup({
            destination: racedDestination,
            persistenceConfig: config,
            sql: database.sql
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, racingFileSystem),
            Effect.result
          )
          const stagingStarted = yield* Deferred.make<void>()
          const interruptingFileSystem = FileSystem.make({
            ...fileSystem,
            chmod: (target, mode) =>
              target.startsWith(path.join(root, ".control-center-backup-incoming-")) && mode === 0o700
                ? Deferred.succeed(stagingStarted, undefined).pipe(Effect.andThen(Effect.never))
                : fileSystem.chmod(target, mode)
          })
          const interruptedFiber = yield* createVerifiedBackup({
            destination: interruptedDestination,
            persistenceConfig: config,
            sql: database.sql
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, interruptingFileSystem),
            Effect.forkScoped
          )
          yield* Deferred.await(stagingStarted)
          yield* Fiber.interrupt(interruptedFiber)

          const invalidWorkspaceId = "01890f6f-6d6a-7cc0-98d2-000000000099"
          const invalidDigest = "0".repeat(64)
          const invalidCreatedAt = "2026-07-14T09:00:00.000Z"
          yield* database.sql`PRAGMA foreign_keys = OFF`
          yield* database.sql`INSERT INTO content_blobs (
            workspace_id, digest, storage_class, byte_length, mime_type, created_at, last_verified_at
          ) VALUES (
            ${invalidWorkspaceId}, ${invalidDigest}, 'durable', 0, 'text/plain',
            ${invalidCreatedAt}, NULL
          )`
          yield* database.sql`PRAGMA foreign_keys = ON`
          const foreignKeyCorrupt = yield* createVerifiedBackup({
            destination: foreignKeyDestination,
            persistenceConfig: config,
            sql: database.sql
          }).pipe(Effect.result)
          return {
            digests: { cache: cache.metadata.digest, durable: durable.metadata.digest },
            entriesBeforeRace,
            foreignKeyCorrupt,
            published,
            raced
          }
        }).pipe(Effect.provide(services), Effect.scoped)

        const { digests, entriesBeforeRace, foreignKeyCorrupt, published, raced } = result
        assert.strictEqual(published.verification._tag, "Complete")
        assert.strictEqual((yield* fileSystem.stat(root)).mode & 0o777, 0o755)
        assert.strictEqual((yield* fileSystem.stat(callerSibling)).mode & 0o777, 0o755)
        assert.strictEqual((yield* fileSystem.stat(destination)).type, "Directory")
        assert.strictEqual(yield* fileSystem.realPath(destination), destination)
        assert.strictEqual((yield* fileSystem.stat(destination)).mode & 0o777, 0o700)
        assert.strictEqual((yield* fileSystem.stat(path.join(destination, "manifest.json"))).mode & 0o777, 0o600)
        assert.strictEqual((yield* fileSystem.stat(path.join(destination, "control-center.db"))).mode & 0o777, 0o600)
        assert.isTrue(Result.isFailure(raced))
        if (Result.isFailure(raced)) {
          assert.strictEqual(raced.failure._tag, "BackupInputError")
          if (raced.failure._tag === "BackupInputError") assert.strictEqual(raced.failure.reason, "target-raced")
        }
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(racedDestination, "racer-owned")),
          "preserve me"
        )
        assert.deepStrictEqual(
          (yield* fileSystem.readDirectory(root)).sort(),
          [...entriesBeforeRace, "raced-backup"].sort()
        )
        assert.isFalse(yield* fileSystem.exists(interruptedDestination))
        assert.isFalse(yield* fileSystem.exists(foreignKeyDestination))
        assert.isTrue(Result.isFailure(foreignKeyCorrupt))
        if (Result.isFailure(foreignKeyCorrupt)) {
          assert.strictEqual(foreignKeyCorrupt.failure._tag, "BackupIntegrityError")
          if (foreignKeyCorrupt.failure._tag === "BackupIntegrityError") {
            assert.strictEqual(foreignKeyCorrupt.failure.reason, "foreign-key-violation")
          }
        }

        const canonicalArchiveRoot = yield* fileSystem.realPath(destination)
        const pendingDirectories = [canonicalArchiveRoot]
        while (pendingDirectories.length > 0) {
          const directory = pendingDirectories.pop()
          if (directory === undefined) continue
          assert.strictEqual((yield* fileSystem.stat(directory)).mode & 0o777, 0o700)
          for (const entry of yield* fileSystem.readDirectory(directory)) {
            const child = path.join(directory, entry)
            const info = yield* fileSystem.stat(child)
            if (info.type === "Directory") {
              pendingDirectories.push(child)
            } else {
              assert.strictEqual(info.type, "File")
              assert.strictEqual(info.mode & 0o777, 0o600)
            }
          }
        }
        for (const blob of published.verification.manifest.blobs) {
          const copiedBlob = blobPath(
            path,
            path.join(canonicalArchiveRoot, "blobs"),
            blob.workspaceId,
            blob.digest
          ).file
          assert.strictEqual((yield* fileSystem.stat(copiedBlob)).mode & 0o777, 0o600)
        }

        const ownerIdFile = path.join(destination, "backup.id")
        const ownerId = yield* fileSystem.readFileString(ownerIdFile)
        yield* fileSystem.writeFileString(ownerIdFile, "00000000-0000-7000-8000-000000000000", { mode: 0o600 })
        yield* fileSystem.chmod(ownerIdFile, 0o600)
        const ownerMismatchRejected = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(ownerMismatchRejected))
        if (Result.isFailure(ownerMismatchRejected)) {
          assert.strictEqual(ownerMismatchRejected.failure._tag, "BackupIntegrityError")
          if (ownerMismatchRejected.failure._tag === "BackupIntegrityError") {
            assert.strictEqual(ownerMismatchRejected.failure.reason, "unexpected-artifact")
          }
        }
        yield* fileSystem.writeFileString(ownerIdFile, ownerId, { mode: 0o600 })
        yield* fileSystem.chmod(ownerIdFile, 0o600)

        const manifestFile = path.join(destination, "manifest.json")
        const manifestSource = yield* fileSystem.readFileString(manifestFile)
        const topLevelExcess = manifestSource.replace(
          "\"format\":\"@knpkv/control-center-backup\"",
          "\"unexpected\":true,\"format\":\"@knpkv/control-center-backup\""
        )
        assert.notStrictEqual(topLevelExcess, manifestSource)
        yield* fileSystem.writeFileString(manifestFile, topLevelExcess, { mode: 0o600 })
        yield* fileSystem.chmod(manifestFile, 0o600)
        const topLevelRejected = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(topLevelRejected))
        if (Result.isFailure(topLevelRejected)) {
          assert.strictEqual(topLevelRejected.failure._tag, "BackupManifestError")
        }

        const nestedExcess = manifestSource.replace(
          "\"database\":{",
          "\"database\":{\"unexpected\":true,"
        )
        assert.notStrictEqual(nestedExcess, manifestSource)
        yield* fileSystem.writeFileString(manifestFile, nestedExcess, { mode: 0o600 })
        yield* fileSystem.chmod(manifestFile, 0o600)
        const nestedRejected = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(nestedRejected))
        if (Result.isFailure(nestedRejected)) {
          assert.strictEqual(nestedRejected.failure._tag, "BackupManifestError")
        }

        const ledgerMismatch = manifestSource.replace(
          "\"migrationId\":1",
          "\"migrationId\":99"
        )
        assert.notStrictEqual(ledgerMismatch, manifestSource)
        yield* fileSystem.writeFileString(manifestFile, ledgerMismatch, { mode: 0o600 })
        yield* fileSystem.chmod(manifestFile, 0o600)
        const ledgerRejected = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(ledgerRejected))
        if (Result.isFailure(ledgerRejected)) {
          assert.strictEqual(ledgerRejected.failure._tag, "BackupManifestError")
          if (ledgerRejected.failure._tag === "BackupManifestError") {
            assert.strictEqual(ledgerRejected.failure.reason, "migration-ledger-mismatch")
          }
        }

        const boundaryMismatch = manifestSource.replace(
          /"domainEventRows":(\d+)/u,
          (_match, rows: string) => `"domainEventRows":${Number(rows) + 1}`
        )
        assert.notStrictEqual(boundaryMismatch, manifestSource)
        yield* fileSystem.writeFileString(manifestFile, boundaryMismatch, { mode: 0o600 })
        yield* fileSystem.chmod(manifestFile, 0o600)
        const boundaryRejected = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(boundaryRejected))
        if (Result.isFailure(boundaryRejected)) {
          assert.strictEqual(boundaryRejected.failure._tag, "BackupManifestError")
          if (boundaryRejected.failure._tag === "BackupManifestError") {
            assert.strictEqual(boundaryRejected.failure.reason, "boundary-mismatch")
          }
        }

        yield* fileSystem.writeFileString(manifestFile, manifestSource, { mode: 0o600 })
        yield* fileSystem.chmod(manifestFile, 0o600)
        const unexpectedEmptyDirectory = path.join(destination, "empty-but-unknown")
        yield* fileSystem.makeDirectory(unexpectedEmptyDirectory, { mode: 0o700 })
        const extraDirectoryRejected = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(extraDirectoryRejected))
        if (Result.isFailure(extraDirectoryRejected)) {
          assert.strictEqual(extraDirectoryRejected.failure._tag, "BackupIntegrityError")
        }
        yield* fileSystem.remove(unexpectedEmptyDirectory, { recursive: true })

        const databaseFile = path.join(destination, "control-center.db")
        const databaseBytes = yield* fileSystem.readFile(databaseFile)
        const corruptedDatabaseBytes = Uint8Array.from(databaseBytes)
        corruptedDatabaseBytes[0] = (corruptedDatabaseBytes[0] ?? 0) ^ 0xff
        yield* fileSystem.writeFile(databaseFile, corruptedDatabaseBytes, { mode: 0o600 })
        yield* fileSystem.chmod(databaseFile, 0o600)
        const corruptDatabaseRejected = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(corruptDatabaseRejected))
        if (Result.isFailure(corruptDatabaseRejected)) {
          assert.strictEqual(corruptDatabaseRejected.failure._tag, "BackupIntegrityError")
          if (corruptDatabaseRejected.failure._tag === "BackupIntegrityError") {
            assert.strictEqual(corruptDatabaseRejected.failure.reason, "database-digest-mismatch")
          }
        }
        yield* fileSystem.writeFile(databaseFile, databaseBytes, { mode: 0o600 })
        yield* fileSystem.chmod(databaseFile, 0o600)

        const archiveBlobRoot = path.join(destination, "blobs")
        const cacheFile = blobPath(path, archiveBlobRoot, fixtureWorkspaceIds.alpha, digests.cache).file
        const durableFile = blobPath(path, archiveBlobRoot, fixtureWorkspaceIds.alpha, digests.durable).file
        yield* fileSystem.remove(cacheFile)
        const degraded = yield* verifyBackup(destination)
        assert.strictEqual(degraded._tag, "RecoverableCacheGaps")
        if (degraded._tag === "RecoverableCacheGaps") {
          assert.deepStrictEqual(degraded.reproducibleBlobGaps, [{
            digest: digests.cache,
            reason: "missing",
            workspaceId: fixtureWorkspaceIds.alpha
          }])
        }

        yield* fileSystem.remove(durableFile)
        const failed = yield* verifyBackup(destination).pipe(Effect.result)
        assert.isTrue(Result.isFailure(failed))
        if (Result.isFailure(failed)) assert.strictEqual(failed.failure._tag, "BackupIntegrityError")
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    20_000
  )
})
