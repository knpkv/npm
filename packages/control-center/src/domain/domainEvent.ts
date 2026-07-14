import * as Schema from "effect/Schema"

import {
  DomainEventId,
  EntityId,
  EventCursor,
  JobId,
  PluginConnectionId,
  ReleaseId,
  WorkspaceId
} from "./identifiers.js"
import { UtcTimestamp } from "./utcTimestamp.js"

const jsonEncoder = new TextEncoder()
const hasMaximumJsonBytes = (maximumBytes: number) =>
  Schema.makeFilter(
    (value: unknown) => {
      const serialized = JSON.stringify(value)
      return serialized !== undefined && jsonEncoder.encode(serialized).byteLength <= maximumBytes
    },
    { expected: `JSON encoded as at most ${maximumBytes} UTF-8 bytes` }
  )
const PersistedEventCursor = EventCursor.check(Schema.isGreaterThan(0))

/** Maximum decoded JSON carried by one durable domain event. */
export const MaximumDomainEventPayloadBytes = 65_536

/** Bounded trace identifier safe to persist independently of the HTTP API. */
export const DomainEventCorrelationId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/u, { expected: "a domain-safe correlation identifier" })
).pipe(Schema.brand("DomainEventCorrelationId"))

/** Decoded durable event correlation identifier. */
export type DomainEventCorrelationId = typeof DomainEventCorrelationId.Type

/** Optional normalized identities explaining which portfolio facts changed. */
export const DomainEventMetadataV1 = Schema.Struct({
  releaseId: Schema.optionalKey(ReleaseId),
  pluginConnectionId: Schema.optionalKey(PluginConnectionId),
  entityId: Schema.optionalKey(EntityId),
  jobId: Schema.optionalKey(JobId)
}).annotate({ identifier: "DomainEventMetadataV1" })

/** Decoded optional identities attached to a v1 domain event. */
export type DomainEventMetadataV1 = typeof DomainEventMetadataV1.Type

/** Portfolio projection that must be refreshed after a durable invalidation. */
export const PortfolioInvalidationReason = Schema.Literals(["release-projection", "plugin-health"])

/** Decoded reason for invalidating an authoritative portfolio projection. */
export type PortfolioInvalidationReason = typeof PortfolioInvalidationReason.Type

/** Bounded typed payload persisted with a portfolio invalidation. */
export const PortfolioInvalidatedPayloadV1 = Schema.Struct({
  reason: PortfolioInvalidationReason
}).check(hasMaximumJsonBytes(MaximumDomainEventPayloadBytes)).annotate({ identifier: "PortfolioInvalidatedPayloadV1" })

/** Decoded bounded v1 portfolio-invalidation payload. */
export type PortfolioInvalidatedPayloadV1 = typeof PortfolioInvalidatedPayloadV1.Type

/** Durable workspace-local event declaring that the authoritative portfolio changed. */
export const PortfolioInvalidatedEventV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  eventId: DomainEventId,
  eventCursor: PersistedEventCursor,
  workspaceId: WorkspaceId,
  eventType: Schema.Literal("portfolio-invalidated"),
  occurredAt: UtcTimestamp,
  ingestedAt: UtcTimestamp,
  causationId: Schema.NullOr(DomainEventId),
  correlationId: Schema.NullOr(DomainEventCorrelationId),
  metadata: DomainEventMetadataV1,
  payload: PortfolioInvalidatedPayloadV1
}).annotate({ identifier: "PortfolioInvalidatedEventV1" })

/** Decoded durable v1 portfolio-invalidation event. */
export type PortfolioInvalidatedEventV1 = typeof PortfolioInvalidatedEventV1.Type
