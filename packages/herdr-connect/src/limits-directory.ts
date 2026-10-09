/**
 * Collecting limits across the fleet, the way {@link fleetConnectAgents} collects agents: this
 * host's own read, plus each peer's from its tailnet `/v1/connect/limits/local`, four at a time,
 * with every peer that could not be asked named rather than dropped.
 *
 * @module
 */
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet"
import { Effect, Result, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import {
  decodeLimitsTolerantly,
  type FleetLimits,
  type HostLimits,
  LooseHostLimits,
  PeerLimitsFailureReason,
  readingOf
} from "./limits.js"

export class PeerLimitsError extends Schema.TaggedError<PeerLimitsError>()("PeerLimitsError", {
  cause: Schema.Defect(),
  host: Schema.String,
  reason: PeerLimitsFailureReason
}) {}

export interface PeerLimitsTarget {
  readonly host: string
  readonly online: boolean
  readonly limitsUrl: string | null
}

const peerLimitsTimeoutMs = 1_500

/**
 * One peer's own read. The answer must name the peer it came from. The read inside is decoded
 * tolerantly, so a peer on a newer agent-usage loses only the snapshots this hub cannot read.
 */
export const fetchPeerLimits = Effect.fn("ConnectLimits.fetchPeer")(
  function*(peer: PeerLimitsTarget) {
    if (!peer.online) return yield* new PeerLimitsError({ cause: peer.host, host: peer.host, reason: "offline" })
    if (peer.limitsUrl === null) {
      return yield* new PeerLimitsError({ cause: peer.host, host: peer.host, reason: "unavailable" })
    }
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(peer.limitsUrl).pipe(
      Effect.mapError((cause) => new PeerLimitsError({ cause, host: peer.host, reason: "request_failed" }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* new PeerLimitsError({ cause: response.status, host: peer.host, reason: "request_failed" })
    }
    const loose = yield* decodeBoundedResponseJson(response, LooseHostLimits).pipe(
      Effect.mapError((cause) => new PeerLimitsError({ cause, host: peer.host, reason: "invalid_response" }))
    )
    if (loose.host.toLowerCase() !== peer.host.toLowerCase()) {
      return yield* new PeerLimitsError({ cause: loose.host, host: peer.host, reason: "invalid_response" })
    }
    const reading: HostLimits["reading"] = loose.reading._tag === "Unavailable"
      ? loose.reading
      : readingOf(decodeLimitsTolerantly(loose.reading.limits), loose.reading.skipped)
    return { host: loose.host, readAt: loose.readAt, reading } satisfies HostLimits
  },
  (effect, peer) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: peerLimitsTimeoutMs,
        orElse: () =>
          Effect.fail(new PeerLimitsError({ cause: peerLimitsTimeoutMs, host: peer.host, reason: "timeout" }))
      })
    )
)

/** This host's read first, then every peer's; an unreachable peer is listed, not dropped. */
export const fleetLimits = Effect.fn("ConnectLimits.fleet")(function*(
  local: Effect.Effect<HostLimits>,
  peers: ReadonlyArray<PeerLimitsTarget>
) {
  const own = yield* local
  const results = yield* Effect.all(
    peers.map((peer) => Effect.result(fetchPeerLimits(peer)).pipe(Effect.map((result) => ({ peer, result })))),
    { concurrency: 4 }
  )
  const hosts: Array<HostLimits> = [own]
  const failures: Array<FleetLimits["failures"][number]> = []
  for (const { peer, result } of results) {
    if (Result.isSuccess(result)) hosts.push(result.success)
    else failures.push({ host: peer.host, reason: result.failure.reason })
  }
  return { hosts, failures, peersListed: true } satisfies FleetLimits
})

/**
 * The hub's view: its own read plus every peer it can list. When listing the fleet fails (for
 * example `tailscale status`), it logs why and still answers with its own read and
 * `peersListed: false`.
 */
export const hubLimits = Effect.fn("ConnectLimits.hub")(function*<E, R>(
  local: Effect.Effect<HostLimits>,
  peers: Effect.Effect<ReadonlyArray<PeerLimitsTarget>, E, R>
) {
  const listed = yield* Effect.result(peers)
  if (Result.isSuccess(listed)) return yield* fleetLimits(local, listed.success)
  yield* Effect.logWarning(
    "Connect limits: the fleet could not be listed; answering with this host only",
    listed.failure
  )
  return { hosts: [yield* local], failures: [], peersListed: false } satisfies FleetLimits
})
