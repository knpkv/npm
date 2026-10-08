/**
 * The wire shapes of usage limits: `agent-limits --json` (contract v1) and what hostd serves from
 * it. Schemas only, so the browser bundle can decode them without the reader's Node imports.
 *
 * @module
 */
import { Schema } from "effect"

/** A failure's detail is the CLI's stderr; it is cut so a noisy host cannot bloat every snapshot. */
export const limitsDetailMaxLength = 512

/**
 * Claude and Codex subscription windows, as `agent-limits --json` reports them (contract v1).
 * A window the CLI cannot read is `Unknown` with a reason, never a zero; the hub keeps that
 * distinction all the way to the page.
 */
const Reading = <A extends Schema.Top>(value: A) =>
  Schema.Union([
    Schema.TaggedStruct("Known", { value }),
    // Reasons are words the CLI may add to; an unfamiliar one is still an unknown reading.
    Schema.TaggedStruct("Unknown", { reason: Schema.String })
  ])

export const LimitWindowId = Schema.Union([
  Schema.Literals(["five_hour", "weekly"]),
  Schema.Struct({ other: Schema.Number })
])
export type LimitWindowId = typeof LimitWindowId.Type

export const LimitWindowState = Schema.Union([
  Schema.TaggedStruct("Known", {
    usedPercent: Schema.Number,
    resetsAt: Schema.NullOr(Schema.Number),
    observedAt: Schema.Number,
    ageMs: Schema.Number,
    burnPerHour: Reading(Schema.Number),
    exhaustsAt: Reading(Schema.Union([Schema.Number, Schema.Literal("NotBeforeReset")])),
    source: Schema.String
  }),
  Schema.TaggedStruct("NotReported", {}),
  Schema.TaggedStruct("Unknown", {
    reason: Schema.String,
    observedAt: Schema.optionalKey(Schema.Number),
    ageMs: Schema.optionalKey(Schema.Number)
  })
])
export type LimitWindowState = typeof LimitWindowState.Type

/** The subscription a provider's windows belong to; `label` is for people (an email), `id` for grouping. */
export const LimitAccount = Schema.Union([
  Schema.TaggedStruct("Known", { id: Schema.String, label: Schema.String }),
  Schema.TaggedStruct("Unknown", { reason: Schema.String })
])
export type LimitAccount = typeof LimitAccount.Type

export const LimitProvider = Schema.Struct({
  reservePp: Schema.Number,
  // Added after v1 shipped; a CLI that predates it reports no account.
  account: Schema.optionalKey(LimitAccount),
  windows: Schema.Array(Schema.Struct({ window: LimitWindowId, state: LimitWindowState }))
})
export type LimitProvider = typeof LimitProvider.Type

export const AgentLimits = Schema.Struct({
  v: Schema.Literal(1),
  now: Schema.Number,
  providers: Schema.Struct({ claude: LimitProvider, codex: LimitProvider })
})
export type AgentLimits = typeof AgentLimits.Type

/** Why a host has no limits to show; the page says which, rather than drawing an empty meter. */
export const LimitsUnavailableReason = Schema.Literals([
  "not_configured",
  "failed",
  "timeout",
  "unsupported_version",
  "invalid_output"
])
export type LimitsUnavailableReason = typeof LimitsUnavailableReason.Type

/** One host's latest read: the CLI's report, or why there is none. `readAt` is when this host ran it. */
export const HostLimits = Schema.Struct({
  host: Schema.String,
  readAt: Schema.Number,
  reading: Schema.Union([
    Schema.TaggedStruct("Read", { limits: AgentLimits }),
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
