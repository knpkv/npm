import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
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

const freshnessEvaluation = {
  // Older persisted revisions predate explicit projection-time evaluation. In
  // that case their plugin health check remains the historical evaluation time.
  evaluatedAt: Schema.optional(UtcTimestamp)
}

const evaluatedAtOrHealthCheck = (
  evaluatedAt: UtcTimestamp | undefined,
  pluginHealth: PluginHealth
): UtcTimestamp => evaluatedAt ?? pluginHealth.checkedAt

const CurrentFreshness = Schema.TaggedStruct("current", {
  ...freshnessEvaluation,
  pluginHealth: UsablePluginHealth,
  provenance: Schema.Union([ProviderProvenance, CachedProvenance]),
  sourceObservedAt: UtcTimestamp,
  staleAfterSeconds: StaleAfterSeconds,
  synchronizedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ evaluatedAt, pluginHealth, provenance, sourceObservedAt, staleAfterSeconds, synchronizedAt }) =>
      DateTime.Equivalence(sourceObservedAt, provenance.sourceRevision.lastObservedAt) &&
      DateTime.Order(provenance.sourceRevision.synchronizedAt, synchronizedAt) <= 0 &&
      (provenance._tag === "provider" || DateTime.Order(provenance.cachedAt, synchronizedAt) <= 0) &&
      DateTime.Order(synchronizedAt, pluginHealth.checkedAt) <= 0 &&
      (evaluatedAt === undefined || DateTime.Order(pluginHealth.checkedAt, evaluatedAt) <= 0) &&
      sourceAgeSecondsAt(sourceObservedAt, evaluatedAtOrHealthCheck(evaluatedAt, pluginHealth)) >= 0 &&
      sourceAgeSecondsAt(sourceObservedAt, evaluatedAtOrHealthCheck(evaluatedAt, pluginHealth)) <= staleAfterSeconds,
    {
      expected: "current source data to match its revision and remain within its stale threshold"
    }
  )
)

const StaleFreshness = Schema.TaggedStruct("stale", {
  ...freshnessEvaluation,
  pluginHealth: PluginHealth,
  provenance: CachedProvenance,
  sourceObservedAt: UtcTimestamp,
  staleAfterSeconds: StaleAfterSeconds,
  synchronizedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ evaluatedAt, pluginHealth, provenance, sourceObservedAt, staleAfterSeconds, synchronizedAt }) =>
      DateTime.Equivalence(sourceObservedAt, provenance.sourceRevision.lastObservedAt) &&
      DateTime.Order(sourceObservedAt, synchronizedAt) <= 0 &&
      DateTime.Order(provenance.cachedAt, synchronizedAt) <= 0 &&
      DateTime.Order(synchronizedAt, pluginHealth.checkedAt) <= 0 &&
      (evaluatedAt === undefined || DateTime.Order(pluginHealth.checkedAt, evaluatedAt) <= 0) &&
      sourceAgeSecondsAt(sourceObservedAt, evaluatedAtOrHealthCheck(evaluatedAt, pluginHealth)) > staleAfterSeconds,
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

/** Re-evaluate persisted freshness for a read projection without rewriting its source facts. */
export const evaluateFreshnessAt = Effect.fn("Freshness.evaluateAt")(function*(
  freshness: Freshness,
  evaluatedAt: UtcTimestamp
): Effect.fn.Return<Freshness, Schema.SchemaError> {
  if (freshness._tag !== "current" && freshness._tag !== "stale") return freshness
  const isStale = freshness._tag === "stale" ||
    sourceAgeSecondsAt(freshness.sourceObservedAt, evaluatedAt) > freshness.staleAfterSeconds
  const provenance = isStale
    ? freshness.provenance._tag === "cache"
      ? freshness.provenance
      : {
        _tag: "cache",
        cachedAt: freshness.synchronizedAt,
        sourceRevision: freshness.provenance.sourceRevision
      }
    : freshness.provenance
  return yield* Schema.decodeUnknownEffect(Schema.toType(Freshness))({
    ...freshness,
    _tag: isStale ? "stale" : "current",
    evaluatedAt,
    provenance
  })
})
