/**
 * The hub's answer to an app's `fleet.read`: the same fleet reads the Connect page makes, chosen by kind,
 * with the usage selectors decoded and the answer encoded with the schema the app decodes it with.
 *
 * @module
 */
import { FleetLimits, FleetUsage, UsageQuery } from "@knpkv/herdr-connect"
import type { FleetReadRequest } from "@knpkv/hub-app"
import { Effect, Schema } from "effect"
import { AppServiceRefused } from "./routes.js"

/** Where the reads come from: every peer's on the hub, this host's alone elsewhere. */
export interface FleetReadSources<R> {
  readonly limits: Effect.Effect<FleetLimits, never, R>
  readonly usage: (query: UsageQuery) => Effect.Effect<FleetUsage, never, R>
}

/** Bad usage selectors are `rejected`; an answer that doesn't encode is `unavailable`. */
export const answerFleetRead = <R>(
  sources: FleetReadSources<R>,
  { query, read }: FleetReadRequest
): Effect.Effect<Schema.Json, AppServiceRefused, R> =>
  read === "limits"
    ? sources.limits.pipe(
      Effect.flatMap(Schema.encodeEffect(FleetLimits)),
      Effect.mapError(() => new AppServiceRefused({ code: "unavailable" }))
    )
    : Schema.decodeUnknownEffect(UsageQuery)({ range: query.range ?? "7d", timeZone: query.timeZone }).pipe(
      Effect.mapError(() => new AppServiceRefused({ code: "rejected" })),
      Effect.flatMap((usageQuery) =>
        sources.usage(usageQuery).pipe(
          Effect.flatMap(Schema.encodeEffect(FleetUsage)),
          Effect.mapError(() => new AppServiceRefused({ code: "unavailable" }))
        )
      )
    )
