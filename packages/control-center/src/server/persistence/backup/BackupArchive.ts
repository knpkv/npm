import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient"
import type { Crypto } from "effect"
import { Context, Effect, FileSystem, Layer, Option, Path, Predicate, Result } from "effect"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"

import {
  canonicalProspectiveDataRoot,
  decodeControlCenterDataPaths,
  ensureFreshDataRootParent,
  inspectFreshDataRootClaim,
  publishFreshDataRootClaim
} from "../../DataRootProtocol.js"
import type { PersistenceConfig } from "../PersistenceConfig.js"
import { createVerifiedArchive, restoreVerifiedArchiveInto, verifyBackupInternal } from "./BackupArchiveCore.js"
import type { BackupVerification, PublishedBackup, RestoredBackup } from "./BackupManifest.js"
import { readDatabaseSnapshotInventory, vacuumDatabaseInto } from "./DatabaseSnapshot.js"
import { type BackupFailure, BackupInputError, BackupSqlError, BackupStorageError } from "./errors.js"

interface LocalLibsqlConfig extends LibsqlClient.LibsqlClientConfig.Full {
  readonly timeout: number
}

const snakeToCamel = (value: string): string =>
  value.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase())

const isSameOrDescendantPath = (path: Path.Path, ancestor: string, candidate: string): boolean => {
  const relative = path.relative(ancestor, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const pathsOverlap = (path: Path.Path, left: string, right: string): boolean =>
  isSameOrDescendantPath(path, left, right) || isSameOrDescendantPath(path, right, left)

const sameOwner = (left: FileSystem.File.Info, right: FileSystem.File.Info): boolean =>
  Option.isSome(left.uid) && Option.isSome(right.uid) && left.uid.value === right.uid.value

const offlineInvariant = (reason: string) => ({ _tag: "BackupInvariant", reason })

/** Input for a caller-requested backup of the live database. */
export interface CreateVerifiedBackupInput {
  readonly destination: string
  readonly persistenceConfig: PersistenceConfig
  readonly sql: SqlClient.SqlClient
}

/** Input for an offline backup that opens an existing database without running migrations. */
export interface CreateOfflineVerifiedBackupInput {
  readonly destination: string
  readonly persistenceConfig: PersistenceConfig
}

/** Input for restoring a verified archive into a nonexistent configured data root. */
export interface RestoreBackupInput {
  readonly archiveRoot: string
  readonly configuredDataRoot: string
}

/** Verify a complete physical archive without modifying it. */
export const verifyBackup = Effect.fn("BackupArchive.verifyPublic")(function*(
  configuredArchiveRoot: string
): Effect.fn.Return<
  BackupVerification,
  BackupFailure,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  return yield* verifyBackupInternal(configuredArchiveRoot)
})

/** Create and verify a portable manual backup using SQLite's consistent snapshot operation. */
export const createVerifiedBackup = Effect.fn("BackupArchive.createManual")(function*(
  input: CreateVerifiedBackupInput
): Effect.fn.Return<
  PublishedBackup,
  BackupFailure,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  return yield* createVerifiedArchive({
    destination: input.destination,
    kind: "manual",
    persistenceConfig: input.persistenceConfig,
    writeDatabase: (destination) => vacuumDatabaseInto(input.sql, destination)
  })
})

