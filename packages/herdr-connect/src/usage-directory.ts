/**
 * Collecting the Usage tab's reads across the fleet, the way {@link hubLimits} collects limits: this
 * host's own read, plus each peer's from its tailnet `/v1/connect/usage/local`, for the same range
 * and zone. A peer's read is decoded tolerantly, so a newer agent-usage loses only what this hub
 * cannot read.
 *
 * @module
 */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { collectFleet, collectHub } from "./internal/fleet-reads.js"
import { PeerLimitsFailureReason } from "./limits.js"
import {
  decodeUsageTolerantly,
  type FleetUsage,
  type HostUsage,
  LooseHostUsage,
  type UsageQuery,
  usageReadingOf
} from "./usage.js"

export class PeerUsageError extends Schema.TaggedError<PeerUsageError>()("PeerUsageError", {
  cause: Schema.Defect(),
  host: Schema.String,
  reason: PeerLimitsFailureReason
}) {}

/** A peer the hub may ask, and its tailnet `/v1/connect/usage/local` URL without a query, if it has one. */
export interface PeerUsageTarget {
  readonly host: string
  readonly online: boolean
  readonly usageUrl: string | null
}

/** A month of daily token cells and bounded limit series is well under this; anything larger is not agent-usage. */
export const usageResponseMaxBytes = 2 * 1024 * 1024

// Longer than limits' 1.5 s: a 30-day read scans a month of the peer's store.
const peerUsageTimeoutMs = 5_000

/** The `/local` URL for one query. */
export const peerUsageUrl = (base: string, query: UsageQuery): string => {
  const url = new URL(base)
  url.searchParams.set("range", query.range)
  url.searchParams.set("timeZone", query.timeZone)
  return url.toString()
}

/** One peer's own read for `query`. The answer must name the peer it came from. */
export const fetchPeerUsage = (query: UsageQuery) =>
  Effect.fn("ConnectUsage.fetchPeer")(
    function*(peer: PeerUsageTarget) {
      if (!peer.online) return yield* new PeerUsageError({ cause: peer.host, host: peer.host, reason: "offline" })
      if (peer.usageUrl === null) {
        return yield* new PeerUsageError({ cause: peer.host, host: peer.host, reason: "unavailable" })
      }
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(peerUsageUrl(peer.usageUrl, query)).pipe(
        Effect.mapError((cause) => new PeerUsageError({ cause, host: peer.host, reason: "request_failed" }))
      )
      if (response.status < 200 || response.status >= 300) {
        return yield* new PeerUsageError({ cause: response.status, host: peer.host, reason: "request_failed" })
      }
      const loose = yield* decodeBoundedResponseJson(response, LooseHostUsage, usageResponseMaxBytes).pipe(
        Effect.mapError((cause) => new PeerUsageError({ cause, host: peer.host, reason: "invalid_response" }))
      )
      if (loose.host.toLowerCase() !== peer.host.toLowerCase()) {
        return yield* new PeerUsageError({ cause: loose.host, host: peer.host, reason: "invalid_response" })
      }
      const reading: HostUsage["reading"] = loose.reading._tag === "Unavailable"
        ? loose.reading
        : usageReadingOf(decodeUsageTolerantly(loose.reading.usage), loose.reading.skipped)
      return { host: loose.host, readAt: loose.readAt, reading } satisfies HostUsage
    },
    (effect, peer) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: peerUsageTimeoutMs,
          orElse: () =>
            Effect.fail(new PeerUsageError({ cause: peerUsageTimeoutMs, host: peer.host, reason: "timeout" }))
        })
      )
  )

/** This host's read first, then every peer's for the same query. */
export const fleetUsage = (
  query: UsageQuery,
  local: Effect.Effect<HostUsage>,
  peers: ReadonlyArray<PeerUsageTarget>
): Effect.Effect<FleetUsage, never, HttpClient.HttpClient> => collectFleet(local, peers, fetchPeerUsage(query))

/** The hub's view for one query; its own read alone, with `peersListed: false`, when the fleet cannot be listed. */
export const hubUsage = <E, R>(
  query: UsageQuery,
  local: Effect.Effect<HostUsage>,
  peers: Effect.Effect<ReadonlyArray<PeerUsageTarget>, E, R>
): Effect.Effect<FleetUsage, never, HttpClient.HttpClient | R> =>
  collectHub("Usage tab", local, peers, fetchPeerUsage(query))
