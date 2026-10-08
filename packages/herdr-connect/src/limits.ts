/**
 * The wire shape of Claude and Codex limits in Connect: each host's `agent-usage limits` read, and
 * the fleet's. Schemas only, so the browser decodes what hostd serves without its Node imports.
 *
 * A read carries agent-usage's {@link LimitsNow}: limits only (balances and spend never leave the
 * host this way), each window's last snapshot, and the reading host's own clock in `observedAt`.
 *
 * **Version drift.** agent-usage and hostd are pinned separately, so a line may come from a newer
 * agent-usage. A different `v` is `unsupported_version`, not malformed; within v1, `latest` is
 * decoded one snapshot at a time, and a snapshot this version cannot read (a new source or reason)
 * is skipped and counted rather than blanking the host.
 *
 * @module
 */
import { LimitSnapshot, LimitsNow } from "@knpkv/agent-usage/limits"
import { Option, Result, Schema } from "effect"

export { LimitsNow }

/** A failure's detail is the command's stderr, cut so a noisy host cannot bloat every answer. */
export const limitsDetailMaxLength = 512

/** Why a host has no limits to show; the page says which, rather than drawing an empty track. */
export const LimitsUnavailableReason = Schema.Literals([
  "not_configured",
  "failed",
  "timeout",
  "unsupported_version",
  "invalid_output"
])
export type LimitsUnavailableReason = typeof LimitsUnavailableReason.Type

/** One host's latest read: agent-usage's answer, or why there is none. `readAt` is when this host ran it. */
export const HostLimits = Schema.Struct({
  host: Schema.String,
  readAt: Schema.Number,
  reading: Schema.Union([
    Schema.TaggedStruct("Read", {
      limits: LimitsNow,
      /** Snapshots in the line this version could not read (a newer source or reason), left out. */
      skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    }),
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

/** A {@link LimitsNow} as read across a version boundary: what decoded, or why nothing did. */
export type TolerantLimits =
  | { readonly _tag: "Read"; readonly limits: LimitsNow; readonly skipped: number }
  | { readonly _tag: "UnsupportedVersion"; readonly version: string }
  | { readonly _tag: "Invalid"; readonly detail: string }

/**
 * A limits line before anything in it is trusted: a JSON object, decoded at the boundary (the
 * command's stdout, a peer's answer) and handed to {@link decodeLimitsTolerantly}.
 */
export const RawLimits = Schema.Record(Schema.String, Schema.Unknown)
export type RawLimits = typeof RawLimits.Type

const Versioned = Schema.Struct({ v: Schema.Unknown })
const LimitsEnvelope = Schema.Struct({
  v: Schema.Literal(1),
  machine: Schema.NonEmptyString,
  observedAt: Schema.Int,
  latest: Schema.Array(Schema.Unknown)
})
const decodeVersioned = Schema.decodeUnknownOption(Versioned)
const decodeEnvelope = Schema.decodeUnknownResult(LimitsEnvelope)
const decodeSnapshot = Schema.decodeUnknownOption(LimitSnapshot)

/**
 * Reads a {@link LimitsNow} from another agent-usage or hostd version: `v` first, then each snapshot
 * on its own, keeping those that decode and counting the rest.
 */
export const decodeLimitsTolerantly = (raw: RawLimits): TolerantLimits => {
  const versioned = decodeVersioned(raw)
  if (Option.isSome(versioned) && versioned.value.v !== 1) {
    return { _tag: "UnsupportedVersion", version: JSON.stringify(versioned.value.v) ?? "none" }
  }
  const envelope = decodeEnvelope(raw)
  if (Result.isFailure(envelope)) return { _tag: "Invalid", detail: String(envelope.failure) }
  const latest = envelope.success.latest.flatMap((snapshot) => Option.toArray(decodeSnapshot(snapshot)))
  return {
    _tag: "Read",
    limits: { ...envelope.success, latest },
    skipped: envelope.success.latest.length - latest.length
  }
}

/**
 * A peer's {@link HostLimits} before its read is checked: the hub decodes the read with
 * {@link decodeLimitsTolerantly}, so a peer on a newer agent-usage loses only what it can't read.
 */
export const LooseHostLimits = Schema.Struct({
  host: Schema.String,
  readAt: Schema.Number,
  reading: Schema.Union([
    Schema.TaggedStruct("Read", { limits: RawLimits, skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
    HostLimits.fields.reading.members[1]
  ])
})

/** An `Unavailable` read, its detail trimmed to {@link limitsDetailMaxLength}. */
export const limitsUnavailable = (reason: LimitsUnavailableReason, detail: string): HostLimits["reading"] => ({
  _tag: "Unavailable",
  reason,
  detail: detail.trim().slice(0, limitsDetailMaxLength)
})

/** A tolerant read as a host's reading; `alreadySkipped` adds what an earlier reader left out. */
export const readingOf = (read: TolerantLimits, alreadySkipped = 0): HostLimits["reading"] => {
  switch (read._tag) {
    case "Read":
      return { _tag: "Read", limits: read.limits, skipped: alreadySkipped + read.skipped }
    case "UnsupportedVersion":
      return limitsUnavailable("unsupported_version", `limits format v${read.version}; this reader knows v1`)
    case "Invalid":
      return limitsUnavailable("invalid_output", read.detail)
  }
}
