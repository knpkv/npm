import { DateTime, Schema } from "effect"

import { PluginConnectionId } from "./identifiers.js"
import { UtcTimestamp } from "./utcTimestamp.js"

const MAX_OPAQUE_SOURCE_VALUE_LENGTH = 512

const boundedOpaqueSourceValue = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_OPAQUE_SOURCE_VALUE_LENGTH)
)

/** Stable persisted provider names, independent of package abbreviations. */
export const ProviderId = Schema.Literals([
  "codecommit",
  "codepipeline",
  "jira",
  "confluence",
  "clockify"
]).annotate({ identifier: "ProviderId" })

/** Decoded plugin-provider identifier. */
export type ProviderId = typeof ProviderId.Type

/** Opaque immutable identifier assigned to an object by its source provider. */
export const VendorImmutableId = boundedOpaqueSourceValue.pipe(Schema.brand("VendorImmutableId"))

/** Decoded source-provider object identifier. */
export type VendorImmutableId = typeof VendorImmutableId.Type

/** Opaque source-provider revision, version, digest, or ETag. */
export const Revision = boundedOpaqueSourceValue.pipe(Schema.brand("Revision"))

/** Decoded source-provider revision. */
export type Revision = typeof Revision.Type

/** Positive version of the normalization schema used for a source record. */
export const NormalizationSchemaVersion = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0)
).pipe(Schema.brand("NormalizationSchemaVersion"))

/** Decoded normalization-schema version. */
export type NormalizationSchemaVersion = typeof NormalizationSchemaVersion.Type

/**
 * Immutable provenance needed to reconcile a normalized record with the exact
 * provider object and revision from which it was derived.
 */
export const SourceRevision = Schema.Struct({
  providerId: ProviderId,
  pluginConnectionId: PluginConnectionId,
  vendorImmutableId: VendorImmutableId,
  revision: Revision,
  sourceUrl: Schema.Union([Schema.URLFromString, Schema.Null]),
  firstObservedAt: UtcTimestamp,
  lastObservedAt: UtcTimestamp,
  synchronizedAt: UtcTimestamp,
  normalizationSchemaVersion: NormalizationSchemaVersion
})
  .check(
    Schema.makeFilter((sourceRevision) => {
      if (
        DateTime.toEpochMillis(sourceRevision.firstObservedAt) >
          DateTime.toEpochMillis(sourceRevision.lastObservedAt)
      ) {
        return {
          path: ["lastObservedAt"],
          issue: "lastObservedAt must not precede firstObservedAt"
        }
      }

      return DateTime.toEpochMillis(sourceRevision.lastObservedAt) <=
          DateTime.toEpochMillis(sourceRevision.synchronizedAt)
        ? undefined
        : {
          path: ["synchronizedAt"],
          issue: "synchronizedAt must not precede lastObservedAt"
        }
    })
  )
  .annotate({ identifier: "SourceRevision" })

/** Decoded source-revision provenance. */
export type SourceRevision = typeof SourceRevision.Type
