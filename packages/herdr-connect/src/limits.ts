/**
 * The wire shape of Claude and Codex limits in Connect: each host's `agent-usage limits` read, and
 * the fleet's. Schemas only, so the browser decodes what hostd serves without its Node imports.
 *
 * A read carries agent-usage's {@link LimitsNow} as is: limits only (balances and spend never leave
 * the host this way), each window's last snapshot, and the reading host's own clock in `observedAt`.
 *
 * @module
 */
import { LimitsNow } from "@knpkv/agent-usage/limits"
import { Schema } from "effect"

export { LimitsNow }

/** A failure's detail is the command's stderr, cut so a noisy host cannot bloat every answer. */
export const limitsDetailMaxLength = 512

/** Why a host has no limits to show; the page says which, rather than drawing an empty track. */
export const LimitsUnavailableReason = Schema.Literals(["not_configured", "failed", "timeout", "invalid_output"])
export type LimitsUnavailableReason = typeof LimitsUnavailableReason.Type

/** One host's latest read: agent-usage's answer, or why there is none. `readAt` is when this host ran it. */
export const HostLimits = Schema.Struct({
  host: Schema.String,
  readAt: Schema.Number,
  reading: Schema.Union([
    Schema.TaggedStruct("Read", { limits: LimitsNow }),
    Schema.TaggedStruct("Unavailable", {
      reason: LimitsUnavailableReason,
      detail: Schema.String.check(Schema.isMaxLength(limitsDetailMaxLength))
    })
  ])
})
export type HostLimits = typeof HostLimits.Type

export const PeerLimitsFailureReason = Schema.Literals([
  "offline",
  "unavailable",
  "timeout",
  "request_failed",
  "invalid_response"
])
export type PeerLimitsFailureReason = typeof PeerLimitsFailureReason.Type

/**
 * Every host the hub could ask, and the ones it could not reach, by name. `peersListed` is false
 * when the hub could not list the fleet at all: `hosts` is then only its own read, and the page
 * says the other machines are unknown rather than implying there are none.
 */
export const FleetLimits = Schema.Struct({
  hosts: Schema.Array(HostLimits),
  failures: Schema.Array(Schema.Struct({ host: Schema.String, reason: PeerLimitsFailureReason })),
  peersListed: Schema.Boolean
})
export type FleetLimits = typeof FleetLimits.Type
