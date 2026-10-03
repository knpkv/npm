/**
 * Classifying what a provider says about a spendable balance into a Balance Value, without ever
 * collapsing "we could not tell" into a number. Ported from claude-statusline's credit readers.
 *
 * @module
 */
import { Option, Schema } from "effect"
import type { BalanceValue, UnknownReason } from "./Model.js"

const unknown = (reason: UnknownReason): BalanceValue => ({ _tag: "Unknown", reason })

/** Codex's `rate_limits.credits` block on a rollout token_count event. */
export const CodexCredits = Schema.Struct({
  has_credits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.NullOr(Schema.String)
})
export type CodexCredits = typeof CodexCredits.Type

export const classifyCodexCredits = (credits: CodexCredits): BalanceValue => {
  if (credits.unlimited) return { _tag: "Known", balance: { _tag: "Unlimited" } }
  // No credits on the account: a "0" here is not a balance that ran out.
  if (!credits.has_credits) return unknown("NotSupported")
  if (credits.balance === null) return unknown("NoData")
  const raw = credits.balance.trim()
  const amount = Number(raw)
  if (raw === "" || !Number.isFinite(amount)) return unknown("Parse")
  if (amount <= 0) return { _tag: "Known", balance: { _tag: "Exhausted" } }
  return { _tag: "Known", balance: { _tag: "Credits", credits: amount } }
}

/** Claude's `extra_usage` block on the `/api/oauth/usage` reply. */
export const ExtraUsage = Schema.Struct({
  is_enabled: Schema.Boolean,
  monthly_limit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  used_credits: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
  decimal_places: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  spend_limit_reached: Schema.optionalKey(Schema.NullOr(Schema.Boolean))
})
export type ExtraUsage = typeof ExtraUsage.Type

export const classifyExtraUsage = (extra: ExtraUsage | null | undefined): BalanceValue => {
  if (extra === undefined || extra === null) return unknown("NotSupported")
  if (!extra.is_enabled) {
    return { _tag: "Known", balance: { _tag: extra.spend_limit_reached === true ? "Exhausted" : "Disabled" } }
  }
  // Amounts are minor units of `currency`; without both, any figure is a guess.
  const currency = Option.fromNullishOr(extra.currency)
  const decimals = Option.fromNullishOr(extra.decimal_places)
  if (Option.isNone(currency) || Option.isNone(decimals)) return unknown("Parse")
  const limit = extra.monthly_limit
  const used = extra.used_credits
  if (limit === undefined || limit === null || used === undefined || used === null) return unknown("NoData")
  const left = limit - used
  if (left <= 0) return { _tag: "Known", balance: { _tag: "Exhausted" } }
  return {
    _tag: "Known",
    balance: { _tag: "Amount", leftMinor: left, limitMinor: limit, decimals: decimals.value, currency: currency.value }
  }
}
