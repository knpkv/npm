/**
 * Number and time formatting for the page, in the viewer's locale and zone.
 *
 * @module
 */
import type { Balance, UnknownReason } from "../core/Model.js"

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })

export const formatTokens = (tokens: number): string => compact.format(tokens)
export const formatUsd = (amount: number): string => usd.format(amount)

export const formatPercent = (percent: number): string => `${Math.round(percent)}%`

export const formatAge = (observedAt: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - observedAt) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export const formatInstant = (instant: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(instant)

/** "Oct 4, 16:01": a day and time without the year, for notes inside a chart. */
export const formatShortInstant = (instant: number): string =>
  new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
    instant
  )

/** A period label: weekday and date for days and weeks, time for hours. */
export const formatPeriod = (start: number, bucket: "hour" | "day" | "week"): string =>
  bucket === "hour"
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(start)
    : new Intl.DateTimeFormat(undefined, {
      weekday: bucket === "day" ? "short" : undefined,
      day: "numeric",
      month: "short"
    })
      .format(start)

const reasons = {
  NoAuth: "not signed in",
  AuthExpired: "sign-in expired",
  NotSupported: "not available on this plan",
  Fetch: "could not be fetched",
  Parse: "reply not understood",
  NoData: "nothing reported yet"
} satisfies Record<UnknownReason, string>

export const describeReason = (reason: UnknownReason): string => reasons[reason]

export const formatBalance = (balance: Balance): string => {
  switch (balance._tag) {
    case "Amount": {
      const amount = (balance.leftMinor / 10 ** balance.decimals).toFixed(balance.decimals)
      return balance.currency.toUpperCase() === "USD" ? `$${amount} left` : `${amount} ${balance.currency} left`
    }
    case "Credits":
      return `${compact.format(balance.credits)} credits`
    case "Unlimited":
      return "unlimited"
    case "Exhausted":
      return "used up"
    case "Disabled":
      return "switched off"
  }
}
