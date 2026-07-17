import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import {
  Crypto,
  DateTime,
  Effect,
  Encoding,
  Fiber,
  FileSystem,
  ManagedRuntime,
  Path,
  Ref,
  Result,
  Schema
} from "effect"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import { BlobDigest } from "../object-store/BlobDigest.js"
import { blobPath } from "../object-store/BlobPath.js"
import type { PersistenceConfig } from "../PersistenceConfig.js"
import {
  BackupId,
  BackupManifestJsonV1,
  type BackupManifestV1,
  type BackupVerification,
  type PublishedBackup
} from "./BackupManifest.js"
import { readDatabaseSnapshotInventory, verifyManifestInventory } from "./DatabaseSnapshot.js"
import {
  type BackupFailure,
  BackupInputError,
  BackupIntegrityError,
  BackupLimitError,
  BackupManifestError,
  BackupSqlError,
  BackupStorageError
} from "./errors.js"

const BACKUP_DIRECTORY_MODE = 0o700
const BACKUP_FILE_MODE = 0o600
const MAXIMUM_DATABASE_BYTES = 512 * 1024 * 1024
const MAXIMUM_MANIFEST_BYTES = 16 * 1024 * 1024
const MAXIMUM_BLOB_BYTES = 256 * 1024 * 1024
const MAXIMUM_OWNER_ID_BYTES = 64
const MANIFEST_NAME = "manifest.json"
const DATABASE_NAME = "control-center.db"
const OWNER_ID_NAME = "backup.id"
const STAGING_PREFIX = ".control-center-backup-incoming-"

/** Internal archive assembly contract; snapshot entry points own how the database file is produced. */
export interface CreateVerifiedArchiveInput {
  readonly destination: string
  readonly kind: "manual"
  readonly persistenceConfig: PersistenceConfig
  readonly writeDatabase: (
    destination: string
  ) => Effect.Effect<void, BackupFailure, FileSystem.FileSystem>
}

interface FileDigest {
  readonly byteLength: number
  readonly digest: BlobDigest
}

interface RestoreArchiveWriter<Failure, Requirements> {
  readonly writeTransferredFile: (
    pathSegments: ReadonlyArray<string>,
    bytes: Uint8Array
  ) => Effect.Effect<void, Failure, Requirements>
}

const storageError = (operation: string, cause: unknown): BackupStorageError =>
  new BackupStorageError({ cause, operation })

const mapStorage = <Value, Requirements>(
  operation: string,
  effect: Effect.Effect<Value, unknown, Requirements>
): Effect.Effect<Value, BackupStorageError, Requirements> =>
  effect.pipe(Effect.mapError((cause) => storageError(operation, cause)))

const syncPath = Effect.fn("BackupArchive.syncPath")(function*(pathValue: string) {
  const fileSystem = yield* FileSystem.FileSystem
  yield* Effect.scoped(
    mapStorage("open-for-sync", fileSystem.open(pathValue, { flag: "r" })).pipe(
      Effect.flatMap((file) => mapStorage("sync", file.sync))
    )
  )
})

const ensurePublicationParent = Effect.fn("BackupArchive.ensurePublicationParent")(function*(
  directory: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exists = yield* mapStorage("check-directory", fileSystem.exists(directory))
  if (!exists) {
    yield* mapStorage(
      "create-directory",
      fileSystem.makeDirectory(directory, {
        mode: BACKUP_DIRECTORY_MODE,
        recursive: true
      })
    )
  }
  const canonical = yield* mapStorage("resolve-directory", fileSystem.realPath(directory))
  const info = yield* mapStorage("inspect-directory", fileSystem.stat(directory))
  if (canonical !== directory || info.type !== "Directory") {
    return yield* new BackupIntegrityError({
      digest: null,
      reason: "unexpected-artifact",
      workspaceId: null
    })
  }
  yield* syncPath(directory)
  const parent = path.dirname(directory)
  if (parent !== directory && (yield* mapStorage("check-parent", fileSystem.exists(parent)))) {
    yield* syncPath(parent)
  }
})

