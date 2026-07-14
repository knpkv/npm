import { Schema } from "effect"

import { WorkspaceId } from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { BlobDigest } from "../object-store/BlobDigest.js"
import { BlobClassification } from "../object-store/BlobRef.js"

const CANONICAL_UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const NonNegativeInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

/** Stable identity of one published backup archive. */
export const BackupId = Schema.String.check(
  Schema.isUUID(7),
  Schema.isPattern(CANONICAL_UUID_V7_PATTERN, { expected: "a canonical lowercase UUID v7" })
).pipe(Schema.brand("BackupId"))

/** Stable identity of one published backup archive. */
export type BackupId = typeof BackupId.Type

/** Exact migration entry captured by a database snapshot. */
export const BackupMigrationEntry = Schema.Struct({
  migrationId: PositiveInteger,
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(255))
})

/** Exact migration entry captured by a database snapshot. */
export type BackupMigrationEntry = typeof BackupMigrationEntry.Type

/** Commit boundary and row counts captured from the verified database snapshot. */
export const BackupBoundaryV1 = Schema.Struct({
  domainEventCursor: NonNegativeInteger,
  domainEventRows: NonNegativeInteger,
  entityRevisionRows: NonNegativeInteger,
  highestEntityRevision: NonNegativeInteger,
  highestReleaseRevision: NonNegativeInteger,
  releaseRevisionRows: NonNegativeInteger
})

/** Commit boundary and row counts captured from the verified database snapshot. */
export type BackupBoundaryV1 = typeof BackupBoundaryV1.Type

/** One content-addressed object expected by the snapshot database. */
export const BackupBlobEntryV1 = Schema.Struct({
  byteLength: NonNegativeInteger,
  classification: BlobClassification,
  digest: BlobDigest,
  workspaceId: WorkspaceId
})

/** One content-addressed object expected by the snapshot database. */
export type BackupBlobEntryV1 = typeof BackupBlobEntryV1.Type

/** Database artifact included in every Control Center backup. */
export const BackupDatabaseArtifactV1 = Schema.Struct({
  byteLength: PositiveInteger,
  digest: BlobDigest,
  relativePath: Schema.Literal("control-center.db")
})

/** Database artifact included in every Control Center backup. */
export type BackupDatabaseArtifactV1 = typeof BackupDatabaseArtifactV1.Type

/** Count summary cross-checked against the exact blob inventory. */
export const BackupBlobCountsV1 = Schema.Struct({
  durable: NonNegativeInteger,
  reproducibleCache: NonNegativeInteger,
  total: NonNegativeInteger
})

/** Strict first version of the portable Control Center backup manifest. */
export const BackupManifestV1 = Schema.Struct({
  backupId: BackupId,
  blobs: Schema.Array(BackupBlobEntryV1),
  boundary: BackupBoundaryV1,
  counts: BackupBlobCountsV1,
  createdAt: UtcTimestamp,
  database: BackupDatabaseArtifactV1,
  format: Schema.Literal("@knpkv/control-center-backup"),
  kind: Schema.Literals(["manual", "pre-migration"]),
  migrations: Schema.Array(BackupMigrationEntry),
  version: Schema.Literal(1)
}).annotate({ identifier: "BackupManifestV1" })

/** Strict first version of the portable Control Center backup manifest. */
export type BackupManifestV1 = typeof BackupManifestV1.Type

/** JSON codec used exclusively at the owner-controlled archive boundary. */
export const BackupManifestJsonV1 = Schema.fromJsonString(BackupManifestV1)

/** Reproducible object that can be recovered rather than making restore fail. */
export const ReproducibleBlobGap = Schema.Struct({
  digest: BlobDigest,
  reason: Schema.Literals(["corrupt", "missing"]),
  workspaceId: WorkspaceId
})

/** Reproducible object that can be recovered rather than making restore fail. */
export type ReproducibleBlobGap = typeof ReproducibleBlobGap.Type

/** Verified archive state; only reproducible content may produce a degraded success. */
export type BackupVerification =
  | {
    readonly _tag: "Complete"
    readonly manifest: BackupManifestV1
    readonly reproducibleBlobGaps: readonly []
  }
  | {
    readonly _tag: "RecoverableCacheGaps"
    readonly manifest: BackupManifestV1
    readonly reproducibleBlobGaps: ReadonlyArray<ReproducibleBlobGap>
  }

/** Result returned after exclusive destination claim, manifest-last completion, and verification. */
export interface PublishedBackup {
  readonly archiveRoot: string
  readonly verification: BackupVerification
}
