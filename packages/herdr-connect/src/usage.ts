/**
 * The wire shape of the hub's Usage tab: each host's `agent-usage usage` read, and the fleet's.
 * Schemas only, so the browser decodes what hostd serves without its Node imports.
 *
 * A read carries agent-usage's {@link UsageNow}: tokens per period, agent and model, and the limit
 * series. agent-usage leaves cost, balances, Bookings (tickets, repos), sessions and paths out of it
 * at the source, so none of them crosses the tailnet; this module adds nothing back.
 *
 * **Version drift.** As with limits: a different `v` is `unsupported_version`; within v1 each token
 * cell and each limit series is decoded on its own, and one this version cannot read (a new agent or
 * reason) is skipped and counted rather than blanking the host.
 *
 * @module
 */
import { LimitSeries, TokenCell, UsageNow, UsagePreset } from "@knpkv/agent-usage/usage"
import { Option, Result, Schema } from "effect"
import { limitsDetailMaxLength, PeerLimitsFailureReason, RawLimits } from "./limits.js"
import { reasonSentences } from "./unavailable-detail.js"

export { UsageNow, UsagePreset }

/**
 * An IANA zone as the Usage tab sends it: letters, digits and `_ + - /` only, so it can never split
 * the command line or the control-socket request it is passed into. agent-usage checks it is real.
 */
export const UsageTimeZone = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/u))

/** A month of daily token cells and bounded limit series is well under this; anything larger is not agent-usage. */
export const usageResponseMaxBytes = 2 * 1024 * 1024

/** What the Usage tab asks for: a range preset and the viewer's zone, so every host's periods line up. */
export const UsageQuery = Schema.Struct({ range: UsagePreset, timeZone: UsageTimeZone })
export type UsageQuery = typeof UsageQuery.Type

/** Why a host has no usage to show; the same reasons as limits. */
export const UsageUnavailableReason = Schema.Literals([
  "not_configured",
  "failed",
  "timeout",
  "unsupported_version",
  "invalid_output"
])
export type UsageUnavailableReason = typeof UsageUnavailableReason.Type

/** One host's read for one query: agent-usage's answer, or why there is none. `readAt` is when this host ran it. */
export const HostUsage = Schema.Struct({
  host: Schema.String,
  readAt: Schema.Number,
  reading: Schema.Union([
    Schema.TaggedStruct("Read", {
      usage: UsageNow,
      /** Token cells and limit series this version could not read, left out. */
      skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
    }),
    Schema.TaggedStruct("Unavailable", {
      reason: UsageUnavailableReason,
      detail: Schema.String.check(Schema.isMaxLength(limitsDetailMaxLength))
    })
  ])
})
export type HostUsage = typeof HostUsage.Type

/** Every host the hub could ask, and the ones it could not reach; `peersListed` as for limits. */
export const FleetUsage = Schema.Struct({
  hosts: Schema.Array(HostUsage),
  failures: Schema.Array(Schema.Struct({ host: Schema.String, reason: PeerLimitsFailureReason })),
  peersListed: Schema.Boolean
})
export type FleetUsage = typeof FleetUsage.Type

/** A {@link UsageNow} as read across a version boundary: what decoded, or why nothing did. */
export type TolerantUsage =
  | { readonly _tag: "Read"; readonly usage: UsageNow; readonly skipped: number }
  | { readonly _tag: "UnsupportedVersion"; readonly version: string }
  | { readonly _tag: "Invalid"; readonly detail: string }

/** A usage line before anything in it is trusted: a JSON object, for {@link decodeUsageTolerantly}. */
export const RawUsage = RawLimits
export type RawUsage = typeof RawUsage.Type

const Versioned = Schema.Struct({ v: Schema.Unknown })
const UsageEnvelope = Schema.Struct({
  ...UsageNow.fields,
  tokens: Schema.Array(Schema.Unknown),
  limits: Schema.Array(Schema.Unknown)
})
const decodeVersioned = Schema.decodeUnknownOption(Versioned)
const decodeEnvelope = Schema.decodeUnknownResult(UsageEnvelope)
const decodeCell = Schema.decodeUnknownOption(TokenCell)
const decodeSeries = Schema.decodeUnknownOption(LimitSeries)

/**
 * Reads a {@link UsageNow} from another agent-usage or hostd version: `v` first, then each token
 * cell and limit series on its own, keeping those that decode and counting the rest. A cell naming
 * a period the answer does not have is dropped as unreadable.
 */
export const decodeUsageTolerantly = (raw: RawUsage): TolerantUsage => {
  const versioned = decodeVersioned(raw)
  if (Option.isSome(versioned) && versioned.value.v !== 1) {
    return { _tag: "UnsupportedVersion", version: JSON.stringify(versioned.value.v) ?? "none" }
  }
  const envelope = decodeEnvelope(raw)
  if (Result.isFailure(envelope)) return { _tag: "Invalid", detail: String(envelope.failure) }
  const periods = envelope.success.periods.length
  const tokens = envelope.success.tokens.flatMap((cell) =>
    Option.toArray(Option.filter(decodeCell(cell), (decoded) => decoded.period < periods))
  )
  const limits = envelope.success.limits.flatMap((series) => Option.toArray(decodeSeries(series)))
  return {
    _tag: "Read",
    usage: { ...envelope.success, tokens, limits },
    skipped: envelope.success.tokens.length - tokens.length + envelope.success.limits.length - limits.length
  }
}

/** A peer's {@link HostUsage} before its read is checked; the hub decodes it with {@link decodeUsageTolerantly}. */
export const LooseHostUsage = Schema.Struct({
  host: Schema.String,
  readAt: Schema.Number,
  reading: Schema.Union([
    Schema.TaggedStruct("Read", { usage: RawUsage, skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
    HostUsage.fields.reading.members[1]
  ])
})

/** An `Unavailable` read, its detail trimmed like a limits one. */
export const usageUnavailable = (reason: UsageUnavailableReason, detail: string): HostUsage["reading"] => ({
  _tag: "Unavailable",
  reason,
  detail: detail.trim().slice(0, limitsDetailMaxLength)
})

/** A tolerant read as a host's reading; `alreadySkipped` adds what an earlier reader left out. */
export const usageReadingOf = (read: TolerantUsage, alreadySkipped = 0): HostUsage["reading"] => {
  switch (read._tag) {
    case "Read":
      return { _tag: "Read", usage: read.usage, skipped: alreadySkipped + read.skipped }
    case "UnsupportedVersion":
      return usageUnavailable("unsupported_version", reasonSentences.unsupported_version)
    case "Invalid":
      // The decode error quotes what was printed, which may name host paths: it never leaves as is.
      return usageUnavailable("invalid_output", reasonSentences.invalid_output)
  }
}
