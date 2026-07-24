import * as Encoding from "effect/Encoding"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { Revision, SourceUrl, VendorImmutableId } from "../sourceRevision.js"
import { UtcTimestamp } from "../utcTimestamp.js"
import {
  hasMaximumPluginJsonBytes,
  MaximumPluginPayloadBytes,
  MaximumPluginSyncPageBytes,
  PluginPayloadJson
} from "./bounds.js"

const boundedOpaque = (name: string, maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum)).pipe(Schema.brand(name))

/** Stable adapter event identity used to make checkpoint replay idempotent. */
export const PluginEventId = boundedOpaque("PluginEventId", 512)

/** Decoded adapter event identity. */
export type PluginEventId = typeof PluginEventId.Type

/** Opaque bounded checkpoint owned by one plugin sync stream. */
export const PluginCheckpointV1 = boundedOpaque("PluginCheckpointV1", 2_048)

/** Decoded plugin checkpoint. */
export type PluginCheckpointV1 = typeof PluginCheckpointV1.Type

/** Opaque page cursor for optional paginated reads. */
export const PluginPageCursorV1 = boundedOpaque("PluginPageCursorV1", 2_048)

/** Decoded plugin page cursor. */
export type PluginPageCursorV1 = typeof PluginPageCursorV1.Type

/** Stable entity category emitted without vendor-specific response shapes. */
export const PluginEntityType = boundedOpaque("PluginEntityType", 100)

/** Decoded normalized entity type. */
export type PluginEntityType = typeof PluginEntityType.Type

const SafeSummary = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))
const MaximumDiffContentBytes = 1_048_576
const MaximumDiffContentBase64Characters = 4 * Math.ceil(MaximumDiffContentBytes / 3)
const hasSafeRelativePathShape = Schema.makeFilter(
  (value: string) => {
    if (value.startsWith("/") || value.includes("\\") || /^[a-zA-Z]:/u.test(value)) return false
    return (
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
      Array.from(value).every((character) => {
        const codePoint = character.codePointAt(0)
        return (
          codePoint !== undefined &&
          !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
        )
      })
    )
  },
  { expected: "a normalized provider-relative path without traversal or control characters" }
)
const hasMaximumDecodedDiffBytes = Schema.makeFilter(
  (value: string) => {
    const decoded = Encoding.decodeBase64(value)
    return Result.isSuccess(decoded) && decoded.success.byteLength <= MaximumDiffContentBytes
  },
  { expected: `base64 data decoding to at most ${MaximumDiffContentBytes} bytes` }
)

/** Normalized provider-relative path safe to carry across diff and storage boundaries. */
export const PluginRelativePathV1 = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  hasSafeRelativePathShape
).pipe(Schema.brand("PluginRelativePathV1"))

/** Decoded normalized provider-relative path. */
export type PluginRelativePathV1 = typeof PluginRelativePathV1.Type

const PluginDiffContentBase64V1 = Schema.String.check(
  Schema.isMaxLength(MaximumDiffContentBase64Characters),
  Schema.isBase64(),
  hasMaximumDecodedDiffBytes
)
const commonEventFields = {
  eventId: PluginEventId,
  observedAt: UtcTimestamp,
  revision: Revision
}
const entityReferenceFields = {
  entityType: PluginEntityType,
  vendorImmutableId: VendorImmutableId
}

/** Adapter-owned reference to a provider entity; host scope is deliberately absent. */
export const PluginEntityReferenceV1 = Schema.Struct(entityReferenceFields)

/** Decoded provider entity reference. */
export type PluginEntityReferenceV1 = typeof PluginEntityReferenceV1.Type

const UpsertEntity = Schema.TaggedStruct("UpsertEntity", {
  ...commonEventFields,
  ...entityReferenceFields,
  sourceUrl: Schema.NullOr(SourceUrl),
  title: SafeSummary,
  attributes: Schema.Record(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)), Schema.Json).check(
    hasMaximumPluginJsonBytes(MaximumPluginPayloadBytes)
  )
})

const TombstoneEntity = Schema.TaggedStruct("TombstoneEntity", {
  ...commonEventFields,
  ...entityReferenceFields,
  reason: SafeSummary
})

const AppendEvidence = Schema.TaggedStruct("AppendEvidence", {
  ...commonEventFields,
  evidenceId: boundedOpaque("PluginEvidenceId", 512),
  subject: PluginEntityReferenceV1,
  evidenceType: boundedOpaque("PluginEvidenceType", 100),
  summary: SafeSummary,
  capturedAt: UtcTimestamp,
  data: PluginPayloadJson
})

const UpsertPerson = Schema.TaggedStruct("UpsertPerson", {
  ...commonEventFields,
  vendorPersonId: boundedOpaque("PluginVendorPersonId", 512),
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  avatarUrl: Schema.NullOr(SourceUrl),
  active: Schema.Boolean
})

const ProposeRelationship = Schema.TaggedStruct("ProposeRelationship", {
  ...commonEventFields,
  relationshipId: boundedOpaque("PluginRelationshipId", 512),
  from: PluginEntityReferenceV1,
  to: PluginEntityReferenceV1,
  relationshipType: boundedOpaque("PluginRelationshipType", 100),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  evidenceIds: Schema.Array(boundedOpaque("PluginRelationshipEvidenceId", 512)).check(
    Schema.makeFilter((evidenceIds) => evidenceIds.length <= 100, {
      expected: "at most 100 relationship evidence identities"
    }),
    Schema.isUnique()
  )
})

