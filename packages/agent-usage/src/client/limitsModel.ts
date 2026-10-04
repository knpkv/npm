/**
 * What the limits part of the page says, worked out before anything is drawn: which windows each
 * agent has, how close each is, when it resets, and whether the reading is fresh.
 *
 * **Mental model**
 *
 * - **The question is "am I about to hit a limit?"** Groups and windows are ordered by how close
 *   they are, so the one at its limit comes first; the tone is a word as well as a colour.
 * - **Windows Claude does not name are kept, not featured.** An unpublished allowance key is listed
 *   under the agent as unnamed rather than dropped or given a tile of its own.
 * - **A gap has a reason.** A level holds until the next reading or its reset. After a reset nobody
 *   has read, the level is unknown (`reset`); a poll that failed is a different gap (`unknown`).
 *
 * @module
 */
import type { Agent, LimitReading, LimitSnapshot, UnknownReason } from "../core/Model.js"
import type { LimitSeries } from "../shared/contracts.js"
import { seriesIdentity } from "./chartModel.js"
import { describeReason } from "./format.js"

/** A failed reading in words, with what exactly went wrong when that is known. */
export const describeUnknown = (
  reading: { readonly reason: UnknownReason; readonly detail?: string | undefined }
): string =>
  reading.detail === undefined ? describeReason(reading.reason) : `${describeReason(reading.reason)}: ${reading.detail}`

export type LimitTone = "ok" | "near" | "at-limit" | "unknown"

/** At or above this share of a window, it is close enough to say so. */
export const NEAR_PERCENT = 80

/** A reading older than this is shown as stale: the agent has not been used since. */
export const STALE_AFTER_MILLIS = 15 * 60 * 1000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const limitTone = (reading: LimitReading): LimitTone =>
  reading._tag === "Unknown"
    ? "unknown"
    : reading.usedPercent >= 100
    ? "at-limit"
    : reading.usedPercent >= NEAR_PERCENT
    ? "near"
    : "ok"

const toneRank = { "at-limit": 3, near: 2, unknown: 1, ok: 0 } satisfies Record<LimitTone, number>

/** "resets in 4h 12m": how long until a window resets, or "reset" once it has. */
export const relativeReset = (resetsAt: number, now: number): string => {
  const left = resetsAt - now
  if (left <= 0) return "reset"
  if (left >= DAY) return `resets in ${Math.floor(left / DAY)}d ${Math.floor((left % DAY) / HOUR)}h`
  if (left >= HOUR) return `resets in ${Math.floor(left / HOUR)}h ${Math.floor((left % HOUR) / MINUTE)}m`
  return `resets in ${Math.max(1, Math.round(left / MINUTE))}m`
}

const CLAUDE_MODEL_WINDOWS = new Map([
  ["seven_day_opus", "Weekly · Opus"],
  ["seven_day_sonnet", "Weekly · Sonnet"]
])

/** A window's name, or null when the provider's key is not one anybody published. */
export const windowName = (window: {
  readonly agent: Agent
  readonly label: string
  readonly windowMinutes: number | null
}): string | null => {
  if (window.label === "*") return null
  if (window.agent === "claude") {
    if (window.label === "five_hour") return "5-hour"
    if (window.label === "seven_day") return "Weekly"
    // The spend limit claude-statusline samples from the apps gateway.
    if (window.label === "spend") return "Spend"
    return CLAUDE_MODEL_WINDOWS.get(window.label) ?? null
  }
  if (window.windowMinutes === 300) return "5-hour"
  if (window.windowMinutes === 10_080) return "Weekly"
  if (window.windowMinutes === null) return null
  // Exact length only: a 90-minute window is not a "2-hour" one.
  return window.windowMinutes % 60 === 0 ? `${window.windowMinutes / 60}-hour` : `${window.windowMinutes}-minute`
}

export const agentName = (agent: Agent): string => (agent === "claude" ? "Claude" : "Codex")

/** A window's name with its agent, for places that list windows of both: "Claude 5-hour". */
export const fullWindowName = (window: {
  readonly agent: Agent
  readonly label: string
  readonly windowMinutes: number | null
}): string => {
  if (window.label === "*") return `${agentName(window.agent)} limits`
  return `${agentName(window.agent)} ${windowName(window) ?? `allowance ${window.label}`}`
}

export interface WindowSummary {
  readonly id: string
  readonly name: string
  readonly tone: LimitTone
  /** Null when the reading failed. */
  readonly usedPercent: number | null
  readonly reset: string | null
  readonly resetsAt: number | null
  readonly freshness: "current" | "stale"
  readonly observedAt: number
  /** Why the reading failed, in words; null when it did not. */
  readonly problem: string | null
}

export interface AgentLimits {
  readonly agent: Agent
  readonly windows: ReadonlyArray<WindowSummary>
  /** Allowances the provider reports under keys nobody published. */
  readonly unnamed: ReadonlyArray<WindowSummary>
  /** The agent's limits could not be read at all on the latest poll. */
  readonly problem: { readonly reason: string; readonly observedAt: number } | null
}

