import * as Schema from "effect/Schema"

import { Person, RoleAssignment } from "../../../domain/actors.js"
import { EntityId, PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import { Release } from "../../../domain/release.js"
import { ProviderId, SourceRevision } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { BlobDigest } from "../object-store/BlobDigest.js"
import { BlobClassification } from "../object-store/BlobRef.js"

const boundedName = (identifier: string) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)).annotate({ identifier })

/** Positive optimistic-concurrency revision stored with mutable records. */
export const RecordRevision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)).pipe(
  Schema.brand("RecordRevision")
)

/** Decoded optimistic-concurrency revision. */
export type RecordRevision = typeof RecordRevision.Type

/** Workspace name shown in navigation and administrative surfaces. */
export const WorkspaceName = boundedName("WorkspaceName").pipe(Schema.brand("WorkspaceName"))

/** Decoded workspace display name. */
export type WorkspaceName = typeof WorkspaceName.Type

/** Persisted workspace row exposed by the workspace repository. */
export const WorkspaceRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  displayName: WorkspaceName,
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

/** Decoded persisted workspace row. */
export type WorkspaceRecord = typeof WorkspaceRecord.Type

/** Plugin-connection label shown without exposing credentials or configuration. */
export const PluginConnectionDisplayName = boundedName("PluginConnectionDisplayName").pipe(
  Schema.brand("PluginConnectionDisplayName")
)

/** Decoded plugin-connection display name. */
export type PluginConnectionDisplayName = typeof PluginConnectionDisplayName.Type

/** Public, non-secret metadata for a configured plugin connection. */
export const PluginConnectionRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  displayName: PluginConnectionDisplayName,
  isEnabled: Schema.Boolean,
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

/** Decoded plugin-connection metadata. */
export type PluginConnectionRecord = typeof PluginConnectionRecord.Type

/** Provider-neutral category of a normalized delivery entity. */
export const EntityKind = Schema.Literals([
  "issue",
  "pull-request",
  "page",
  // Kept for v1–v7 databases; new CodePipeline writes use the execution kind.
  "pipeline",
  "pipeline-execution",
  "deployment",
  "time-entry"
])

/** Decoded normalized entity category. */
export type EntityKind = typeof EntityKind.Type

/** Current normalized entity and exact provider revision that produced it. */
export const EntityRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  entityId: EntityId,
  entityType: EntityKind,
  sourceRevision: SourceRevision,
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

/** Decoded persisted normalized entity. */
export type EntityRecord = typeof EntityRecord.Type

/** Canonical person stored within one workspace. */
export const PersonRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  person: Person,
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

/** Decoded canonical person record. */
export type PersonRecord = typeof PersonRecord.Type

/** Workspace-bound collaborator role assignment. */
export const RoleAssignmentRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  assignment: RoleAssignment,
  revision: RecordRevision,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp
})

/** Decoded collaborator role-assignment record. */
export type RoleAssignmentRecord = typeof RoleAssignmentRecord.Type

/** Immutable decoded release snapshot and its repository revision. */
export const ReleaseSnapshotRecord = Schema.Struct({
  release: Release,
  revision: RecordRevision
})

/** Decoded immutable release snapshot. */
export type ReleaseSnapshotRecord = typeof ReleaseSnapshotRecord.Type

/** Lowercase SHA-256 digest used as the content-addressed blob identity. */
export const ContentBlobDigest = BlobDigest

/** Decoded content-addressed blob digest. */
export type ContentBlobDigest = typeof ContentBlobDigest.Type

/** Retention behavior of bytes in the content-addressed object store. */
export const ContentBlobStorageClass = BlobClassification

/** Decoded content-blob retention classification. */
export type ContentBlobStorageClass = typeof ContentBlobStorageClass.Type

/** Metadata for content bytes held by the separate object-store service. */
export const ContentBlobMetadata = Schema.Struct({
  workspaceId: WorkspaceId,
  digest: ContentBlobDigest,
  storageClass: ContentBlobStorageClass,
  mimeType: Schema.Union([
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
    Schema.Null
  ]),
  byteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  createdAt: UtcTimestamp,
  lastVerifiedAt: Schema.Union([UtcTimestamp, Schema.Null])
})

/** Decoded object-store blob metadata. */
export type ContentBlobMetadata = typeof ContentBlobMetadata.Type

/** Persisted record categories whose malformed snapshots may be quarantined. */
export const QuarantineRecordKind = Schema.Literals([
  "content-metadata",
  "delivery-node",
  "delivery-relationship",
  "domain-event",
  "entity-projection",
  "entity-revision",
  "evidence-claim",
  "evidence-freshness",
  "evidence-item",
  "person-avatar",
  "person-identity",
  "person",
  "plugin-connection",
  "plugin-configuration",
  "plugin-descriptor",
  "plugin-sync-page",
  "release-head",
  "release-revision",
  "readiness-assessment",
  "readiness-environment-head",
  "readiness-release-head",
  "readiness-rule",
  "role-assignment",
  "session",
  "pairing-code",
  "workspace"
])

/** Decoded quarantined-record category. */
export type QuarantineRecordKind = typeof QuarantineRecordKind.Type

