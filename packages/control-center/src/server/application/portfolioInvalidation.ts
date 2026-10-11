import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { PluginHealth } from "../../domain/freshness.js"
import { DomainEventId, type PluginConnectionId, type ReleaseId, type WorkspaceId } from "../../domain/identifiers.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { PersistenceOperationError } from "../persistence/errors.js"
import { Persistence } from "../persistence/Persistence.js"
import { DomainEventDedupeKey } from "../persistence/repositories/domainEventModels.js"

/** Append the durable event consumed by live portfolio projections. */
export const appendPortfolioInvalidation = Effect.fn(
  "PortfolioInvalidation.append"
)(function*(
  input:
    & {
      readonly workspaceId: WorkspaceId
      readonly pluginConnectionId: PluginConnectionId
      readonly releaseId: ReleaseId | null
      readonly occurredAt: UtcTimestamp
    }
    & (
      | { readonly reason: "plugin-health"; readonly health?: PluginHealth }
      | { readonly reason: "release-projection" }
    )
) {
  const cryptoService = yield* Crypto.Crypto
  const persistence = yield* Persistence
  const eventId = yield* cryptoService.randomUUIDv7.pipe(
    Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.random-id" })),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(DomainEventId)(value).pipe(
        Effect.mapError(() => new PersistenceOperationError({ operation: "domain-event.random-id" }))
      )
    )
  )
  return yield* persistence.events.append(input.workspaceId, {
    dedupeKey: DomainEventDedupeKey.make(eventId),
    schemaVersion: 1,
    eventId,
    eventType: "portfolio-invalidated",
    occurredAt: input.occurredAt,
    causationId: null,
    correlationId: null,
    metadata: {
      ...(!(input.releaseId === null) && { releaseId: input.releaseId }),
      pluginConnectionId: input.pluginConnectionId
    },
    payload: input.reason === "plugin-health" && input.health !== undefined
      ? {
        reason: input.reason,
        pluginHealth: input.health._tag === "degraded" || input.health._tag === "unavailable"
          ? { healthState: input.health._tag, failureClass: input.health.failureClass }
          : { healthState: input.health._tag, failureClass: null }
      }
      : { reason: input.reason }
  })
})
