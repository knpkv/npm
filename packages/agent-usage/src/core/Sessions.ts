/**
 * One Booking's sessions within a range: which agent sessions spent on it, when, and how much.
 * The Booking is derived per group at read time, the same way the usage report books it,
 * so a session's cost here adds up to its share of that Booking's cost there. A session that worked
 * on two Bookings appears under each with only that Booking's part. Limits are never split by
 * session: a limit is the account's percentage, and nothing a session spent can claim a share of it.
 *
 * @module
 */
import { Option } from "effect"
import type { SessionsReport, SessionSummary } from "../shared/contracts.js"
import { attribute, bookingId } from "./Attribution.js"
import { totalTokens } from "./Model.js"
import { groupCost } from "./Pricing.js"
import { addTokens, zeroTokens } from "./Report.js"
import type { SessionGroup } from "./Store.js"

/** More rows than a span panel can usefully list; the rest are counted, not dropped silently. */
export const MAX_SESSIONS = 200

const sortedUnique = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort()

const merge = (current: SessionSummary | undefined, group: SessionGroup): SessionSummary => {
  const cost = groupCost(group)
  const base: SessionSummary = current ?? {
    agent: group.agent,
    sessionId: group.sessionId,
    firstAt: group.firstAt,
    lastAt: group.lastAt,
    requests: 0,
    tokens: zeroTokens,
    costUsd: 0,
    unpricedTokens: 0,
    models: [],
    unpricedModels: [],
    branches: []
  }
  return {
    ...base,
    firstAt: Math.min(base.firstAt, group.firstAt),
    lastAt: Math.max(base.lastAt, group.lastAt),
    requests: base.requests + group.requests,
    tokens: addTokens(base.tokens, group.tokens),
    costUsd: base.costUsd + Option.getOrElse(cost, () => 0),
    unpricedTokens: base.unpricedTokens + (Option.isNone(cost) ? totalTokens(group.tokens) : 0),
    models: sortedUnique([...base.models, group.model]),
    unpricedModels: Option.isNone(cost) ? sortedUnique([...base.unpricedModels, group.model]) : base.unpricedModels,
    branches: sortedUnique([...base.branches, group.attribution.branch])
  }
}

/** The sessions that booked usage to `booking`, most cost first, then most recent, capped at `MAX_SESSIONS`. */
export const buildSessionsReport = (
  groups: ReadonlyArray<SessionGroup>,
  projects: ReadonlySet<string>,
  booking: string
): SessionsReport => {
  // Local accumulator: copying a map per group would be quadratic in a busy week.
  const sessions = new Map<string, SessionSummary>()
  for (const group of groups) {
    if (bookingId(attribute(group.attribution, projects).booking) !== booking) continue
    const key = `${group.agent}\u0000${group.sessionId}`
    sessions.set(key, merge(sessions.get(key), group))
  }
  const ordered = [...sessions.values()].sort((left, right) =>
    right.costUsd - left.costUsd || right.lastAt - left.lastAt || left.sessionId.localeCompare(right.sessionId)
  )
  return { booking, sessions: ordered.slice(0, MAX_SESSIONS), omitted: Math.max(0, ordered.length - MAX_SESSIONS) }
}