/** Bounded diagnostic code that never contains persisted payload data. */
export const QuarantineReasonCode = Schema.Literals([
  "content-metadata-schema-invalid",
  "delivery-graph-digest-mismatch",
  "delivery-node-schema-invalid",
  "delivery-relationship-schema-invalid",
  "domain-event-payload-digest-mismatch",
  "domain-event-schema-invalid",
  "entity-projection-schema-invalid",
  "entity-revision-schema-invalid",
  "evidence-claim-schema-invalid",
  "evidence-freshness-schema-invalid",
  "evidence-item-schema-invalid",
  "person-identity-schema-invalid",
  "person-schema-invalid",
  "plugin-connection-schema-invalid",
  "plugin-configuration-schema-invalid",
  "plugin-descriptor-schema-invalid",
  "plugin-descriptor-envelope-invalid",
  "plugin-capability-duplicate",
  "plugin-contract-major-unsupported",
  "plugin-required-capability-unsupported",
  "plugin-negotiated-descriptor-invalid",
  "plugin-descriptor-provider-mismatch",
  "plugin-sync-page-schema-invalid",
  "release-head-schema-invalid",
  "release-revision-envelope-invalid",
  "readiness-assessment-digest-mismatch",
  "readiness-assessment-identity-mismatch",
  "readiness-assessment-materialization-mismatch",
  "readiness-assessment-schema-invalid",
  "readiness-candidate-digest-mismatch",
  "readiness-environment-head-schema-invalid",
  "readiness-head-assessment-mismatch",
  "readiness-release-head-schema-invalid",
  "readiness-rule-digest-mismatch",
  "readiness-rule-identity-mismatch",
  "readiness-rule-schema-invalid",
  "role-assignment-schema-invalid",
  "session-schema-invalid",
  "pairing-code-schema-invalid",
  "schema-decode-failed",
  "snapshot-beyond-head",
  "snapshot-digest-mismatch",
  "snapshot-identity-mismatch",
  "workspace-schema-invalid"
])

/** Decoded quarantine diagnostic code. */
export type QuarantineReasonCode = typeof QuarantineReasonCode.Type

/** Fixed diagnostics prevent malformed payload content entering quarantine text. */
export const QuarantineDiagnosticSummary = Schema.Literals([
  "Stored content metadata failed schema validation.",
  "Stored delivery graph record digest does not match its content.",
  "Stored delivery node failed schema validation.",
  "Stored delivery relationship failed schema validation.",
  "Stored domain event payload digest does not match its content.",
  "Stored domain event failed schema validation.",
  "Stored entity projection failed schema validation.",
  "Stored entity revision failed schema validation.",
  "Stored evidence claim failed schema validation.",
  "Stored evidence freshness failed schema validation.",
  "Stored evidence item failed schema validation.",
  "Stored person avatar failed schema validation.",
  "Stored person identity failed schema validation.",
  "Stored person record failed schema validation.",
  "Stored plugin connection failed schema validation.",
  "Stored plugin configuration failed schema validation.",
  "Plugin descriptor candidate failed schema validation.",
  "Plugin descriptor envelope failed schema validation.",
  "Plugin descriptor contains duplicate capability offers.",
  "Plugin descriptor contract major is unsupported.",
  "Plugin descriptor requires an unsupported capability version.",
  "Negotiated plugin descriptor failed schema validation.",
  "Plugin descriptor provider does not match its connection.",
  "Plugin sync page failed schema validation.",
  "Stored release head failed schema validation.",
  "Stored release revision envelope failed schema validation.",
  "Stored readiness assessment digest does not match its content.",
  "Stored readiness assessment identity does not match its repository key.",
  "Stored readiness assessment materialization does not match its canonical content.",
  "Stored readiness assessment failed schema validation.",
  "Stored readiness candidate digest does not match its canonical material.",
  "Stored environment readiness head failed schema validation.",
  "Stored readiness head does not match its referenced assessment.",
  "Stored release readiness head failed schema validation.",
  "Stored readiness rule digest does not match its canonical material.",
  "Stored readiness rule identity does not match its repository key.",
  "Stored readiness rule failed schema validation.",
  "Stored release snapshot exceeds its authoritative head.",
  "Stored release snapshot digest does not match its content.",
  "Stored release snapshot does not satisfy the current release schema.",
  "Stored release snapshot failed schema validation.",
  "Stored release snapshot identity does not match its repository key.",
  "Stored role assignment failed schema validation.",
  "Stored session failed schema validation.",
  "Stored pairing code failed schema validation.",
  "Stored workspace failed schema validation."
])

/** Decoded fixed quarantine diagnostic summary. */
export type QuarantineDiagnosticSummary = typeof QuarantineDiagnosticSummary.Type

const QuarantineRecordKey = Schema.String.check(
  Schema.isPattern(
    /^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?::[1-9]\d*)?)$/u,
    { expected: "a canonical digest, entity ID, or revision-qualified entity ID" }
  )
)

/** Redacted metadata describing a malformed persisted record. */
export const QuarantinedRecordMetadata = Schema.Struct({
  workspaceId: WorkspaceId,
  recordKind: QuarantineRecordKind,
  recordKey: QuarantineRecordKey,
  schemaVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  payloadDigest: ContentBlobDigest,
  diagnosticCode: QuarantineReasonCode,
  diagnosticSummary: QuarantineDiagnosticSummary,
  firstObservedAt: UtcTimestamp,
  lastObservedAt: UtcTimestamp,
  occurrenceCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
})

/** Decoded redacted quarantine metadata. */
export type QuarantinedRecordMetadata = typeof QuarantinedRecordMetadata.Type