const ensurePrivateArchiveDirectory = Effect.fn("BackupArchive.ensurePrivateArchiveDirectory")(function*(
  directory: string,
  expectedCanonicalDirectory: string = directory
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exists = yield* mapStorage("check-archive-directory", fileSystem.exists(directory))
  if (!exists) {
    yield* mapStorage(
      "create-archive-directory",
      fileSystem.makeDirectory(directory, {
        mode: BACKUP_DIRECTORY_MODE,
        recursive: true
      })
    )
  }
  const canonical = yield* mapStorage("resolve-archive-directory", fileSystem.realPath(directory))
  const info = yield* mapStorage("inspect-archive-directory", fileSystem.stat(directory))
  if (canonical !== expectedCanonicalDirectory || info.type !== "Directory") {
    return yield* new BackupIntegrityError({
      digest: null,
      reason: "unexpected-artifact",
      workspaceId: null
    })
  }
  yield* mapStorage("secure-archive-directory", fileSystem.chmod(directory, BACKUP_DIRECTORY_MODE))
  yield* syncPath(directory)
  const parent = path.dirname(directory)
  if (parent !== directory && (yield* mapStorage("check-archive-parent", fileSystem.exists(parent)))) {
    yield* syncPath(parent)
  }
})

const fileSize = Effect.fn("BackupArchive.fileSize")(function*(
  file: string,
  artifact: "blob" | "database" | "manifest",
  maximumBytes: number,
  expectedCanonicalFile: string = file
) {
  const fileSystem = yield* FileSystem.FileSystem
  const canonical = yield* mapStorage("resolve-file", fileSystem.realPath(file))
  const info = yield* mapStorage("inspect-file", fileSystem.stat(file))
  if (canonical !== expectedCanonicalFile || info.type !== "File" || (info.mode & 0o077) !== 0) {
    return yield* new BackupIntegrityError({
      digest: null,
      reason: canonical !== expectedCanonicalFile || info.type !== "File"
        ? "unexpected-artifact"
        : "owner-mode-invalid",
      workspaceId: null
    })
  }
  if (info.size > BigInt(maximumBytes) || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return yield* new BackupLimitError({ artifact, maximumBytes })
  }
  return Number(info.size)
})

const digestFile = Effect.fn("BackupArchive.digestFile")(function*(
  file: string,
  artifact: "blob" | "database",
  maximumBytes: number,
  expectedCanonicalFile: string = file
): Effect.fn.Return<FileDigest, BackupFailure, Crypto.Crypto | FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  const cryptoService = yield* Crypto.Crypto
  const byteLength = yield* fileSize(file, artifact, maximumBytes, expectedCanonicalFile)
  const bytes = yield* mapStorage("read-for-digest", fileSystem.readFile(file))
  if (bytes.byteLength !== byteLength) {
    return yield* storageError("file-size-changed", {
      _tag: "BackupInvariant",
      actualByteLength: bytes.byteLength,
      expectedByteLength: byteLength,
      reason: "file-size-changed"
    })
  }
  const digestBytes = yield* mapStorage("digest", cryptoService.digest("SHA-256", bytes))
  const digest = yield* Schema.decodeUnknownEffect(BlobDigest)(Encoding.encodeHex(digestBytes)).pipe(
    Effect.mapError((cause) => storageError("decode-digest", cause))
  )
  return { byteLength, digest }
})

