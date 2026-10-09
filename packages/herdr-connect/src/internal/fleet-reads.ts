/**
 * The fan-out Connect's limits and the Usage tab share: this host's own read, plus each peer's from
 * its tailnet `/local` route, four at a time, with every peer that could not be asked named rather
 * than dropped; and, on the hub, the same answer with only its own read when the fleet cannot be
 * listed. Each caller supplies how one peer is read and decoded.
 *
 * @module
 */
import { Effect, Result } from "effect"
import type { PeerLimitsFailureReason } from "../limits.js"

/** A failed peer read, with the reason the page names it by. */
export interface PeerReadFailure {
  readonly reason: PeerLimitsFailureReason
}

/** Every host read, every peer that could not be read, and whether the fleet could be listed. */
export interface FleetReads<H> {
  readonly hosts: ReadonlyArray<H>
  readonly failures: ReadonlyArray<{ readonly host: string; readonly reason: PeerLimitsFailureReason }>
  readonly peersListed: boolean
}

/** This host's read first, then every peer's, four at a time; an unreachable peer is listed, not dropped. */
export const collectFleet = Effect.fn("ConnectFleetReads.collect")(function*<
  H,
  P extends { readonly host: string },
  E extends PeerReadFailure,
  R
>(
  local: Effect.Effect<H>,
  peers: ReadonlyArray<P>,
  read: (peer: P) => Effect.Effect<H, E, R>
) {
  const own = yield* local
  const results = yield* Effect.all(
    peers.map((peer) => Effect.result(read(peer)).pipe(Effect.map((result) => ({ peer, result })))),
    { concurrency: 4 }
  )
  const hosts: Array<H> = [own]
  const failures: Array<FleetReads<H>["failures"][number]> = []
  for (const { peer, result } of results) {
    if (Result.isSuccess(result)) hosts.push(result.success)
    else failures.push({ host: peer.host, reason: result.failure.reason })
  }
  return { hosts, failures, peersListed: true } satisfies FleetReads<H>
})

/**
 * The hub's view: its own read plus every peer it can list. When listing the fleet fails (for
 * example `tailscale status`), it logs why under `what` and answers with its own read and
 * `peersListed: false`.
 */
export const collectHub = Effect.fn("ConnectFleetReads.hub")(function*<
  H,
  P extends { readonly host: string },
  E extends PeerReadFailure,
  R,
  LE,
  LR
>(
  what: string,
  local: Effect.Effect<H>,
  peers: Effect.Effect<ReadonlyArray<P>, LE, LR>,
  read: (peer: P) => Effect.Effect<H, E, R>
) {
  const listed = yield* Effect.result(peers)
  if (Result.isSuccess(listed)) return yield* collectFleet(local, listed.success, read)
  yield* Effect.logWarning(`${what}: the fleet could not be listed; answering with this host only`, listed.failure)
  return { hosts: [yield* local], failures: [], peersListed: false } satisfies FleetReads<H>
})
