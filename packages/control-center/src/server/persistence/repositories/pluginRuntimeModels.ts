import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { PluginHealth } from "../../../domain/freshness.js"
import { PluginConnectionId, WorkspaceId } from "../../../domain/identifiers.js"
import { ProviderId, Revision } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { ContentBlobDigest } from "./models.js"

const bounded = (maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum))

const jsonText = (maximum: number) =>
  bounded(maximum).check(
    Schema.isMinLength(2),
    Schema.makeFilter(
      (value) => Result.isSuccess(Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(value)),
      { expected: "bounded valid JSON text" }
    )
  )

/** Stable logical collection synchronized through one checkpoint. */
export const PluginStreamKey = bounded(100).pipe(Schema.brand("PluginStreamKey"))
export type PluginStreamKey = typeof PluginStreamKey.Type

/** Provider page identity used for idempotent commits. */
export const PluginPageId = bounded(200).pipe(Schema.brand("PluginPageId"))
export type PluginPageId = typeof PluginPageId.Type

/** Stable provider record identity within one stream. */
export const PluginRecordKey = bounded(700).pipe(Schema.brand("PluginRecordKey"))
export type PluginRecordKey = typeof PluginRecordKey.Type

export const DescriptorCandidate = Schema.Struct({
  providerId: ProviderId,
  schemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  descriptorJson: jsonText(65_536)
})
export type DescriptorCandidate = typeof DescriptorCandidate.Type

export const PluginRuntimeRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  descriptorSchemaVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  descriptorJson: jsonText(65_536),
  descriptorDigest: ContentBlobDigest,
  acceptedAt: UtcTimestamp,
  health: PluginHealth,
  consecutiveFailures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type PluginRuntimeRecord = typeof PluginRuntimeRecord.Type

const EventBase = {
  eventId: bounded(512),
  eventJson: jsonText(524_288),
  recordKey: PluginRecordKey,
  sourceRevision: Revision,
  observedAt: UtcTimestamp
}

export const PluginSyncEvent = Schema.Union([
  Schema.TaggedStruct("upsert", {
    ...EventBase,
    payloadJson: jsonText(524_288)
  }),
  Schema.TaggedStruct("tombstone", EventBase)
]).pipe(Schema.toTaggedUnion("_tag"))
export type PluginSyncEvent = typeof PluginSyncEvent.Type

export const PluginSyncPage = Schema.Struct({
  providerId: ProviderId,
  streamKey: PluginStreamKey,
  pageId: PluginPageId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checkpointJson: jsonText(65_536),
  hasMore: Schema.Boolean,
  successfulHealth: PluginHealth.check(
    Schema.makeFilter(({ _tag }) => _tag === "healthy" || _tag === "degraded", {
      expected: "usable plugin health for a successfully committed page"
    })
  ),
  committedAt: UtcTimestamp,
  events: Schema.Array(PluginSyncEvent).check(
    Schema.makeFilter((events) => events.length <= 500, {
      expected: "at most 500 persisted plugin events"
    }),
    Schema.makeFilter(
      (events) => new Set(events.map(({ eventId }) => eventId)).size === events.length,
      { expected: "unique event identities within a persisted page" }
    )
  )
})
export type PluginSyncPage = typeof PluginSyncPage.Type

export const PluginStreamRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  streamKey: PluginStreamKey,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checkpointJson: Schema.NullOr(jsonText(65_536)),
  checkpointDigest: Schema.NullOr(ContentBlobDigest),
  lastPageId: Schema.NullOr(PluginPageId),
  synchronizedAt: Schema.NullOr(UtcTimestamp)
}).check(
  Schema.makeFilter(
    ({ checkpointDigest, checkpointJson, lastPageId, synchronizedAt }) =>
      (checkpointJson === null) === (checkpointDigest === null) &&
      (checkpointJson === null) === (lastPageId === null) &&
      (lastPageId === null) === (synchronizedAt === null),
    { expected: "coherent checkpoint, page, and synchronization metadata" }
  )
)
export type PluginStreamRecord = typeof PluginStreamRecord.Type

export const PluginCacheRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  streamKey: PluginStreamKey,
  recordKey: PluginRecordKey,
  state: Schema.Literals(["present", "tombstoned"]),
  payloadJson: Schema.NullOr(jsonText(524_288)),
  payloadDigest: Schema.NullOr(ContentBlobDigest),
  sourceRevision: Revision,
  lastPageId: PluginPageId,
  cachedAt: UtcTimestamp,
  tombstonedAt: Schema.NullOr(UtcTimestamp)
}).check(
  Schema.makeFilter(
    ({ payloadDigest, payloadJson, state, tombstonedAt }) =>
      (payloadJson === null) === (payloadDigest === null) &&
      (state === "present"
        ? payloadJson !== null && tombstonedAt === null
        : tombstonedAt !== null),
    { expected: "a coherent present or tombstoned plugin cache record" }
  )
)
export type PluginCacheRecord = typeof PluginCacheRecord.Type

export const PluginEvidenceRecord = Schema.Struct({
  workspaceId: WorkspaceId,
  pluginConnectionId: PluginConnectionId,
  streamKey: PluginStreamKey,
  pageId: PluginPageId,
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  eventId: bounded(512),
  eventDigest: ContentBlobDigest,
  eventKind: Schema.Literals(["upsert", "tombstone"]),
  recordKey: PluginRecordKey,
  sourceRevision: Revision,
  payloadJson: jsonText(524_288),
  observedAt: UtcTimestamp
})
export type PluginEvidenceRecord = typeof PluginEvidenceRecord.Type
