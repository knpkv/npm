import type { Crypto, Path } from "effect"
import { Effect, FileSystem } from "effect"
import type * as Scope from "effect/Scope"

import type { PersistenceConfig } from "../PersistenceConfig.js"
import { createVerifiedArchive } from "./BackupArchiveCore.js"
import type { PublishedBackup } from "./BackupManifest.js"
import { type BackupFailure, BackupStorageError } from "./errors.js"

/** Internal input for the database-owned pre-migration snapshot path. */
export interface CreateVerifiedPreMigrationBackupInput {
  readonly databaseSourceFile: string
  readonly destination: string
  readonly persistenceConfig: PersistenceConfig
}

/** Copy a database proven quiescent by Database's migration write barrier into a verified archive. */
export const createVerifiedPreMigrationBackup = Effect.fn(
  "BackupArchive.createPreMigration"
)(function*(
  input: CreateVerifiedPreMigrationBackupInput
): Effect.fn.Return<
  PublishedBackup,
  BackupFailure,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  return yield* createVerifiedArchive({
    destination: input.destination,
    kind: "pre-migration",
    persistenceConfig: input.persistenceConfig,
    writeDatabase: (destination) =>
      Effect.flatMap(
        FileSystem.FileSystem,
        (fileSystem) =>
          fileSystem.copyFile(input.databaseSourceFile, destination).pipe(
            Effect.mapError(() => new BackupStorageError({ operation: "copy-database-snapshot" }))
          )
      )
  })
})