/** Create a verified backup from an existing, stopped data root without running migrations. */
export const createOfflineVerifiedBackup = Effect.fn("BackupArchive.createOffline")(function*(
  input: CreateOfflineVerifiedBackupInput
): Effect.fn.Return<
  PublishedBackup,
  BackupFailure,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sourceRoot = path.dirname(input.persistenceConfig.blobRoot)
  const canonicalSourceRoot = yield* fileSystem.realPath(sourceRoot).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "resolve-offline-data-root" }))
  )
  const sourceRootInfo = yield* fileSystem.stat(sourceRoot).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "inspect-offline-data-root" }))
  )
  if (
    canonicalSourceRoot !== sourceRoot ||
    sourceRootInfo.type !== "Directory" ||
    (sourceRootInfo.mode & 0o777) !== 0o700 ||
    Option.isNone(sourceRootInfo.uid) ||
    Option.isNone(sourceRootInfo.ino)
  ) {
    return yield* new BackupStorageError({
      cause: offlineInvariant("source-root-not-private-canonical-directory"),
      operation: "inspect-offline-data-root"
    })
  }
  const canonicalDestination = yield* canonicalProspectiveDataRoot(input.destination).pipe(
    Effect.mapError(() => new BackupInputError({ operation: "create", reason: "invalid-path" }))
  )
  if (pathsOverlap(path, canonicalSourceRoot, canonicalDestination)) {
    return yield* new BackupInputError({ operation: "create", reason: "overlap" })
  }

  const databaseFile = yield* path.fromFileUrl(new URL(input.persistenceConfig.databaseUrl)).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "resolve-offline-database" }))
  )
  const canonicalDatabase = yield* fileSystem.realPath(databaseFile).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "resolve-offline-database" }))
  )
  const databaseInfo = yield* fileSystem.stat(databaseFile).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "inspect-offline-database" }))
  )
  if (
    canonicalDatabase !== databaseFile ||
    path.dirname(databaseFile) !== sourceRoot ||
    databaseInfo.type !== "File" ||
    !sameOwner(sourceRootInfo, databaseInfo)
  ) {
    return yield* new BackupStorageError({
      cause: offlineInvariant("database-not-canonical-regular-owned-file"),
      operation: "inspect-offline-database"
    })
  }

  return yield* Effect.scoped(
    Effect.gen(function*() {
      const snapshotRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "control-center-offline-snapshot-"
      }).pipe(
        Effect.mapError((cause) => new BackupStorageError({ cause, operation: "create-offline-snapshot" }))
      )
      const snapshotDatabase = path.join(snapshotRoot, "control-center.db")
      yield* fileSystem.copyFile(databaseFile, snapshotDatabase).pipe(
        Effect.mapError((cause) => new BackupStorageError({ cause, operation: "copy-offline-database" }))
      )

      for (const suffix of ["-wal", "-journal"]) {
        const sourceSidecar = `${databaseFile}${suffix}`
        const sidecarExists = yield* fileSystem.exists(sourceSidecar).pipe(
          Effect.mapError((cause) => new BackupStorageError({ cause, operation: "inspect-offline-sidecar" }))
        )
        if (!sidecarExists) continue
        const canonicalSidecar = yield* fileSystem.realPath(sourceSidecar).pipe(
          Effect.mapError((cause) => new BackupStorageError({ cause, operation: "inspect-offline-sidecar" }))
        )
        const sidecarInfo = yield* fileSystem.stat(sourceSidecar).pipe(
          Effect.mapError((cause) => new BackupStorageError({ cause, operation: "inspect-offline-sidecar" }))
        )
        if (
          canonicalSidecar !== sourceSidecar ||
          sidecarInfo.type !== "File" ||
          !sameOwner(sourceRootInfo, sidecarInfo)
        ) {
          return yield* new BackupStorageError({
            cause: offlineInvariant("sidecar-not-canonical-regular-owned-file"),
            operation: "inspect-offline-sidecar"
          })
        }
        yield* fileSystem.copyFile(sourceSidecar, `${snapshotDatabase}${suffix}`).pipe(
          Effect.mapError((cause) => new BackupStorageError({ cause, operation: "copy-offline-sidecar" }))
        )
      }

      const clientConfig: LocalLibsqlConfig = {
        concurrency: input.persistenceConfig.maxConnections,
        timeout: input.persistenceConfig.busyTimeoutMilliseconds,
        transformResultNames: snakeToCamel,
        url: `file:${snapshotDatabase}`
      }
      const context = yield* Layer.build(LibsqlClient.layer(clientConfig)).pipe(
        Effect.catchCause((cause) => new BackupSqlError({ cause, operation: "connect-offline-snapshot" }))
      )
      const sql = Context.get(context, SqlClient.SqlClient)
      yield* readDatabaseSnapshotInventory(sql)
      return yield* createVerifiedArchive({
        destination: input.destination,
        kind: "manual",
        persistenceConfig: input.persistenceConfig,
        writeDatabase: (destination) => vacuumDatabaseInto(sql, destination)
      })
    })
  )
})

/** Verify, restore, revalidate, and exclusively publish a fresh Control Center data root. */
export const restoreBackup = Effect.fn("BackupArchive.restore")(function*(
  input: RestoreBackupInput
): Effect.fn.Return<
  RestoredBackup,
  BackupFailure,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const verification = yield* verifyBackupInternal(input.archiveRoot)
  const archiveRoot = yield* fileSystem.realPath(path.resolve(input.archiveRoot)).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "resolve-restore-archive" }))
  )
  const configured = yield* decodeControlCenterDataPaths(input.configuredDataRoot).pipe(
    Effect.mapError(() => new BackupInputError({ operation: "restore", reason: "invalid-path" }))
  )
  const prospectiveDataRoot = yield* canonicalProspectiveDataRoot(configured.dataRoot).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "resolve-restore-target" }))
  )
  if (pathsOverlap(path, prospectiveDataRoot, archiveRoot)) {
    return yield* new BackupInputError({ operation: "restore", reason: "overlap" })
  }
  const targetExists = yield* fileSystem.exists(configured.dataRoot).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "check-restore-target" }))
  )
  const targetIsSymlink = yield* fileSystem.readLink(configured.dataRoot).pipe(
    Effect.result,
    Effect.map(Result.isSuccess)
  )
  if (targetExists || targetIsSymlink) {
    return yield* new BackupInputError({ operation: "restore", reason: "already-exists" })
  }

  yield* ensureFreshDataRootParent(configured.dataRoot).pipe(
    Effect.mapError((cause) =>
      new BackupStorageError({
        cause,
        operation: `create-restore-parent-${cause.reason}`
      })
    )
  )
  const location = yield* inspectFreshDataRootClaim(configured.dataRoot).pipe(
    Effect.mapError((cause) => new BackupStorageError({ cause, operation: "inspect-restore-parent" }))
  )
  if (location.canonicalDataRoot !== prospectiveDataRoot) {
    return yield* new BackupStorageError({
      cause: offlineInvariant("restore-parent-identity-changed"),
      operation: "restore-parent-changed"
    })
  }
  yield* Effect.uninterruptibleMask((restore) =>
    restore(publishFreshDataRootClaim(
      location,
      true,
      (operational, canonical) =>
        restoreVerifiedArchiveInto(
          archiveRoot,
          operational.dataRoot,
          canonical.dataRoot,
          operational.persistenceConfig,
          verification
        )
    )).pipe(Effect.mapError((failure) => {
      if (Predicate.isTagged(failure, "FreshDataRootClaimConflict")) {
        return new BackupInputError({ operation: "restore", reason: "target-raced" })
      }
      if (Predicate.isTagged(failure, "DataRootProtocolError")) {
        return new BackupStorageError({ cause: failure, operation: `publish-restore-${failure.reason}` })
      }
      if (Predicate.isTagged(failure, "PersistenceConfigError")) {
        return new BackupStorageError({ cause: failure, operation: "initialize-restore-data-root" })
      }
      return failure
    }))
  )
  return {
    configuredDataRoot: configured.dataRoot,
    verification
  }
})