/** Vendor-neutral event emitted by a plugin and scoped by the host on ingestion. */
export const NormalizedPluginEventV1 = Schema.Union([
  UpsertEntity,
  TombstoneEntity,
  AppendEvidence,
  UpsertPerson,
  ProposeRelationship
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded normalized plugin event. */
export type NormalizedPluginEventV1 = typeof NormalizedPluginEventV1.Type

/** A fully decoded page whose events and checkpoint must commit atomically. */
export const PluginSyncPageV1 = Schema.Struct({
  events: Schema.Array(NormalizedPluginEventV1).check(
    Schema.makeFilter((events) => events.length <= 500, {
      expected: "at most 500 normalized plugin events"
    }),
    Schema.makeFilter((events) => new Set(events.map(({ eventId }) => eventId)).size === events.length, {
      expected: "unique normalized plugin event identities within a page"
    })
  ),
  checkpointAfterPage: PluginCheckpointV1,
  hasMore: Schema.Boolean
})
  .check(hasMaximumPluginJsonBytes(MaximumPluginSyncPageBytes))
  .annotate({ identifier: "PluginSyncPageV1" })

/** Decoded plugin sync page. */
export type PluginSyncPageV1 = typeof PluginSyncPageV1.Type

/** Request to resume a logical plugin stream from an accepted checkpoint. */
export const PluginSyncRequestV1 = Schema.Struct({
  streamKey: boundedOpaque("PluginSyncStreamKey", 100),
  checkpoint: Schema.NullOr(PluginCheckpointV1)
}).annotate({ identifier: "PluginSyncRequestV1" })

/** Decoded plugin sync request. */
export type PluginSyncRequestV1 = typeof PluginSyncRequestV1.Type

/** Request for one normalized entity by its immutable provider reference. */
export const ReadPluginEntityRequestV1 = PluginEntityReferenceV1

/** Decoded normalized entity read request. */
export type ReadPluginEntityRequestV1 = typeof ReadPluginEntityRequestV1.Type

const FoundPluginEntity = Schema.TaggedStruct("found", {
  event: UpsertEntity
})
const MissingPluginEntity = Schema.TaggedStruct("missing", {
  reference: PluginEntityReferenceV1,
  observedAt: UtcTimestamp
})

/** Authoritative result of a normalized plugin entity read. */
export const ReadPluginEntityResultV1 = Schema.Union([FoundPluginEntity, MissingPluginEntity]).pipe(
  Schema.toTaggedUnion("_tag")
)

/** Decoded normalized entity read result. */
export type ReadPluginEntityResultV1 = typeof ReadPluginEntityResultV1.Type

/** One bounded file-like entry in a complete diff inventory. */
export const PluginDiffInventoryEntryV1 = Schema.Struct({
  path: PluginRelativePathV1,
  previousPath: Schema.NullOr(PluginRelativePathV1),
  status: Schema.Literals(["added", "modified", "deleted", "renamed", "copied"]),
  binary: Schema.Boolean,
  generated: Schema.Boolean,
  oversized: Schema.Boolean
})

/** Request for one page of a complete diff inventory. */
export const DiffInventoryPageRequestV1 = Schema.Struct({
  entity: PluginEntityReferenceV1,
  cursor: Schema.NullOr(PluginPageCursorV1)
})

/** A bounded diff inventory page. */
export const DiffInventoryPageV1 = Schema.Struct({
  entries: Schema.Array(PluginDiffInventoryEntryV1).check(
    Schema.makeFilter((entries) => entries.length <= 500, {
      expected: "at most 500 diff inventory entries"
    })
  ),
  nextCursor: Schema.NullOr(PluginPageCursorV1)
})

/** Request for a bounded byte range of before/after diff content. */
export const DiffContentRangeRequestV1 = Schema.Struct({
  entity: PluginEntityReferenceV1,
  path: PluginRelativePathV1,
  side: Schema.Literals(["before", "after"]),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 }))
})

/** Exact immutable request for one page of a complete diff inventory. */
export const DiffInventoryPageRequestV2 = Schema.Struct({
  entity: PluginEntityReferenceV1,
  expectedRevision: Revision,
  baseRevision: Revision,
  headRevision: Revision,
  cursor: Schema.NullOr(PluginPageCursorV1)
})

/** Exact immutable request for a bounded byte range of before/after diff content. */
export const DiffContentRangeRequestV2 = Schema.Struct({
  entity: PluginEntityReferenceV1,
  expectedRevision: Revision,
  baseRevision: Revision,
  headRevision: Revision,
  path: PluginRelativePathV1,
  previousPath: Schema.NullOr(PluginRelativePathV1),
  status: PluginDiffInventoryEntryV1.fields.status,
  side: Schema.Literals(["before", "after"]),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 }))
})

/** Bounded content range with explicit availability metadata. */
export const DiffContentRangeV1 = Schema.Struct({
  bytesBase64: Schema.NullOr(PluginDiffContentBase64V1),
  totalBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  unavailableReason: Schema.NullOr(
    Schema.Literals(["binary", "generated", "oversized", "missing", "provider-unavailable"])
  )
}).check(
  Schema.makeFilter(
    ({ bytesBase64, totalBytes, unavailableReason }) =>
      unavailableReason === null ? bytesBase64 !== null && totalBytes !== null : bytesBase64 === null,
    { expected: "available content bytes or an explicit unavailable reason" }
  )
)

export type DiffInventoryPageRequestV1 = typeof DiffInventoryPageRequestV1.Type
export type DiffInventoryPageRequestV2 = typeof DiffInventoryPageRequestV2.Type
export type DiffInventoryPageV1 = typeof DiffInventoryPageV1.Type
export type DiffContentRangeRequestV1 = typeof DiffContentRangeRequestV1.Type
export type DiffContentRangeRequestV2 = typeof DiffContentRangeRequestV2.Type
export type DiffContentRangeV1 = typeof DiffContentRangeV1.Type
