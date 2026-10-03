/**
 * Turning stored facts into what the graphs draw: usage per local period and Booking, and limit
 * series as steps.
 *
 * **Mental model**
 *
 * - **Periods are the viewer's.** The browser sends its IANA zone; hours, days and weeks start at
 *   local midnight (weeks on Monday), so a daylight-saving day is 23 or 25 hours long. Each stored
 *   15-minute bucket belongs to exactly one period, because every zone offset is a multiple of 15.
 * - **Bookings and costs are derived here** (ADR 0002), from Attribution Inputs and today's prices.
 *   Unpriced tokens are carried beside the cost, never folded into it as zero.
 * - **A step line needs its starting value.** Each limit series begins at the range's left edge
 *   with the reading in force there, taken from the last snapshot before it.
 *
 * @module
 */
import { Option } from "effect"
import type { BookingSummary, LimitSeries, LimitsReport, Period, UsageCell, UsageReport } from "../shared/contracts.js"
import { bookingId, bookingOf } from "./Attribution.js"
import type { Agent, LimitSnapshot, TicketTitleValue, Tokens } from "./Model.js"
import { totalTokens } from "./Model.js"
import { groupCost } from "./Pricing.js"
import { BUCKET_MILLIS, type Range, type UsageGroup } from "./Store.js"

export type PeriodBucket = "hour" | "day" | "week"

/** True for a zone the runtime knows by its IANA name, or UTC. */
export const isTimeZone = (zone: string): boolean => zone === "UTC" || Intl.supportedValuesOf("timeZone").includes(zone)

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  })
  formatters.set(timeZone, created)
  return created
}

const pad = (value: number): string => String(value).padStart(2, "0")