const summarize = (snapshot: LimitSnapshot, name: string, now: number): WindowSummary => {
  const reading = snapshot.reading
  const resetsAt = reading._tag === "Known" ? reading.resetsAt : null
  return {
    id: seriesIdentity(snapshot),
    name,
    tone: limitTone(reading),
    usedPercent: reading._tag === "Known" ? reading.usedPercent : null,
    reset: resetsAt === null ? null : relativeReset(resetsAt, now),
    resetsAt,
    freshness: now - snapshot.observedAt > STALE_AFTER_MILLIS ? "stale" : "current",
    observedAt: snapshot.observedAt,
    problem: reading._tag === "Unknown" ? describeUnknown(reading) : null
  }
}

const byCloseness = (left: WindowSummary, right: WindowSummary): number =>
  toneRank[right.tone] - toneRank[left.tone] || (right.usedPercent ?? -1) - (left.usedPercent ?? -1)

/**
 * The latest limits, per agent, closest-to-the-limit first. Windows that reset since they were
 * read, or were read before a poll that then failed for the whole agent, are left out.
 */
export const summarizeLimits = (latest: ReadonlyArray<LimitSnapshot>, now: number): ReadonlyArray<AgentLimits> => {
  const agents: ReadonlyArray<Agent> = ["claude", "codex"]
  const groups = agents.flatMap((agent): ReadonlyArray<AgentLimits> => {
    const own = latest.filter((snapshot) => snapshot.agent === agent)
    if (own.length === 0) return []
    const failure = own.find((snapshot) => snapshot.label === "*")
    const failedAt = failure?.observedAt ?? Number.NEGATIVE_INFINITY
    const live = own.filter(
      (snapshot) =>
        snapshot.label !== "*" &&
        snapshot.observedAt > failedAt &&
        !(snapshot.reading._tag === "Known" && snapshot.reading.resetsAt !== null && snapshot.reading.resetsAt <= now)
    )
    const named: Array<WindowSummary> = []
    const unnamed: Array<WindowSummary> = []
    for (const snapshot of live) {
      const name = windowName(snapshot)
      if (name === null) unnamed.push(summarize(snapshot, `Unnamed allowance (${snapshot.label})`, now))
      else named.push(summarize(snapshot, name, now))
    }
    const problem = failure !== undefined &&
        failure.reading._tag === "Unknown" &&
        own.every((snapshot) => snapshot.label === "*" || snapshot.observedAt < failure.observedAt)
      ? { reason: describeUnknown(failure.reading), observedAt: failure.observedAt }
      : null
    return [{ agent, windows: named.sort(byCloseness), unnamed: unnamed.sort(byCloseness), problem }]
  })
  const worst = (group: AgentLimits): number => Math.max(-1, ...group.windows.map((window) => toneRank[window.tone]))
  return [...groups].sort((left, right) => worst(right) - worst(left))
}

export type LimitSegment =
  | { readonly kind: "level"; readonly from: number; readonly to: number; readonly usedPercent: number }
  | { readonly kind: "reset"; readonly from: number; readonly to: number }
  | {
    readonly kind: "unknown"
    readonly from: number
    readonly to: number
    readonly reason: UnknownReason
    readonly detail: string | null
  }

/**
 * A limit series as drawable spans: each Known level until the next reading or its reset, the
 * time after a reset nobody read, and the time a reading failed.
 */
export const limitSegments = (
  points: ReadonlyArray<{ readonly at: number; readonly reading: LimitReading }>,
  end: number
): ReadonlyArray<LimitSegment> =>
  points.flatMap((point, index): ReadonlyArray<LimitSegment> => {
    const next = points[index + 1]?.at ?? end
    if (next <= point.at) return []
    if (point.reading._tag === "Unknown") {
      return [{
        kind: "unknown",
        from: point.at,
        to: next,
        reason: point.reading.reason,
        detail: point.reading.detail ?? null
      }]
    }
    const resetsAt = point.reading.resetsAt
    if (resetsAt === null || resetsAt >= next) {
      return [{ kind: "level", from: point.at, to: next, usedPercent: point.reading.usedPercent }]
    }
    if (resetsAt <= point.at) return [{ kind: "reset", from: point.at, to: next }]
    return [
      { kind: "level", from: point.at, to: resetsAt, usedPercent: point.reading.usedPercent },
      { kind: "reset", from: resetsAt, to: next }
    ]
  })

type Point = LimitSeries["points"][number]

export interface LimitRow {
  readonly id: string
  readonly name: string
  /** The window's readings with its agent's failed polls merged in, oldest first. */
  readonly points: ReadonlyArray<Point>
  /** The first reading of the window itself in the range; null when it has none. */
  readonly firstAt: number | null
}

/**
 * One chart row per named window. A poll that failed for the whole agent left every one of its
 * windows unknown, so those readings join each of its rows; unnamed allowances stay in the table.
 */
export const limitRows = (series: ReadonlyArray<LimitSeries>): ReadonlyArray<LimitRow> =>
  series.flatMap((window): ReadonlyArray<LimitRow> => {
    const name = windowName(window)
    if (name === null) return []
    const failures = series
      .filter((other) => other.agent === window.agent && other.label === "*")
      .flatMap((other) => other.points)
    return [
      {
        id: seriesIdentity(window),
        name: `${agentName(window.agent)} ${name}`,
        points: [...window.points, ...failures].sort((left, right) => left.at - right.at),
        firstAt: window.points[0]?.at ?? null
      }
    ]
  })
