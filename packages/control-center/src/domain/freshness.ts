import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { PluginConnectionId } from "./identifiers.js"
import { SourceRevision } from "./sourceRevision.js"
import { UtcTimestamp } from "./utcTimestamp.js"

const StaleAfterSeconds = Schema.Int.check(Schema.isGreaterThan(0))
const SafeHealthMessage = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(500)
)

/** Stable failure classes exposed by plugin health without leaking raw causes. */
export const PluginFailureClass = Schema.Literals([
  "authentication",
  "authorization",
  "rate-limit",
  "timeout",
  "malformed-response",
  "outage",
  "unknown"
])

/** Decoded plugin failure classification. */
export type PluginFailureClass = typeof PluginFailureClass.Type

const HealthyPluginHealth = Schema.TaggedStruct("healthy", {
  checkedAt: UtcTimestamp
})

const DegradedPluginHealth = Schema.TaggedStruct("degraded", {
  checkedAt: UtcTimestamp,
  failureClass: PluginFailureClass,
  retryAt: Schema.NullOr(UtcTimestamp),
  safeMessage: SafeHealthMessage
}).check(
  Schema.makeFilter(
    ({ checkedAt, retryAt }) => retryAt === null || DateTime.Order(checkedAt, retryAt) <= 0,
    { expected: "plugin retry time to be at or after its health check" }
  )
)

const UnavailablePluginHealth = Schema.TaggedStruct("unavailable", {
  checkedAt: UtcTimestamp,
  failureClass: PluginFailureClass,
  retryAt: Schema.NullOr(UtcTimestamp),
  safeMessage: SafeHealthMessage
}).check(
  Schema.makeFilter(
    ({ checkedAt, retryAt }) => retryAt === null || DateTime.Order(checkedAt, retryAt) <= 0,
    { expected: "plugin retry time to be at or after its health check" }
  )
)

const DisabledPluginHealth = Schema.TaggedStruct("disabled", {
  checkedAt: UtcTimestamp
})

/** Health of the plugin connection responsible for a normalized object. */
export const PluginHealth = Schema.Union([
  HealthyPluginHealth,
  DegradedPluginHealth,
  UnavailablePluginHealth,
  DisabledPluginHealth
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded plugin connection health. */
export type PluginHealth = typeof PluginHealth.Type

const UsablePluginHealth = Schema.Union([HealthyPluginHealth, DegradedPluginHealth])

const ProviderProvenance = Schema.TaggedStruct("provider", {
  sourceRevision: SourceRevision
})

const CachedProvenance = Schema.TaggedStruct("cache", {
  cachedAt: UtcTimestamp,
  sourceRevision: SourceRevision
}).check(
  Schema.makeFilter(
    ({ cachedAt, sourceRevision }) => DateTime.Order(sourceRevision.synchronizedAt, cachedAt) <= 0,
    { expected: "the cache time to be at or after source synchronization" }
  )
)

const NoCacheProvenance = Schema.TaggedStruct("none", {
  pluginConnectionId: PluginConnectionId
})

const sourceAgeSecondsAt = (sourceObservedAt: UtcTimestamp, evaluatedAt: UtcTimestamp): number =>
  (DateTime.toEpochMillis(evaluatedAt) - DateTime.toEpochMillis(sourceObservedAt)) / 1_000

const CurrentFreshness = Schema.TaggedStruct("current", {
  pluginHealth: UsablePluginHealth,
  provenance: Schema.Union([ProviderProvenance, CachedProvenance]),
  sourceObservedAt: UtcTimestamp,
  staleAfterSeconds: StaleAfterSeconds,
  synchronizedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ pluginHealth, provenance, sourceObservedAt, staleAfterSeconds, synchronizedAt }) =>
      DateTime.Equivalence(sourceObservedAt, provenance.sourceRevision.lastObservedAt) &&
      DateTime.Order(provenance.sourceRevision.synchronizedAt, synchronizedAt) <= 0 &&
      (provenance._tag === "provider" || DateTime.Order(provenance.cachedAt, synchronizedAt) <= 0) &&
      DateTime.Order(synchronizedAt, pluginHealth.checkedAt) <= 0 &&
      sourceAgeSecondsAt(sourceObservedAt, pluginHealth.checkedAt) >= 0 &&
      sourceAgeSecondsAt(sourceObservedAt, pluginHealth.checkedAt) <= staleAfterSeconds,
    {
      expected: "current source data to match its revision and remain within its stale threshold"
    }
  )
)

const StaleFreshness = Schema.TaggedStruct("stale", {
  pluginHealth: PluginHealth,
  provenance: CachedProvenance,
  sourceObservedAt: UtcTimestamp,
  staleAfterSeconds: StaleAfterSeconds,
  synchronizedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ pluginHealth, provenance, sourceObservedAt, staleAfterSeconds, synchronizedAt }) =>
      DateTime.Equivalence(sourceObservedAt, provenance.sourceRevision.lastObservedAt) &&
      DateTime.Order(sourceObservedAt, synchronizedAt) <= 0 &&
      DateTime.Order(provenance.cachedAt, synchronizedAt) <= 0 &&
      DateTime.Order(synchronizedAt, pluginHealth.checkedAt) <= 0 &&
      sourceAgeSecondsAt(sourceObservedAt, pluginHealth.checkedAt) > staleAfterSeconds,
    {
      expected: "stale cache data to be chronological and beyond its stale threshold"
    }
  )
)

const MissingFreshness = Schema.TaggedStruct("missing", {
  pluginHealth: HealthyPluginHealth,
  provenance: NoCacheProvenance,
  sourceObservedAt: Schema.Null,
  staleAfterSeconds: StaleAfterSeconds,
  synchronizedAt: UtcTimestamp
})

const UnavailableFreshness = Schema.TaggedStruct("unavailable", {
  pluginHealth: Schema.Union([UnavailablePluginHealth, DisabledPluginHealth]),
  provenance: NoCacheProvenance,
  sourceObservedAt: Schema.Null,
  staleAfterSeconds: StaleAfterSeconds,
  synchronizedAt: Schema.Null
})

/**
 * Freshness of normalized data, preserving cached stale data while separating
 * absence from a connection that cannot currently be queried.
 */
export const Freshness = Schema.Union([
  CurrentFreshness,
  StaleFreshness,
  MissingFreshness,
  UnavailableFreshness
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded normalized-data freshness. */
export type Freshness = typeof Freshness.Type
