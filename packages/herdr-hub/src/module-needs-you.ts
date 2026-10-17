import { FleetHostName, JobActor, JobIdentifier, JobPayload } from "@knpkv/herdr-fleet/model"
import { Effect, Schema } from "effect"

const SourceKey = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512))
const Timestamp = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
const ProviderId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
const QueryKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
const QueryValue = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128), Schema.isPattern(/^\S+$/))
const ModulePageQuery = Schema.Record(QueryKey, QueryValue).check(
  Schema.makeFilter((query) => Object.keys(query).length <= 4, { expected: "at most 4 query keys" })
)

/** A fleet approval, or a page of the provider's own module. Query values stay opaque and bounded. */
export const NeedsYouDestination = Schema.Union([
  Schema.TaggedStruct("FleetApproval", {
    module: Schema.Literal("fleet"),
    host: FleetHostName,
    jobId: JobIdentifier
  }),
  Schema.TaggedStruct("ModulePage", {
    module: ProviderId,
    page: QueryKey,
    query: ModulePageQuery
  })
])
export type NeedsYouDestination = typeof NeedsYouDestination.Type

const JobKind = Schema.Literals(Schema.Union(JobPayload.members).pipe(Schema.toTaggedUnion("kind")).discriminants)

/** Providers supply local keys; the hub owns their module namespace. */
export const NeedsYouCandidate = Schema.Struct({
  sourceKey: SourceKey,
  destination: NeedsYouDestination,
  kind: Schema.Union([JobKind, Schema.Literals(["sandbox-quarantined", "sandbox-budget-hold"])]),
  actor: JobActor,
  createdAt: Timestamp,
  expiresAt: Schema.NullOr(Timestamp)
})
export interface NeedsYouCandidate extends Schema.Schema.Type<typeof NeedsYouCandidate> {}

export const NeedsYouFailureReason = Schema.Literals([
  "offline",
  "unavailable",
  "timeout",
  "request_failed",
  "invalid_response",
  "internal"
])

export const NeedsYouIssue = Schema.Union([
  Schema.Struct({ state: Schema.Literal("truncated") }),
  Schema.Struct({ state: Schema.Literal("failed"), reason: NeedsYouFailureReason }),
  Schema.Struct({
    state: Schema.Literal("hosts"),
    hosts: Schema.Array(Schema.Struct({
      host: FleetHostName,
      reason: NeedsYouFailureReason
    })).check(Schema.isMinLength(1))
  })
])
export type NeedsYouIssue = typeof NeedsYouIssue.Type

/**
 * A failed or bounded source remains visible even when it returned no items.
 * `asOf` is the provider's own reading time, or null when it has none. Older clients omit it.
 */
export const NeedsYouProviderResult = Schema.Struct({
  items: Schema.Array(NeedsYouCandidate),
  issues: Schema.Array(NeedsYouIssue),
  asOf: Schema.NullOr(Timestamp).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
})
export interface NeedsYouProviderResult extends Schema.Schema.Type<typeof NeedsYouProviderResult> {}

export const NeedsYouContribution = Schema.Struct({
  provider: ProviderId,
  asOf: Schema.NullOr(Timestamp)
})
export interface NeedsYouContribution extends Schema.Schema.Type<typeof NeedsYouContribution> {}
export const NeedsYouItem = Schema.Struct({
  key: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  provider: ProviderId,
  destination: NeedsYouCandidate.fields.destination,
  kind: NeedsYouCandidate.fields.kind,
  actor: NeedsYouCandidate.fields.actor,
  createdAt: NeedsYouCandidate.fields.createdAt,
  expiresAt: NeedsYouCandidate.fields.expiresAt
})
export interface NeedsYouItem extends Schema.Schema.Type<typeof NeedsYouItem> {}

export const NeedsYouSource = Schema.Struct({ provider: ProviderId, issue: NeedsYouIssue })
export interface NeedsYouSource extends Schema.Schema.Type<typeof NeedsYouSource> {}

const contributions = Schema.Array(NeedsYouContribution).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed([]))
)

/** Complete has no source problems; Partial always names at least one. Contributions follow provider order. */
export const NeedsYouResult = Schema.Union([
  Schema.TaggedStruct("Complete", {
    items: Schema.Array(NeedsYouItem),
    contributions
  }),
  Schema.TaggedStruct("Partial", {
    items: Schema.Array(NeedsYouItem),
    sources: Schema.Array(NeedsYouSource).check(Schema.isMinLength(1)),
    contributions
  })
])
export type NeedsYouResult = typeof NeedsYouResult.Type
