/**
 * Turning stored facts into what the graphs draw: usage per local period and Booking, and limit
 * series as steps.
 *
 * **Mental model**
 *
 * - **Periods are the viewer's.** The browser sends its IANA zone; hours, days and weeks start at
 *   local midnight (weeks on Monday), so a daylight-saving day is 23 or 25 hours long. Each stored
 *   15-minute bucket belongs to exactly one period, because every zone offset is a multiple of 15.
 * - **Bookings and costs are derived here** (ADR 0002), from Attribution Inputs, the Known
 *   Projects and today's prices. Typed keys of unknown projects are counted by prefix, not hidden.
 *   Unpriced tokens are carried beside the cost, never folded into it as zero.
 * - **A step line needs its starting value.** Each limit series begins at the range's left edge
 *   with the reading in force there, taken from the last snapshot before it.
 *
 * @module
 */
import { Data, Effect, Option } from "effect"
import type { BookingSummary, LimitSeries, LimitsReport, Period, UsageCell, UsageReport } from "../shared/contracts.js"
import { attribute, bookingId, projectOf } from "./Attribution.js"
import type { Agent, LimitSnapshot, TicketTitleValue, Tokens } from "./Model.js"
import { failureCovers, totalTokens } from "./Model.js"
import { groupCost } from "./Pricing.js"
import { BUCKET_MILLIS, type Range, type UsageGroup } from "./Store.js"

export type PeriodBucket = "hour" | "day" | "week"

export class UnknownTimeZone extends Data.TaggedError("UnknownTimeZone")<{ readonly zone: string }> {}

/**
 * Accepts any zone `Intl.DateTimeFormat` accepts, aliases and `Etc/GMT+5` included. The list
 * `Intl.supportedValuesOf` returns is narrower than what the formatter takes, and a browser sends
 * whatever its own runtime resolved.
 */
export const checkTimeZone = (zone: string): Effect.Effect<string, UnknownTimeZone> =>
  Effect.try({
    try: () => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone,
    catch: () => new UnknownTimeZone({ zone })
  }).pipe(Effect.as(zone))

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
    hourCycle: "h23",
    timeZoneName: "longOffset"
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
  // The offset keeps the hour that repeats when clocks go back apart from its first occurrence.
  if (bucket === "hour") {
    return `${year}-${pad(month)}-${pad(day)}T${parts.get("hour") ?? "00"}${parts.get("timeZoneName") ?? ""}`
  }
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
const periodIndex = (periods: ReadonlyArray<Period>, bucketStart: number, end: number): number | null => {
  const first = periods[0]?.start
  if (first === undefined) return null
  // The range may start inside a 15-minute bucket; the store already kept only the events inside
  // the range, so that first partial bucket belongs to the first period.
  const instant = bucketStart < first && bucketStart + BUCKET_MILLIS > first ? first : bucketStart
  if (instant < first || instant >= end) return null
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
  projects: ReadonlySet<string>,
  end: number = Number.POSITIVE_INFINITY
): UsageReport => {
  const bookings = new Map<string, MutableBooking>()
  const cells = new Map<string, UsageCell>()
  const unpricedModels = new Set<string>()
  let unpricedTokens = 0
  const ignored = new Map<string, number>()

  for (const group of groups) {
    const period = periodIndex(periods, group.bucketStart, end)
    if (period === null) continue
    const { booking, ignoredKey } = attribute(group.attribution, projects)
    if (ignoredKey !== null) {
      const prefix = projectOf(ignoredKey)
      ignored.set(prefix, (ignored.get(prefix) ?? 0) + group.requests)
    }
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
    unpriced: { tokens: unpricedTokens, models: [...unpricedModels].sort() },
    ignoredKeys: [...ignored]
      .map(([prefix, requests]) => ({ prefix, requests }))
      .sort((left, right) => right.requests - left.requests || left.prefix.localeCompare(right.prefix))
  }
}

