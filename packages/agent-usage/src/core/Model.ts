/**
 * The facts a store records: Usage Events, Limit Snapshots and Balance Readings.
 *
 * **Mental model**
 *
 * - **Facts, not conclusions.** A Usage Event carries token counts and Attribution Inputs; its
 *   Booking and API-Equivalent Cost are derived when read (ADR 0002).
 * - **Unknown is a value.** A limit or balance that could not be read is stored as `Unknown` with a
 *   reason, so a gap on a graph is a gap and never a zero.
 *
 * @module
 */
import { Schema } from "effect"

/** The closed set of coding-agent runtimes whose usage is recorded. */
export const Agent = Schema.Literals(["claude", "codex"])
export type Agent = typeof Agent.Type

/** A token count: a whole number, never negative. */
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * One request's token counts, split the way pricing needs them.
 *
 * `input` is uncached input only, for both agents: Codex reports cache hits inside its input count
 * and the readers subtract them, so the columns mean the same thing whichever agent wrote them.
 * Codex reports one cache-write count; it is stored as `cacheWrite5m`. `output` excludes
 * `reasoning` for both agents (Codex counts reasoning inside its output figure, Claude reports no
 * split), so the six fields add up to every token the request moved.
 */
export const Tokens = Schema.Struct({
  input: Count,
  output: Count,
  reasoning: Count,
  cacheRead: Count,
  cacheWrite5m: Count,
  cacheWrite1h: Count
})
export type Tokens = typeof Tokens.Type

/** Every token a request moved, the sum the "tokens" measure plots. */
export const totalTokens = (tokens: Tokens): number =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h

/** The facts captured with a Usage Event that decide its Booking. */
export const AttributionInputs = Schema.Struct({
  cwd: Schema.String,
  branch: Schema.String,
  activeTicket: Schema.NullOr(Schema.String)
})
export type AttributionInputs = typeof AttributionInputs.Type

/**
 * One model request's token counts on one Machine. `dedupeKey` is unique per Agent: Claude's
 * message id + request id, Codex's session id + the line's byte offset in its rollout.
 */
export const UsageEvent = Schema.Struct({
  agent: Agent,
  dedupeKey: Schema.NonEmptyString,
  machine: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  occurredAt: Schema.Int,
  model: Schema.NonEmptyString,
  /** Claude's fast mode: the same model billed at premium rates. */
  fast: Schema.Boolean,
  tokens: Tokens,
  attribution: AttributionInputs
})
export type UsageEvent = typeof UsageEvent.Type

/** Why a limit or balance could not be read. */
export const UnknownReason = Schema.Literals([
  "NoAuth",
  "AuthExpired",
  "NotSupported",
  "Fetch",
  "Parse",
  "NoData"
])
export type UnknownReason = typeof UnknownReason.Type

/** Where a Limit Snapshot or Balance Reading came from. */
export const ObservationSource = Schema.Literals(["claude-oauth-usage", "codex-rollout"])
export type ObservationSource = typeof ObservationSource.Type

/** A window's length in minutes, or Unknown for a provider key whose window nobody published. */
export const WindowMinutes = Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))
export type WindowMinutes = typeof WindowMinutes.Type

export const LimitReading = Schema.Union([
  Schema.TaggedStruct("Known", {
    usedPercent: Schema.Finite,
    /** Epoch milliseconds; null when the provider gave no reset time. */
    resetsAt: Schema.NullOr(Schema.Int)
  }),
  Schema.TaggedStruct("Unknown", { reason: UnknownReason })
])
export type LimitReading = typeof LimitReading.Type

/**
 * One observation of a Limit Window. `label` is the provider's own key (`five_hour`, `seven_day`,
 * Codex's `primary`/`secondary`); an Unknown reading for a whole source uses label `*`.
 */
export const LimitSnapshot = Schema.Struct({
  agent: Agent,
  machine: Schema.NonEmptyString,
  source: ObservationSource,
  label: Schema.NonEmptyString,
  windowMinutes: WindowMinutes,
  observedAt: Schema.Int,
  reading: LimitReading
})
export type LimitSnapshot = typeof LimitSnapshot.Type

export const Balance = Schema.Union([
  /** Claude extra usage left this billing period, in minor units of `currency`. */
  Schema.TaggedStruct("Amount", {
    leftMinor: Schema.Finite,
    limitMinor: Schema.Finite,
    decimals: Schema.Int,
    currency: Schema.String
  }),
  /** Codex credits, in Codex's own unit. */
  Schema.TaggedStruct("Credits", { credits: Schema.Finite }),
  Schema.TaggedStruct("Unlimited", {}),
  Schema.TaggedStruct("Exhausted", {}),
  /** Extra usage is switched off, so there is nothing to spend. */
  Schema.TaggedStruct("Disabled", {})
])
export type Balance = typeof Balance.Type

export const BalanceValue = Schema.Union([
  Schema.TaggedStruct("Known", { balance: Balance }),
  Schema.TaggedStruct("Unknown", { reason: UnknownReason })
])
export type BalanceValue = typeof BalanceValue.Type

/** Which balance a reading is of. */
export const BalanceKind = Schema.Literals(["claude-extra-usage", "codex-credits"])
export type BalanceKind = typeof BalanceKind.Type

export const BalanceReading = Schema.Struct({
  kind: BalanceKind,
  machine: Schema.NonEmptyString,
  observedAt: Schema.Int,
  value: BalanceValue
})
export type BalanceReading = typeof BalanceReading.Type

/** A ticket's Jira title, or why there is none. */
export const TicketTitleValue = Schema.Union([
  Schema.TaggedStruct("Known", { summary: Schema.String }),
  Schema.TaggedStruct("Unknown", { reason: Schema.Literals(["NotFound", "NotLookedUp"]) })
])
export type TicketTitleValue = typeof TicketTitleValue.Type
