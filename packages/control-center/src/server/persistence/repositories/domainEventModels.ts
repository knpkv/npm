import * as Schema from "effect/Schema"

import {
  DomainEventCorrelationId,
  DomainEventMetadataV1,
  PortfolioInvalidatedPayloadV1
} from "../../../domain/domainEvent.js"
import {
  DomainEventId,
  EntityId,
  EventCursor,
  JobId,
  PluginConnectionId,
  ReleaseId,
  WorkspaceId
} from "../../../domain/identifiers.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { ContentBlobDigest } from "./models.js"

/** Maximum number of durable events read in one replay page. */
export const MAXIMUM_DOMAIN_EVENT_PAGE_SIZE = 128

/** Maximum number of durable events removed in one retention transaction. */
export const MAXIMUM_DOMAIN_EVENT_PRUNE_SIZE = 500

/** Bounded caller identity used to make event appends idempotent. */
export const DomainEventDedupeKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
).pipe(Schema.brand("DomainEventDedupeKey"))

/** Decoded durable-event deduplication key. */
export type DomainEventDedupeKey = typeof DomainEventDedupeKey.Type

/** Positive workspace-local cursor assigned only to persisted events. */
export const PersistedEventCursor = EventCursor.check(Schema.isGreaterThan(0))

/** Bounded replay-page size accepted by the repository. */
export const DomainEventPageSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAXIMUM_DOMAIN_EVENT_PAGE_SIZE })
).pipe(Schema.brand("DomainEventPageSize"))

/** Decoded replay-page size. */
export type DomainEventPageSize = typeof DomainEventPageSize.Type

/** Bounded retention batch size accepted by the repository. */
export const DomainEventPruneSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAXIMUM_DOMAIN_EVENT_PRUNE_SIZE })
).pipe(Schema.brand("DomainEventPruneSize"))

/** Decoded retention batch size. */
export type DomainEventPruneSize = typeof DomainEventPruneSize.Type

/** Durable stream head and the highest cursor removed by retention. */
export const DomainEventStreamState = Schema.Struct({
  headCursor: EventCursor,
  prunedThroughCursor: EventCursor
})

/** Decoded durable stream state. */
export type DomainEventStreamState = typeof DomainEventStreamState.Type

/** Raw persisted event row decoded before payload integrity verification. */
export const DomainEventRow = Schema.Struct({
  workspaceId: WorkspaceId,
  eventCursor: PersistedEventCursor,
  eventId: DomainEventId,
  schemaVersion: Schema.Literal(1),
  eventType: Schema.Literal("portfolio-invalidated"),
  dedupeKey: DomainEventDedupeKey,
  releaseId: Schema.NullOr(ReleaseId),
  pluginConnectionId: Schema.NullOr(PluginConnectionId),
  entityId: Schema.NullOr(EntityId),
  jobId: Schema.NullOr(JobId),
  occurredAt: UtcTimestamp,
  ingestedAt: UtcTimestamp,
  causationId: Schema.NullOr(DomainEventId),
  correlationId: Schema.NullOr(
    DomainEventCorrelationId
  ),
  payloadJson: Schema.String.check(Schema.isNonEmpty()),
  payloadDigest: ContentBlobDigest
})

/** Decoded raw durable event row. */
export type DomainEventRow = typeof DomainEventRow.Type

/** Caller-provided facts required before the repository assigns a cursor and ingest time. */
export const AppendDomainEventInput = Schema.Struct({
  dedupeKey: DomainEventDedupeKey,
  schemaVersion: Schema.Literal(1),
  eventId: DomainEventId,
  eventType: Schema.Literal("portfolio-invalidated"),
  occurredAt: UtcTimestamp,
  causationId: Schema.NullOr(DomainEventId),
  correlationId: Schema.NullOr(DomainEventCorrelationId),
  metadata: DomainEventMetadataV1,
  payload: PortfolioInvalidatedPayloadV1
})

/** Decoded input for one idempotent durable-event append. */
export type AppendDomainEventInput = typeof AppendDomainEventInput.Type

/** Result of one bounded replay read. */
export type DomainEventPage<Event> =
  | {
    readonly _tag: "page"
    readonly events: ReadonlyArray<Event>
    readonly headCursor: typeof EventCursor.Type
    readonly nextCursor: typeof EventCursor.Type
  }
  | {
    readonly _tag: "reset"
    readonly headCursor: typeof EventCursor.Type
    readonly prunedThroughCursor: typeof EventCursor.Type
    readonly reason: "cursor-ahead" | "gap" | "retention"
    readonly requestedCursor: typeof EventCursor.Type
  }

/** Result of one bounded retention transaction. */
export interface DomainEventPruneResult {
  readonly deletedCount: number
  readonly prunedThroughCursor: typeof EventCursor.Type
}
