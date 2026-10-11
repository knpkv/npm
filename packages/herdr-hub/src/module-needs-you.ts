import { FleetHostName, JobActor, JobIdentifier, JobPayload } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"

const SourceKey = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512))
const Timestamp = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))

/** Exact object selectors, without an approval proof, action payload or URL. */
export const NeedsYouDestination = Schema.TaggedStruct("FleetApproval", {
  module: Schema.Literal("fleet"),
  host: FleetHostName,
  jobId: JobIdentifier
})
export interface NeedsYouDestination extends Schema.Schema.Type<typeof NeedsYouDestination> {}

/** Providers supply local keys; the hub owns their module namespace. */
export const NeedsYouCandidate = Schema.Struct({
  sourceKey: SourceKey,
  destination: NeedsYouDestination,
  kind: Schema.Literals(Schema.Union(JobPayload.members).pipe(Schema.toTaggedUnion("kind")).discriminants),
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

/** A failed or bounded source remains visible even when it returned no items. */
export const NeedsYouProviderResult = Schema.Struct({
  items: Schema.Array(NeedsYouCandidate),
  issues: Schema.Array(NeedsYouIssue)
})
export interface NeedsYouProviderResult extends Schema.Schema.Type<typeof NeedsYouProviderResult> {}

const ProviderId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
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

/** Complete has no source problems; Partial always names at least one. */
export const NeedsYouResult = Schema.Union([
  Schema.TaggedStruct("Complete", { items: Schema.Array(NeedsYouItem) }),
  Schema.TaggedStruct("Partial", {
    items: Schema.Array(NeedsYouItem),
    sources: Schema.Array(NeedsYouSource).check(Schema.isMinLength(1))
  })
])
export type NeedsYouResult = typeof NeedsYouResult.Type
