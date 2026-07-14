import type { Crypto } from "effect"
import { Effect, FileSystem, Path, Predicate, Result } from "effect"
import type * as Scope from "effect/Scope"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

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
import { vacuumDatabaseInto } from "./DatabaseSnapshot.js"
import { type BackupFailure, BackupInputError, BackupStorageError } from "./errors.js"

/** Input for a caller-requested backup of the live database. */
export interface CreateVerifiedBackupInput {
  readonly destination: string
  readonly persistenceConfig: PersistenceConfig
  readonly sql: SqlClient.SqlClient
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
    Effect.mapError(() => new BackupStorageError({ operation: "resolve-restore-archive" }))
  )
  const configured = yield* decodeControlCenterDataPaths(input.configuredDataRoot).pipe(
    Effect.mapError(() => new BackupInputError({ operation: "restore", reason: "invalid-path" }))
  )
  const prospectiveDataRoot = yield* canonicalProspectiveDataRoot(configured.dataRoot).pipe(
    Effect.mapError(() => new BackupStorageError({ operation: "resolve-restore-target" }))
  )
  const relativeArchive = path.relative(prospectiveDataRoot, archiveRoot)
  const relativeTarget = path.relative(archiveRoot, prospectiveDataRoot)
  const overlaps = relativeArchive === "" || relativeTarget === "" ||
    (!relativeArchive.startsWith("..") && !path.isAbsolute(relativeArchive)) ||
    (!relativeTarget.startsWith("..") && !path.isAbsolute(relativeTarget))
  if (overlaps) return yield* new BackupInputError({ operation: "restore", reason: "overlap" })
  const targetExists = yield* fileSystem.exists(configured.dataRoot).pipe(
    Effect.mapError(() => new BackupStorageError({ operation: "check-restore-target" }))
  )
  const targetIsSymlink = yield* fileSystem.readLink(configured.dataRoot).pipe(
    Effect.result,
    Effect.map(Result.isSuccess)
  )
  if (targetExists || targetIsSymlink) {
    return yield* new BackupInputError({ operation: "restore", reason: "already-exists" })
  }

  yield* ensureFreshDataRootParent(configured.dataRoot).pipe(
    Effect.mapError((error) => new BackupStorageError({ operation: `create-restore-parent-${error.reason}` }))
  )
  const location = yield* inspectFreshDataRootClaim(configured.dataRoot).pipe(
    Effect.mapError(() => new BackupStorageError({ operation: "inspect-restore-parent" }))
  )
  if (location.canonicalDataRoot !== prospectiveDataRoot) {
    return yield* new BackupStorageError({ operation: "restore-parent-changed" })
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
        return new BackupStorageError({ operation: `publish-restore-${failure.reason}` })
      }
      if (Predicate.isTagged(failure, "PersistenceConfigError")) {
        return new BackupStorageError({ operation: "initialize-restore-data-root" })
      }
      return failure
    }))
  )
  return {
    configuredDataRoot: configured.dataRoot,
    verification
  }
})
