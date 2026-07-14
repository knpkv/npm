import { Schema } from "effect"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { BlobDigest } from "../object-store/BlobDigest.js"

const BackupOperation = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
)

/** Untrusted archive or destination input did not satisfy the local operation contract. */
export class BackupInputError extends Schema.TaggedErrorClass<BackupInputError>()("BackupInputError", {
  operation: BackupOperation,
  reason: Schema.Literals(["already-exists", "invalid-path", "overlap", "target-raced"])
}) {}

/** An archive artifact exceeded a documented bounded-read limit. */
export class BackupLimitError extends Schema.TaggedErrorClass<BackupLimitError>()("BackupLimitError", {
  artifact: Schema.Literals(["blob", "database", "manifest"]),
  maximumBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
}) {}

/** A platform storage operation failed without exposing its path or host cause. */
export class BackupStorageError extends Schema.TaggedErrorClass<BackupStorageError>()("BackupStorageError", {
  operation: BackupOperation
}) {}

/** A database snapshot or integrity operation failed. */
export class BackupSqlError extends Schema.TaggedErrorClass<BackupSqlError>()("BackupSqlError", {
  operation: BackupOperation
}) {}

/** The manifest is malformed, unsupported, or inconsistent with its snapshot. */
export class BackupManifestError extends Schema.TaggedErrorClass<BackupManifestError>()(
  "BackupManifestError",
  {
    reason: Schema.Literals([
      "blob-count-mismatch",
      "blob-inventory-mismatch",
      "boundary-mismatch",
      "duplicate-blob",
      "malformed",
      "migration-ledger-mismatch",
      "unsorted-blob-inventory",
      "unsupported"
    ])
  }
) {}

/** Authoritative database or blob evidence did not pass integrity verification. */
export class BackupIntegrityError extends Schema.TaggedErrorClass<BackupIntegrityError>()(
  "BackupIntegrityError",
  {
    digest: Schema.NullOr(BlobDigest),
    reason: Schema.Literals([
      "blob-corrupt",
      "blob-missing",
      "database-corrupt",
      "database-digest-mismatch",
      "foreign-key-violation",
      "owner-mode-invalid",
      "unexpected-artifact"
    ]),
    workspaceId: Schema.NullOr(WorkspaceId)
  }
) {}

/** The scoped SQLite write barrier could not be acquired before migration. */
export class MigrationWriteBarrierError extends Schema.TaggedErrorClass<MigrationWriteBarrierError>()(
  "MigrationWriteBarrierError",
  { phase: Schema.Literals(["acquire", "verify"]) }
) {}

/** Typed failures exposed by backup, verification, and restore operations. */
export type BackupFailure =
  | BackupInputError
  | BackupIntegrityError
  | BackupLimitError
  | BackupManifestError
  | BackupSqlError
  | BackupStorageError