const readArtifactBytes = Effect.fn("BackupArchive.readArtifactBytes")(function*(
  file: string,
  artifact: "blob" | "database",
  maximumBytes: number,
  expectedCanonicalFile: string = file
) {
  const fileSystem = yield* FileSystem.FileSystem
  const cryptoService = yield* Crypto.Crypto
  const byteLength = yield* fileSize(file, artifact, maximumBytes, expectedCanonicalFile)
  const bytes = yield* mapStorage("read-for-restore", fileSystem.readFile(file))
  if (bytes.byteLength !== byteLength) {
    return yield* storageError("restore-source-size-changed", {
      _tag: "BackupInvariant",
      actualByteLength: bytes.byteLength,
      expectedByteLength: byteLength,
      reason: "file-size-changed"
    })
  }
  const digestBytes = yield* mapStorage("digest-restore-source", cryptoService.digest("SHA-256", bytes))
  const digest = yield* Schema.decodeUnknownEffect(BlobDigest)(Encoding.encodeHex(digestBytes)).pipe(
    Effect.mapError((cause) => storageError("decode-restore-digest", cause))
  )
  return { bytes, digest: { byteLength, digest } }
})

const inspectSnapshotDatabase = Effect.fn("BackupArchive.inspectSnapshotDatabase")(function*(
  databaseFile: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporaryRoot = yield* mapStorage(
    "create-inspection-root",
    fileSystem.makeTempDirectoryScoped({ prefix: "control-center-backup-inspection-" })
  )
  const temporaryDatabase = path.join(temporaryRoot, DATABASE_NAME)
  yield* mapStorage("copy-database-for-inspection", fileSystem.copyFile(databaseFile, temporaryDatabase))
  yield* mapStorage("secure-inspection-database", fileSystem.chmod(temporaryDatabase, BACKUP_FILE_MODE))
  const sqlLayer = LibsqlClient.layer({
    concurrency: 1,
    transformResultNames: (value) => value.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase()),
    url: `file:${temporaryDatabase}`
  })
  const inspection = Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA query_only = ON`.pipe(
      Effect.mapError((cause) => new BackupSqlError({ cause, operation: "enable-query-only" }))
    )
    return yield* readDatabaseSnapshotInventory(sql)
  })
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => ManagedRuntime.make(sqlLayer)),
    (runtime) => {
      const fiber = runtime.runFork(inspection)
      return Fiber.join(fiber).pipe(
        Effect.onInterrupt(() => Fiber.interrupt(fiber))
      )
    },
    (runtime) => runtime.disposeEffect
  )
})

/** Populate an unclaimed data root only from bytes revalidated against the verified archive. */
export const restoreVerifiedArchiveInto = Effect.fn("BackupArchive.restoreInto")(function*<
  WriterFailure,
  WriterRequirements
>(
  configuredArchiveRoot: string,
  writer: RestoreArchiveWriter<WriterFailure, WriterRequirements>,
  verification: BackupVerification
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const archiveRoot = yield* mapStorage("resolve-restore-archive", fileSystem.realPath(configuredArchiveRoot))
  const archiveDatabaseFile = path.join(archiveRoot, DATABASE_NAME)
  const database = yield* readArtifactBytes(archiveDatabaseFile, "database", MAXIMUM_DATABASE_BYTES)
  if (
    database.digest.digest !== verification.manifest.database.digest ||
    database.digest.byteLength !== verification.manifest.database.byteLength
  ) {
    return yield* new BackupIntegrityError({
      digest: verification.manifest.database.digest,
      reason: "database-digest-mismatch",
      workspaceId: null
    })
  }
  yield* writer.writeTransferredFile([DATABASE_NAME], database.bytes)

  const gapKeys = new Set(
    verification.reproducibleBlobGaps.map((gap) => `${gap.workspaceId}:${gap.digest}`)
  )
  const archiveBlobRoot = path.join(archiveRoot, "blobs")
  for (const blob of verification.manifest.blobs) {
    if (gapKeys.has(`${blob.workspaceId}:${blob.digest}`)) continue
    const source = blobPath(path, archiveBlobRoot, blob.workspaceId, blob.digest).file
    const restored = yield* readArtifactBytes(source, "blob", MAXIMUM_BLOB_BYTES)
    if (restored.digest.digest !== blob.digest || restored.digest.byteLength !== blob.byteLength) {
      return yield* new BackupIntegrityError({
        digest: blob.digest,
        reason: "blob-corrupt",
        workspaceId: blob.workspaceId
      })
    }
    yield* writer.writeTransferredFile([
      "blobs",
      "objects",
      blob.workspaceId,
      "sha256",
      blob.digest.slice(0, 2),
      blob.digest.slice(2, 4),
      blob.digest
    ], restored.bytes)
  }
})

const readManifest = Effect.fn("BackupArchive.readManifest")(function*(archiveRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifestFile = path.join(archiveRoot, MANIFEST_NAME)
  yield* fileSize(manifestFile, "manifest", MAXIMUM_MANIFEST_BYTES)
  const source = yield* mapStorage("read-manifest", fileSystem.readFileString(manifestFile))
  return yield* Schema.decodeUnknownEffect(BackupManifestJsonV1, {
    onExcessProperty: "error"
  })(source).pipe(
    Effect.mapError(() => new BackupManifestError({ reason: "malformed" }))
  )
})

interface ExpectedArchivePaths {
  readonly directories: ReadonlySet<string>
  readonly files: ReadonlySet<string>
}

const expectedArchivePaths = (
  path: Path.Path,
  archiveRoot: string,
  manifest: BackupManifestV1
): ExpectedArchivePaths => {
  const files = new Set<string>([
    path.join(archiveRoot, OWNER_ID_NAME),
    path.join(archiveRoot, DATABASE_NAME),
    path.join(archiveRoot, MANIFEST_NAME)
  ])
  const blobRoot = path.join(archiveRoot, "blobs")
  for (const blob of manifest.blobs) {
    files.add(blobPath(path, blobRoot, blob.workspaceId, blob.digest).file)
  }
  const directories = new Set<string>([archiveRoot])
  for (const file of files) {
    let ancestor = path.dirname(file)
    while (ancestor !== archiveRoot) {
      directories.add(ancestor)
      ancestor = path.dirname(ancestor)
    }
  }
  return { directories, files }
}

const verifyArchiveTree = Effect.fn("BackupArchive.verifyArchiveTree")(function*(
  archiveRoot: string,
  manifest: BackupManifestV1
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const expected = expectedArchivePaths(path, archiveRoot, manifest)
  const pendingDirectories = [archiveRoot]
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()
    if (directory === undefined || !expected.directories.has(directory)) {
      return yield* new BackupIntegrityError({
        digest: null,
        reason: "unexpected-artifact",
        workspaceId: null
      })
    }
    const canonical = yield* mapStorage("resolve-archive-directory", fileSystem.realPath(directory))
    const info = yield* mapStorage("inspect-archive-directory", fileSystem.stat(directory))
    if (canonical !== directory || info.type !== "Directory" || (info.mode & 0o777) !== BACKUP_DIRECTORY_MODE) {
      return yield* new BackupIntegrityError({
        digest: null,
        reason: canonical !== directory || info.type !== "Directory" ? "unexpected-artifact" : "owner-mode-invalid",
        workspaceId: null
      })
    }
    for (const entry of yield* mapStorage("list-archive", fileSystem.readDirectory(directory))) {
      const child = path.join(directory, entry)
      const childCanonical = yield* mapStorage("resolve-archive-entry", fileSystem.realPath(child))
      const childInfo = yield* mapStorage("inspect-archive-entry", fileSystem.stat(child))
      if (childCanonical !== child) {
        return yield* new BackupIntegrityError({ digest: null, reason: "unexpected-artifact", workspaceId: null })
      }
      if (childInfo.type === "Directory") {
        if (!expected.directories.has(child)) {
          return yield* new BackupIntegrityError({
            digest: null,
            reason: "unexpected-artifact",
            workspaceId: null
          })
        }
        pendingDirectories.push(child)
      } else if (
        childInfo.type !== "File" ||
        !expected.files.has(child) ||
        (childInfo.mode & 0o777) !== BACKUP_FILE_MODE
      ) {
        return yield* new BackupIntegrityError({
          digest: null,
          reason: childInfo.type === "File" && expected.files.has(child)
            ? "owner-mode-invalid"
            : "unexpected-artifact",
          workspaceId: null
        })
      }
    }
  }
})

const verifyBlobs = Effect.fn("BackupArchive.verifyBlobs")(function*(
  archiveRoot: string,
  manifest: BackupManifestV1
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const blobRoot = path.join(archiveRoot, "blobs")
  const gaps: Array<
    {
      readonly digest: BlobDigest
      readonly reason: "corrupt" | "missing"
      readonly workspaceId: typeof manifest.blobs[number]["workspaceId"]
    }
  > = []
  for (const blob of manifest.blobs) {
    const file = blobPath(path, blobRoot, blob.workspaceId, blob.digest).file
    const exists = yield* mapStorage("check-blob", fileSystem.exists(file))
    if (!exists) {
      if (blob.classification === "durable") {
        return yield* new BackupIntegrityError({
          digest: blob.digest,
          reason: "blob-missing",
          workspaceId: blob.workspaceId
        })
      }
      gaps.push({ digest: blob.digest, reason: "missing", workspaceId: blob.workspaceId })
      continue
    }
    const verified = yield* digestFile(file, "blob", MAXIMUM_BLOB_BYTES).pipe(Effect.result)
    if (
      Result.isFailure(verified) ||
      verified.success.byteLength !== blob.byteLength ||
      verified.success.digest !== blob.digest
    ) {
      if (blob.classification === "durable") {
        return yield* new BackupIntegrityError({
          digest: blob.digest,
          reason: "blob-corrupt",
          workspaceId: blob.workspaceId
        })
      }
      gaps.push({ digest: blob.digest, reason: "corrupt", workspaceId: blob.workspaceId })
    }
  }
  return gaps
})

const verifyOwnerId = Effect.fn("BackupArchive.verifyOwnerId")(function*(
  archiveRoot: string,
  manifest: BackupManifestV1
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const ownerIdFile = path.join(archiveRoot, OWNER_ID_NAME)
  yield* fileSize(ownerIdFile, "manifest", MAXIMUM_OWNER_ID_BYTES)
  const ownerId = yield* mapStorage("read-owner-id", fileSystem.readFileString(ownerIdFile))
  if (ownerId !== manifest.backupId) {
    return yield* new BackupIntegrityError({
      digest: null,
      reason: "unexpected-artifact",
      workspaceId: null
    })
  }
})

/** Verify a complete archive without modifying it. */
export const verifyBackupInternal = Effect.fn("BackupArchive.verify")(function*(
  configuredArchiveRoot: string
): Effect.fn.Return<
  BackupVerification,
  BackupFailure,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const configuredRoot = path.resolve(configuredArchiveRoot)
  const exists = yield* mapStorage("check-archive", fileSystem.exists(configuredRoot))
  if (!exists) return yield* new BackupInputError({ operation: "verify", reason: "invalid-path" })
  const archiveRoot = yield* mapStorage("resolve-archive", fileSystem.realPath(configuredRoot))
  const manifest = yield* readManifest(archiveRoot)
  yield* verifyArchiveTree(archiveRoot, manifest)
  yield* verifyOwnerId(archiveRoot, manifest)
  const databaseFile = path.join(archiveRoot, DATABASE_NAME)
  const databaseDigest = yield* digestFile(databaseFile, "database", MAXIMUM_DATABASE_BYTES)
  if (
    databaseDigest.digest !== manifest.database.digest ||
    databaseDigest.byteLength !== manifest.database.byteLength
  ) {
    return yield* new BackupIntegrityError({
      digest: manifest.database.digest,
      reason: "database-digest-mismatch",
      workspaceId: null
    })
  }
  const inventory = yield* Effect.scoped(inspectSnapshotDatabase(databaseFile))
  yield* verifyManifestInventory(manifest, inventory)
  const reproducibleBlobGaps = yield* verifyBlobs(archiveRoot, manifest)
  return reproducibleBlobGaps.length === 0
    ? { _tag: "Complete", manifest, reproducibleBlobGaps: [] }
    : { _tag: "RecoverableCacheGaps", manifest, reproducibleBlobGaps }
})

const copySnapshotBlobs = Effect.fn("BackupArchive.copySnapshotBlobs")(function*(
  archiveRoot: string,
  persistenceConfig: PersistenceConfig,
  manifestBlobs: BackupManifestV1["blobs"]
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const archiveBlobRoot = path.join(archiveRoot, "blobs")
  for (const blob of manifestBlobs) {
    const source = blobPath(path, persistenceConfig.blobRoot, blob.workspaceId, blob.digest).file
    const destination = blobPath(path, archiveBlobRoot, blob.workspaceId, blob.digest).file
    const sourceExists = yield* mapStorage("check-source-blob", fileSystem.exists(source))
    if (!sourceExists) {
      if (blob.classification === "durable") {
        return yield* new BackupIntegrityError({
          digest: blob.digest,
          reason: "blob-missing",
          workspaceId: blob.workspaceId
        })
      }
      continue
    }
    const sourceDigest = yield* digestFile(source, "blob", MAXIMUM_BLOB_BYTES).pipe(Effect.result)
    const isValid = Result.isSuccess(sourceDigest) &&
      sourceDigest.success.digest === blob.digest && sourceDigest.success.byteLength === blob.byteLength
    if (!isValid) {
      if (blob.classification === "durable") {
        return yield* new BackupIntegrityError({
          digest: blob.digest,
          reason: "blob-corrupt",
          workspaceId: blob.workspaceId
        })
      }
      continue
    }
    yield* ensurePrivateArchiveDirectory(path.dirname(destination))
    yield* mapStorage("copy-blob", fileSystem.copyFile(source, destination))
    yield* mapStorage("secure-blob", fileSystem.chmod(destination, BACKUP_FILE_MODE))
    yield* syncPath(destination)
    yield* syncPath(path.dirname(destination))
  }
})

const hasExpectedOwnerId = Effect.fn("BackupArchive.hasExpectedOwnerId")(function*(
  destination: string,
  backupId: BackupId
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* Effect.gen(function*() {
    const canonicalDestination = yield* fileSystem.realPath(destination)
    const destinationInfo = yield* fileSystem.stat(destination)
    const ownerIdFile = path.join(destination, OWNER_ID_NAME)
    const canonicalOwnerIdFile = yield* fileSystem.realPath(ownerIdFile)
    const ownerInfo = yield* fileSystem.stat(ownerIdFile)
    const ownerId = yield* fileSystem.readFileString(ownerIdFile)
    return canonicalDestination === destination &&
      destinationInfo.type === "Directory" &&
      canonicalOwnerIdFile === ownerIdFile &&
      ownerInfo.type === "File" &&
      ownerId === backupId
  }).pipe(Effect.orElseSucceed(() => false))
})

const removeOwnedDestination = Effect.fn("BackupArchive.removeOwnedDestination")(function*(
  destination: string,
  parent: string,
  backupId: BackupId
) {
  const fileSystem = yield* FileSystem.FileSystem
  if (yield* hasExpectedOwnerId(destination, backupId)) {
    // Effect's portable FileSystem API does not expose descriptor-relative recursive removal.
    // The random owner marker is therefore revalidated immediately before best-effort rollback.
    const removed = yield* fileSystem.remove(destination, { force: true, recursive: true }).pipe(Effect.result)
    if (Result.isSuccess(removed)) yield* syncPath(parent).pipe(Effect.ignore)
  }
})

const removeEmptyDestinationClaim = Effect.fn("BackupArchive.removeEmptyDestinationClaim")(function*(
  destination: string,
  parent: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const removable = yield* Effect.gen(function*() {
    const canonical = yield* fileSystem.realPath(destination)
    const info = yield* fileSystem.stat(destination)
    const entries = yield* fileSystem.readDirectory(destination)
    return canonical === destination && info.type === "Directory" && entries.length === 0
  }).pipe(Effect.orElseSucceed(() => false))
  if (!removable) return

  // Effect FileSystem has no portable rmdir and Node's non-recursive remove rejects
  // directories. Recursive removal is limited to the canonical, still-empty claim.
  // A hostile same-UID process can race this check; such a process can already alter
  // every owner-only backup artifact, so operators must exclude concurrent writers.
  const removed = yield* fileSystem.remove(destination, { recursive: true }).pipe(Effect.result)
  if (Result.isSuccess(removed)) yield* syncPath(parent).pipe(Effect.ignore)
})

const publishPhysicalArchive = Effect.fn("BackupArchive.publishPhysicalArchive")(function*(
  stagingRoot: string,
  destination: string,
  parent: string,
  backupId: BackupId,
  emptyClaimNeedsCleanup: Ref.Ref<boolean>
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const claimed = yield* fileSystem.makeDirectory(destination, { mode: BACKUP_DIRECTORY_MODE }).pipe(Effect.result)
  if (Result.isFailure(claimed)) {
    const targetExists = yield* mapStorage("check-raced-destination", fileSystem.exists(destination))
    if (claimed.failure.reason._tag === "AlreadyExists" || targetExists) {
      return yield* new BackupInputError({ operation: "create", reason: "target-raced" })
    }
    return yield* storageError("claim-archive", claimed.failure)
  }
  yield* Ref.set(emptyClaimNeedsCleanup, true)

  const stagingOwnerId = path.join(stagingRoot, OWNER_ID_NAME)
  const destinationOwnerId = path.join(destination, OWNER_ID_NAME)
  yield* mapStorage(
    "publish-destination-owner-id",
    fileSystem.rename(stagingOwnerId, destinationOwnerId)
  )
  yield* Ref.set(emptyClaimNeedsCleanup, false)
  yield* mapStorage("secure-destination", fileSystem.chmod(destination, BACKUP_DIRECTORY_MODE))
  yield* mapStorage("secure-destination-owner-id", fileSystem.chmod(destinationOwnerId, BACKUP_FILE_MODE))
  yield* syncPath(destination)

  yield* mapStorage(
    "move-database",
    fileSystem.rename(path.join(stagingRoot, DATABASE_NAME), path.join(destination, DATABASE_NAME))
  )
  const stagingBlobs = path.join(stagingRoot, "blobs")
  if (yield* mapStorage("check-staging-blobs", fileSystem.exists(stagingBlobs))) {
    yield* mapStorage("move-blobs", fileSystem.rename(stagingBlobs, path.join(destination, "blobs")))
  }
  yield* syncPath(destination)

  // Manifest-last publication means a crash can leave only an incomplete claim,
  // never a destination that passes verification as a complete backup.
  yield* mapStorage(
    "publish-archive-manifest",
    fileSystem.rename(path.join(stagingRoot, MANIFEST_NAME), path.join(destination, MANIFEST_NAME))
  )
  yield* syncPath(destination)
  yield* syncPath(parent)
})

/** Assemble and publish one physical, portable database-and-blob archive. */
export const createVerifiedArchive = Effect.fn("BackupArchive.create")(function*(
  input: CreateVerifiedArchiveInput
): Effect.fn.Return<
  PublishedBackup,
  BackupFailure,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const destination = path.resolve(input.destination)
  if (path.dirname(destination) === destination) {
    return yield* new BackupInputError({ operation: "create", reason: "invalid-path" })
  }
  if (yield* mapStorage("check-destination", fileSystem.exists(destination))) {
    return yield* new BackupInputError({ operation: "create", reason: "already-exists" })
  }
  const parent = path.dirname(destination)
  yield* ensurePublicationParent(parent)
  const published = yield* Ref.make(false)
  const emptyClaimNeedsCleanup = yield* Ref.make(false)
  const stagingRoot = yield* mapStorage(
    "create-staging-root",
    fileSystem.makeTempDirectory({ directory: parent, prefix: STAGING_PREFIX })
  )
  yield* Effect.addFinalizer(() => fileSystem.remove(stagingRoot, { force: true, recursive: true }).pipe(Effect.ignore))
  yield* mapStorage("secure-staging-root", fileSystem.chmod(stagingRoot, BACKUP_DIRECTORY_MODE))
  const databaseFile = path.join(stagingRoot, DATABASE_NAME)
  yield* input.writeDatabase(databaseFile)
  yield* mapStorage("secure-database", fileSystem.chmod(databaseFile, BACKUP_FILE_MODE))
  yield* syncPath(databaseFile)
  const inventory = yield* Effect.scoped(inspectSnapshotDatabase(databaseFile))
  yield* copySnapshotBlobs(stagingRoot, input.persistenceConfig, inventory.blobs)
  const database = yield* digestFile(databaseFile, "database", MAXIMUM_DATABASE_BYTES)
  const backupId = yield* cryptoService.randomUUIDv7.pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(BackupId)(value)),
    Effect.mapError((cause) => storageError("create-backup-id", cause))
  )
  const ownerIdFile = path.join(stagingRoot, OWNER_ID_NAME)
  yield* mapStorage(
    "write-owner-id",
    fileSystem.writeFileString(ownerIdFile, backupId, {
      flag: "wx",
      mode: BACKUP_FILE_MODE
    })
  )
  yield* mapStorage("secure-owner-id", fileSystem.chmod(ownerIdFile, BACKUP_FILE_MODE))
  yield* syncPath(ownerIdFile)
  const manifest: BackupManifestV1 = {
    backupId,
    blobs: inventory.blobs,
    boundary: inventory.boundary,
    counts: {
      durable: inventory.blobs.filter(({ classification }) => classification === "durable").length,
      reproducibleCache: inventory.blobs.filter(
        ({ classification }) => classification === "reproducible-cache"
      ).length,
      total: inventory.blobs.length
    },
    createdAt: yield* DateTime.now,
    database: { byteLength: database.byteLength, digest: database.digest, relativePath: DATABASE_NAME },
    format: "@knpkv/control-center-backup",
    kind: input.kind,
    schemaVersion: inventory.schemaVersion,
    version: 1
  }
  const manifestSource = yield* Schema.encodeEffect(BackupManifestJsonV1)(manifest).pipe(
    Effect.mapError(() => new BackupManifestError({ reason: "malformed" }))
  )
  const pendingManifest = path.join(stagingRoot, `.manifest-${backupId}`)
  const manifestFile = path.join(stagingRoot, MANIFEST_NAME)
  yield* mapStorage(
    "write-manifest",
    fileSystem.writeFileString(pendingManifest, manifestSource, {
      flag: "wx",
      mode: BACKUP_FILE_MODE
    })
  )
  yield* mapStorage("secure-manifest", fileSystem.chmod(pendingManifest, BACKUP_FILE_MODE))
  yield* syncPath(pendingManifest)
  yield* mapStorage("publish-manifest", fileSystem.rename(pendingManifest, manifestFile))
  yield* syncPath(stagingRoot)
  yield* verifyBackupInternal(stagingRoot)
  yield* Effect.addFinalizer(() =>
    Ref.get(published).pipe(
      Effect.flatMap((isPublished) =>
        isPublished
          ? Effect.void
          : removeOwnedDestination(destination, parent, backupId).pipe(
            Effect.andThen(
              Ref.get(emptyClaimNeedsCleanup).pipe(
                Effect.flatMap((needsCleanup) =>
                  needsCleanup ? removeEmptyDestinationClaim(destination, parent) : Effect.void
                )
              )
            )
          )
      )
    )
  )
  const verification = yield* Effect.uninterruptible(
    Effect.gen(function*() {
      yield* publishPhysicalArchive(stagingRoot, destination, parent, backupId, emptyClaimNeedsCleanup)
      yield* mapStorage("remove-staging-root", fileSystem.remove(stagingRoot, { recursive: true }))
      const verification = yield* verifyBackupInternal(destination)
      yield* Ref.set(published, true)
      return verification
    })
  )
  return { archiveRoot: destination, verification }
})