/**
 * Which series a snapshot continues. Codex reports windows by slot (`primary`, `secondary`) and a
 * plan change moves the weekly window between slots, so Codex series follow the window's length.
 * Claude names each window, and two weekly windows (`seven_day`, `seven_day_opus`) are different
 * allowances, so Claude series follow the name.
 */
const seriesKey = (snapshot: LimitSnapshot): string =>
  snapshot.source === "codex-rollout" && snapshot.windowMinutes !== null
    ? `${snapshot.agent}\u0000${snapshot.windowMinutes}m`
    : `${snapshot.agent}\u0000${snapshot.label}`

const sameReading = (left: LimitSnapshot["reading"], right: LimitSnapshot["reading"]): boolean =>
  left._tag === "Known" && right._tag === "Known"
    ? left.usedPercent === right.usedPercent && left.resetsAt === right.resetsAt
    : left._tag === "Unknown" && right._tag === "Unknown" && left.reason === right.reason &&
      left.detail === right.detail

/**
 * Limit series over a range, from every snapshot up to its end in time order. Each series starts
 * at `from` with the reading in force there when one exists.
 */
export const buildLimitsReport = (
  snapshots: ReadonlyArray<LimitSnapshot>,
  range: Range
): Omit<LimitsReport, "balances"> => {
  interface Building {
    agent: LimitSnapshot["agent"]
    label: string
    windowMinutes: LimitSnapshot["windowMinutes"]
    points: Array<LimitSeries["points"][number]>
  }
  const series = new Map<string, Building>()
  const latest = new Map<string, LimitSnapshot>()
  const append = (entry: Building, at: number, reading: LimitSnapshot["reading"]) => {
    const point = { at: Math.max(at, range.from), reading }
    // Before the range, only the newest reading matters: it becomes the left-edge point.
    if (at < range.from) {
      entry.points = [point]
      return
    }
    // An unchanged reading continues the step it repeats; a failed poll in between has already
    // broken it with an Unknown point, so a recovery still starts a new one.
    const last = entry.points.at(-1)
    if (last !== undefined && sameReading(last.reading, reading)) return
    entry.points.push(point)
  }
  const ordered = [...snapshots].sort((left, right) => left.observedAt - right.observedAt)
  for (const snapshot of ordered) {
    if (snapshot.observedAt >= range.to) continue
    const key = seriesKey(snapshot)
    // The tiles show the newest observation, so "read … ago" moves on with unchanged readings.
    latest.set(key, snapshot)
    const entry = series.get(key) ??
      {
        agent: snapshot.agent,
        label: snapshot.label,
        windowMinutes: snapshot.windowMinutes,
        points: []
      }
    entry.label = snapshot.label
    entry.windowMinutes = snapshot.windowMinutes
    series.set(key, entry)
    append(entry, snapshot.observedAt, snapshot.reading)
    // A source that could not be read at all breaks every window of its agent, so no level is
    // carried across the outage; the next reading from any source restores it. Claude's windows are
    // observed by polls and claude-statusline alike, so the source a series was first seen by
    // cannot decide which failures it shows.
    if (snapshot.label === "*") {
      for (const [other, otherEntry] of series) {
        if (other !== key && otherEntry.agent === snapshot.agent && failureCovers(otherEntry.agent, otherEntry.label)) {
          append(otherEntry, snapshot.observedAt, snapshot.reading)
        }
      }
    }
  }
  const byOrder = (left: { readonly agent: string; readonly label: string }, right: typeof left) =>
    left.agent.localeCompare(right.agent) || left.label.localeCompare(right.label)
  // A series with no Known reading still in force inside the range has nothing to draw.
  const live = [...series.values()].map((entry): LimitSeries => ({
    agent: entry.agent,
    label: entry.label,
    windowMinutes: entry.windowMinutes,
    points: entry.points
  })).filter((entry) =>
    entry.points.some((point) =>
      point.reading._tag === "Known" &&
      (point.at > range.from || point.reading.resetsAt === null || point.reading.resetsAt > range.from)
    )
  )
  return {
    series: live.sort(byOrder),
    latest: [...latest.values()].sort(byOrder)
  }
}