/** The local period an instant falls in, as a sortable key. */
const periodKey = (instant: number, timeZone: string, bucket: PeriodBucket): string => {
  const parts = new Map(formatterFor(timeZone).formatToParts(instant).map((part) => [part.type, part.value]))
  const year = Number(parts.get("year"))
  const month = Number(parts.get("month"))
  const day = Number(parts.get("day"))
  if (bucket === "hour") return `${year}-${pad(month)}-${pad(day)}T${parts.get("hour") ?? "00"}`
  if (bucket === "day") return `${year}-${pad(month)}-${pad(day)}`
  // Calendar arithmetic on the local date alone: back up to Monday.
  const date = new Date(Date.UTC(year, month - 1, day))
  const sinceMonday = (date.getUTCDay() + 6) % 7
  const monday = new Date(Date.UTC(year, month - 1, day - sinceMonday))
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`
}

/** Every local period the range touches, each with the first 15-minute instant inside the range. */
export const periodsOf = (options: {
  readonly from: number
  readonly to: number
  readonly timeZone: string
  readonly bucket: PeriodBucket
}): ReadonlyArray<Period> => {
  const periods: Array<Period> = []
  const first = options.from - (options.from % BUCKET_MILLIS)
  for (let instant = first; instant < options.to; instant += BUCKET_MILLIS) {
    const key = periodKey(instant, options.timeZone, options.bucket)
    if (periods.at(-1)?.key !== key) periods.push({ key, start: Math.max(instant, options.from) })
  }
  return periods
}

/** Which period a bucket start belongs to, by binary search over period starts. */
const periodIndex = (periods: ReadonlyArray<Period>, instant: number, end: number): number | null => {
  if (periods.length === 0 || instant < (periods[0]?.start ?? 0) || instant >= end) return null
  let low = 0
  let high = periods.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((periods[middle]?.start ?? 0) <= instant) low = middle
    else high = middle - 1
  }
  return low
}

const zeroTokens: Tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }

const addTokens = (left: Tokens, right: Tokens): Tokens => ({
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite5m: left.cacheWrite5m + right.cacheWrite5m,
  cacheWrite1h: left.cacheWrite1h + right.cacheWrite1h
})

interface MutableBooking {
  readonly summary: Omit<BookingSummary, "agents" | "unpricedModels">
  readonly agents: Set<Agent>
  readonly unpricedModels: Set<string>
}

/**
 * Usage per period and Booking. `end` bounds the last period; groups outside every period are
 * dropped. Titles are looked up by ticket key.
 */
export const buildUsageReport = (
  groups: ReadonlyArray<UsageGroup>,
  periods: ReadonlyArray<Period>,
  titles: Readonly<Record<string, TicketTitleValue>>,
  end: number = Number.POSITIVE_INFINITY
): UsageReport => {
  const bookings = new Map<string, MutableBooking>()
  const cells = new Map<string, UsageCell>()
  const unpricedModels = new Set<string>()
  let unpricedTokens = 0

  for (const group of groups) {
    const period = periodIndex(periods, group.bucketStart, end)
    if (period === null) continue
    const booking = bookingOf(group.attribution)
    const id = bookingId(booking)
    const tokens = totalTokens(group.tokens)
    const cost = groupCost(group)
    const costUsd = Option.getOrElse(cost, () => 0)
    const unpriced = Option.isNone(cost) ? tokens : 0
    if (Option.isNone(cost)) {
      unpricedModels.add(group.model)
      unpricedTokens += tokens
    }

    const existing = bookings.get(id)
    const current: MutableBooking = existing ?? {
      summary: {
        id,
        booking,
        title: booking._tag === "Ticket" ? titles[booking.key] ?? { _tag: "Unknown", reason: "NotLookedUp" } : null,
        requests: 0,
        tokens: zeroTokens,
        costUsd: 0,
        unpricedTokens: 0
      },
      agents: new Set(),
      unpricedModels: new Set()
    }
    current.agents.add(group.agent)
    if (Option.isNone(cost)) current.unpricedModels.add(group.model)
    bookings.set(id, {
      ...current,
      summary: {
        ...current.summary,
        requests: current.summary.requests + group.requests,
        tokens: addTokens(current.summary.tokens, group.tokens),
        costUsd: current.summary.costUsd + costUsd,
        unpricedTokens: current.summary.unpricedTokens + unpriced
      }
    })

    const cellKey = `${period}\u0000${id}`
    const cell = cells.get(cellKey) ?? { period, booking: id, tokens: 0, costUsd: 0, unpricedTokens: 0 }
    cells.set(cellKey, {
      ...cell,
      tokens: cell.tokens + tokens,
      costUsd: cell.costUsd + costUsd,
      unpricedTokens: cell.unpricedTokens + unpriced
    })
  }

  const summaries = [...bookings.values()]
    .map((booking): BookingSummary => ({
      ...booking.summary,
      agents: [...booking.agents].sort(),
      unpricedModels: [...booking.unpricedModels].sort()
    }))
    .sort((left, right) =>
      right.costUsd - left.costUsd || totalTokens(right.tokens) - totalTokens(left.tokens) ||
      left.id.localeCompare(right.id)
    )
  const order = new Map(summaries.map((summary, index) => [summary.id, index]))
  return {
    periods,
    bookings: summaries,
    cells: [...cells.values()].sort((left, right) =>
      left.period - right.period || (order.get(left.booking) ?? 0) - (order.get(right.booking) ?? 0)
    ),
    unpriced: { tokens: unpricedTokens, models: [...unpricedModels].sort() }
  }
}

const seriesKey = (snapshot: LimitSnapshot): string => `${snapshot.agent}\u0000${snapshot.label}`

/**
 * Limit series over a range, from every snapshot up to its end in time order. Each series starts
 * at `from` with the reading in force there when one exists.
 */
export const buildLimitsReport = (
  snapshots: ReadonlyArray<LimitSnapshot>,
  range: Range
): Omit<LimitsReport, "balances"> => {
  const series = new Map<string, LimitSeries>()
  const latest = new Map<string, LimitSnapshot>()
  const ordered = [...snapshots].sort((left, right) => left.observedAt - right.observedAt)
  for (const snapshot of ordered) {
    if (snapshot.observedAt >= range.to) continue
    const key = seriesKey(snapshot)
    latest.set(key, snapshot)
    const current = series.get(key) ?? {
      agent: snapshot.agent,
      label: snapshot.label,
      windowMinutes: snapshot.windowMinutes,
      points: []
    }
    const point = { at: Math.max(snapshot.observedAt, range.from), reading: snapshot.reading }
    // Before the range, only the newest reading matters: it becomes the left-edge point.
    const points = snapshot.observedAt < range.from ? [point] : [...current.points, point]
    series.set(key, { ...current, windowMinutes: snapshot.windowMinutes, points })
  }
  const byOrder = (left: { readonly agent: string; readonly label: string }, right: typeof left) =>
    left.agent.localeCompare(right.agent) || left.label.localeCompare(right.label)
  return {
    series: [...series.values()].sort(byOrder),
    latest: [...latest.values()].sort(byOrder)
  }
}
