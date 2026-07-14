import * as Schema from "effect/Schema"
import { WorkspaceId } from "../../domain/identifiers.js"
import { BlobDigest } from "./object-store/BlobDigest.js"

const RecordKind = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
)

const RecordKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500)
)

const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

/** Raised when persistence configuration cannot be decoded safely. */
export class PersistenceConfigError extends Schema.TaggedErrorClass<PersistenceConfigError>()(
  "PersistenceConfigError",
  {
    message: Schema.String
  }
) {}

/** Raised when a database startup operation fails. */
export class DatabaseInitializationError extends Schema.TaggedErrorClass<DatabaseInitializationError>()(
  "DatabaseInitializationError",
  {
    operation: Schema.Literals([
      "connect",
      "configure",
      "migrate",
      "verify-ledger",
      "verify-pragmas"
    ])
  }
) {}

/** Raised when the migration ledger is not an exact supported prefix or final ledger. */
export class MigrationLedgerError extends Schema.TaggedErrorClass<MigrationLedgerError>()(
  "MigrationLedgerError",
  {
    actual: Schema.Array(Schema.String),
    expected: Schema.Array(Schema.String),
    phase: Schema.Literals(["before-migration", "after-migration"])
  }
) {}

/** Raised when a workspace-scoped persisted record does not exist. */
export class RecordNotFoundError extends Schema.TaggedErrorClass<RecordNotFoundError>()(
  "RecordNotFoundError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Raised when creating a record would replace an existing workspace-scoped identity. */
export class RecordAlreadyExistsError extends Schema.TaggedErrorClass<RecordAlreadyExistsError>()(
  "RecordAlreadyExistsError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Raised when an entity update attempts to replace its immutable vendor identity. */
export class SourceIdentityMismatchError extends Schema.TaggedErrorClass<SourceIdentityMismatchError>()(
  "SourceIdentityMismatchError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Stable boundary error for a failed persistence operation. */
export class PersistenceOperationError extends Schema.TaggedErrorClass<PersistenceOperationError>()(
  "PersistenceOperationError",
  {
    operation: Schema.String.check(
      Schema.isTrimmed(),
      Schema.isNonEmpty(),
      Schema.isMaxLength(100)
    )
  }
) {}

/** Raised when identical content bytes are registered with conflicting durable metadata. */
export class ContentMetadataMismatchError extends Schema.TaggedErrorClass<ContentMetadataMismatchError>()(
  "ContentMetadataMismatchError",
  {
    digest: BlobDigest,
    workspaceId: WorkspaceId
  }
) {}

/** Raised when a compare-and-swap update observes a different persisted revision. */
export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "RevisionConflictError",
  {
    actualRevision: Schema.Union([Revision, Schema.Null]),
    expectedRevision: Revision,
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Raised when an opaque secret reference is reused outside its durable first-use scope. */
export class SecretReferenceScopeConflictError extends Schema.TaggedErrorClass<SecretReferenceScopeConflictError>()(
  "SecretReferenceScopeConflictError",
  {}
) {}

/** Raised when a persisted record cannot be decoded into its trusted domain model. */
export class PersistedRecordError extends Schema.TaggedErrorClass<PersistedRecordError>()(
  "PersistedRecordError",
  {
    diagnosticCode: Schema.String.check(
      Schema.isTrimmed(),
      Schema.isNonEmpty(),
      Schema.isMaxLength(100)
    ),
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Raised when a bounded quarantine diagnostic cannot be persisted. */
export class QuarantineWriteError extends Schema.TaggedErrorClass<QuarantineWriteError>()(
  "QuarantineWriteError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}
