import type { Crypto, FileSystem, Path } from "effect"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import type * as SqlClient from "effect/unstable/sql/SqlClient"

import type { PersistenceConfig } from "../PersistenceConfig.js"
import { createVerifiedArchive, verifyBackupInternal } from "./BackupArchiveCore.js"
import type { BackupVerification, PublishedBackup } from "./BackupManifest.js"
import { vacuumDatabaseInto } from "./DatabaseSnapshot.js"
import type { BackupFailure } from "./errors.js"

/** Input for a caller-requested backup of the live database. */
export interface CreateVerifiedBackupInput {
  readonly destination: string
  readonly persistenceConfig: PersistenceConfig
  readonly sql: SqlClient.SqlClient
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
