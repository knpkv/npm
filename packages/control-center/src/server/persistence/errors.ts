import * as Schema from "effect/Schema"
import { WorkspaceId } from "../../domain/identifiers.js"
import { BlobDigest } from "./object-store/BlobDigest.js"

const RecordKind = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
)

/** Maximum diagnostic identity retained by persistence-domain errors. */
export const MAXIMUM_PERSISTENCE_RECORD_KEY_LENGTH = 500

const RecordKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAXIMUM_PERSISTENCE_RECORD_KEY_LENGTH)
)

const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

/** Raised when persistence configuration cannot be decoded safely. */
export class PersistenceConfigError extends Schema.TaggedError<PersistenceConfigError>()(
  "PersistenceConfigError",
  {
    message: Schema.String
  }
) {}

/** Raised when a database startup operation fails. */
export class DatabaseInitializationError extends Schema.TaggedError<DatabaseInitializationError>()(
  "DatabaseInitializationError",
  {
    operation: Schema.Literals([
      "connect",
      "configure",
      "initialize-schema",
      "verify-integrity",
      "verify-pragmas",
      "verify-schema"
    ])
  }
) {}

/** Raised when a workspace-scoped persisted record does not exist. */
export class RecordNotFoundError extends Schema.TaggedError<RecordNotFoundError>()(
  "RecordNotFoundError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Raised when creating a record would replace an existing workspace-scoped identity. */
export class RecordAlreadyExistsError extends Schema.TaggedError<RecordAlreadyExistsError>()(
  "RecordAlreadyExistsError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Raised when a workspace has reached its bounded plugin-connection capacity. */
export class PluginConnectionLimitError extends Schema.TaggedError<PluginConnectionLimitError>()(
  "PluginConnectionLimitError",
  {
    maximum: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    workspaceId: WorkspaceId
  }
) {}

/** Raised when an entity update attempts to replace its immutable vendor identity. */
export class SourceIdentityMismatchError extends Schema.TaggedError<SourceIdentityMismatchError>()(
  "SourceIdentityMismatchError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}

/** Stable boundary error for a failed persistence operation. */
export class PersistenceOperationError extends Schema.TaggedError<PersistenceOperationError>()(
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
export class ContentMetadataMismatchError extends Schema.TaggedError<ContentMetadataMismatchError>()(
  "ContentMetadataMismatchError",
  {
    digest: BlobDigest,
    workspaceId: WorkspaceId
  }
) {}

/** Reproducible bytes are unavailable and the owning adapter may safely refetch them. */
export class ReproducibleContentUnavailableError extends Schema.TaggedError<
  ReproducibleContentUnavailableError
>()(
  "ReproducibleContentUnavailableError",
  {
    digest: BlobDigest,
    workspaceId: WorkspaceId,
    reason: Schema.Literals(["corrupt", "missing"]),
    recovery: Schema.Literal("refetch")
  }
) {}

/** Raised when a compare-and-swap update observes a different persisted revision. */
export class RevisionConflictError extends Schema.TaggedError<RevisionConflictError>()(
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
export class SecretReferenceScopeConflictError extends Schema.TaggedError<SecretReferenceScopeConflictError>()(
  "SecretReferenceScopeConflictError",
  {}
) {}

/** Raised when a persisted record cannot be decoded into its trusted domain model. */
export class PersistedRecordError extends Schema.TaggedError<PersistedRecordError>()(
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

/** A settings mutation did not acknowledge the exact governed sections it changes. */
export class WorkspaceSettingsGovernanceError extends Schema.TaggedError<
  WorkspaceSettingsGovernanceError
>()("WorkspaceSettingsGovernanceError", {}) {}

/** A settings mutation identity was already committed with different semantics. */
export class WorkspaceSettingsMutationConflictError extends Schema.TaggedError<
  WorkspaceSettingsMutationConflictError
>()("WorkspaceSettingsMutationConflictError", {}) {}

/** A complete settings replacement did not change the current aggregate. */
export class WorkspaceSettingsNoChangesError extends Schema.TaggedError<
  WorkspaceSettingsNoChangesError
>()("WorkspaceSettingsNoChangesError", {}) {}

/** Raised when a bounded quarantine diagnostic cannot be persisted. */
export class QuarantineWriteError extends Schema.TaggedError<QuarantineWriteError>()(
  "QuarantineWriteError",
  {
    recordKey: RecordKey,
    recordKind: RecordKind,
    workspaceId: WorkspaceId
  }
) {}
