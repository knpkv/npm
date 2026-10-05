/**
 * A synthetic but realistic week of one person's agent usage, built from facts (15-minute usage
 * groups and limit snapshots) and run through the same report builders the server uses, so every
 * story renders exactly what the API would return. Deterministic: a seeded generator, a fixed "now".
 *
 * Nothing here is copied from a real store. Ticket keys, repos, and titles are invented.
 *
 * @example
 * const week = buildWeek("binding") // Claude 5-hour at 86%, resets in 1h 12m
 */
import { attribute, bookingId } from "../../src/core/Attribution.js"
import type { BalanceReading, LimitSnapshot, TicketTitleValue, Tokens } from "../../src/core/Model.js"
import { buildLimitsReport, buildUsageReport, periodsOf } from "../../src/core/Report.js"
import { BUCKET_MILLIS, type UsageGroup } from "../../src/core/Store.js"
import type { Bucket, LimitsReport, UsageReport } from "../../src/shared/contracts.js"

export const TIME_ZONE = "Europe/Amsterdam"
const MACHINE = "workstation"
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Monday 5 October 2026, 15:30 in Amsterdam (13:30 UTC). */
export const NOW = Date.UTC(2026, 9, 5, 13, 30)
export const WEEK_START = NOW - 7 * DAY

/** What a story wants the page to say. */
export type Scenario =
  /** Claude 5-hour is binding: 86%, resets in 1h 12m, rising fast. */
  | "binding"
  /** Claude 5-hour hit 100% and is waiting for its reset. */
  | "at-limit"
  /** Nothing binds: the highest window is Claude weekly at 31%. */
  | "clear"
  /** No request in the range. */
  | "empty"

const PROJECTS: ReadonlySet<string> = new Set(["RLY", "AU", "CC", "HF"])

interface Work {
  readonly cwd: string
  readonly branch: string
  readonly activeTicket: string | null
  readonly title: string | null
  /** Relative appetite: how heavy a session on this work tends to be. */
  readonly weight: number
}

/** The heaviest work of the week; busy scenarios end on it. */
const PRIMARY: Work = {
  cwd: "/home/dev/code/npm",
  branch: "feat/RLY-142-notice",
  activeTicket: null,
  title: "Promote shared notices into rly",
  weight: 1.6
}

const WORK: ReadonlyArray<Work> = [
  PRIMARY,
  {
    cwd: "/home/dev/code/npm",
    branch: "feat/AU-27-drill",
    activeTicket: null,
    title: "Drill from a limit spike into bookings",
    weight: 1.3
  },
  {
    cwd: "/home/dev/code/npm",
    branch: "fix/CC-310-session",
    activeTicket: null,
    title: "One owner session for loopback apps",
    weight: 1.1
  },
  {
    cwd: "/home/dev/code/fleet",
    branch: "main",
    activeTicket: "HF-88",
    title: "Worker relationship rules",
    weight: 0.9
  },
  { cwd: "/home/dev/code/npm", branch: "feat/RLY-151-theme", activeTicket: null, title: null, weight: 0.7 },
  { cwd: "/home/dev/code/nix", branch: "main", activeTicket: null, title: null, weight: 0.6 },
  { cwd: "/home/dev/code/notes", branch: "main", activeTicket: null, title: null, weight: 0.3 },
  // A typed key whose project is not known: shows up under ignored keys, books to the repo.
  { cwd: "/home/dev/code/scratch", branch: "main", activeTicket: "GPT-6", title: null, weight: 0.2 }
]

/** mulberry32: small, fast, and the same sequence for the same seed. */
const seeded = (seed: number) => {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const localHour = (at: number): number =>
  Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: TIME_ZONE }).format(at))

const localWeekday = (at: number): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: TIME_ZONE }).format(at)

/** One agent session: a contiguous block of work on one thing. */
export interface FixtureSession {
  readonly id: string
  readonly agent: "claude" | "codex"
  readonly bookingId: string
  readonly start: number
  readonly end: number
  readonly requests: number
  readonly tokens: number
}

interface Facts {
  readonly groups: ReadonlyArray<UsageGroup>
  readonly sessions: ReadonlyArray<FixtureSession>
}

const tokensFor = (scale: number, random: () => number, agent: "claude" | "codex"): Tokens => {
  const input = Math.round((agent === "claude" ? 42_000 : 55_000) * scale * (0.6 + random()))
  const output = Math.round(input * (0.25 + random() * 0.2))
  const cacheRead = Math.round(input * (agent === "claude" ? 22 : 9) * (0.7 + random() * 0.6))
  return {
    input,
    output,
    reasoning: agent === "codex" ? Math.round(output * 0.4) : 0,
    cacheRead,
    cacheWrite5m: agent === "claude" ? Math.round(input * 1.4) : 0,
    cacheWrite1h: 0
  }
}

const sumTokens = (tokens: Tokens): number =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h

/** Work-hour sessions over the week; the final afternoon is shaped by the scenario. */
const generateFacts = (scenario: Scenario): Facts => {
  if (scenario === "empty") return { groups: [], sessions: [] }
  const random = seeded(20261005)
  const groups: Array<UsageGroup> = []
  const sessions: Array<FixtureSession> = []
  let cursor = WEEK_START - (WEEK_START % BUCKET_MILLIS)
  let index = 0
  while (cursor < NOW) {
    const hour = localHour(cursor)
    const weekend = ["Sat", "Sun"].includes(localWeekday(cursor))
    const working = weekend ? hour >= 11 && hour < 14 && random() < 0.25 : hour >= 9 && hour < 19
    if (!working) {
      cursor += BUCKET_MILLIS
      continue
    }
    const lastAfternoon = NOW - cursor < 5 * HOUR
    // Busy scenarios end with Claude still working on the heaviest ticket, so its reading is fresh.
    const closing = lastAfternoon && scenario !== "clear" && NOW - cursor < 3 * HOUR
    const work = closing ? PRIMARY : WORK[Math.floor(random() ** 1.6 * WORK.length)] ?? PRIMARY
    const agent: "claude" | "codex" = closing ? "claude" : random() < 0.22 ? "codex" : "claude"
    const length = closing ? NOW - cursor : (2 + Math.floor(random() * 8)) * BUCKET_MILLIS
    // The scenario's story is told by the last five hours: busy for binding/at-limit, idle for clear.
    const intensity = lastAfternoon
      ? scenario === "clear" ? 0.15 : scenario === "at-limit" ? 2.6 : 2.0
      : 1
    const end = Math.min(cursor + length, NOW)
    const id = `${agent}-${String(index).padStart(3, "0")}`
    let requests = 0
    let tokens = 0
    for (let bucket = cursor; bucket < end; bucket += BUCKET_MILLIS) {
      const groupTokens = tokensFor(work.weight * intensity, random, agent)
      const groupRequests = 3 + Math.floor(random() * 12 * intensity)
      groups.push({
        bucketStart: bucket,
        agent,
        model: agent === "codex" ? "gpt-5.3-codex" : random() < 0.08 ? "claude-sonnet-5" : "claude-opus-5-5",
        fast: false,
        longPrompt: false,
        attribution: { cwd: work.cwd, branch: work.branch, activeTicket: work.activeTicket },
        requests: groupRequests,
        tokens: groupTokens
      })
      requests += groupRequests
      tokens += sumTokens(groupTokens)
    }
    sessions.push({
      id,
      agent,
      bookingId: bookingId(
        attribute({ cwd: work.cwd, branch: work.branch, activeTicket: work.activeTicket }, PROJECTS).booking
      ),
      start: cursor,
      end,
      requests,
      tokens
    })
    index += 1
    // A short break between sessions.
    cursor = end + BUCKET_MILLIS * Math.floor(random() * 4)
  }
  return { groups, sessions }
}

/** Ticket titles by key, as the server's lookup would return them. */
const titlesOf = () =>
  Object.fromEntries(
    WORK.flatMap((work) => {
      const { booking } = attribute({ cwd: work.cwd, branch: work.branch, activeTicket: work.activeTicket }, PROJECTS)
      if (booking._tag !== "Ticket") return []
      const title = work.title === null
        ? ({ _tag: "Unknown", reason: "NotFound" } satisfies TicketTitleValue)
        : ({ _tag: "Known", summary: work.title } satisfies TicketTitleValue)
      return [[booking.key, title]] satisfies ReadonlyArray<readonly [string, TicketTitleValue]>
    })
  )

const snapshot = (
  agent: "claude" | "codex",
  label: string,
  windowMinutes: number | null,
  observedAt: number,
  reading: LimitSnapshot["reading"]
): LimitSnapshot => ({
  agent,
  machine: MACHINE,
  source: agent === "claude" ? "claude-statusline" : "codex-rollout",
  label,
  windowMinutes,
  observedAt,
  reading
})

/**
 * Limit snapshots derived from the usage: a window opens at the first request after the previous
 * reset, fills in proportion to that agent's tokens, and is read while the agent is in use.
 */
const generateSnapshots = (facts: Facts, scenario: Scenario): ReadonlyArray<LimitSnapshot> => {
  if (scenario === "empty") return []
  const snapshots: Array<LimitSnapshot> = []
  // Each window's final reading at NOW, per scenario; the budget is calibrated to land on it.
  const target = {
    binding: { claude5h: 86, claudeWeek: 64, codex5h: 22, codexWeek: 18 },
    "at-limit": { claude5h: 118, claudeWeek: 71, codex5h: 22, codexWeek: 18 },
    clear: { claude5h: 12, claudeWeek: 31, codex5h: 6, codexWeek: 9 }
  }[scenario]
  // The weekly windows opened last Wednesday and reset this Wednesday morning.
  const weekStart = NOW - 4 * DAY - 22 * HOUR
  const windows: ReadonlyArray<{
    readonly agent: "claude" | "codex"
    readonly label: string
    readonly minutes: number
    readonly target: number
  }> = [
    { agent: "claude", label: "five_hour", minutes: 300, target: target.claude5h },
    { agent: "claude", label: "seven_day", minutes: 10_080, target: target.claudeWeek },
    { agent: "codex", label: "primary", minutes: 300, target: target.codex5h },
    { agent: "codex", label: "secondary", minutes: 10_080, target: target.codexWeek }
  ]
  for (const window of windows) {
    const length = window.minutes * MINUTE
    const ordered = facts.groups.filter((group) => group.agent === window.agent)
    const openAt = (bucketStart: number, previous: number | null): number =>
      window.minutes === 10_080
        ? weekStart + Math.floor((bucketStart - weekStart) / length) * length
        : previous !== null && bucketStart < previous + length
        ? previous
        : bucketStart
    // Calibrate: the tokens in the window that is open at NOW map to the scenario's percentage.
    let openStart: number | null = null
    let openTokens = 0
    for (const group of ordered) {
      const start = openAt(group.bucketStart, openStart)
      if (start !== openStart) openTokens = 0
      openStart = start
      openTokens += sumTokens(group.tokens)
    }
    const budget = Math.max(1, (openTokens / window.target) * 100)
    let windowStart: number | null = null
    let used = 0
    for (const group of ordered) {
      const start = openAt(group.bucketStart, windowStart)
      if (start !== windowStart) {
        windowStart = start
        used = 0
      }
      used += sumTokens(group.tokens)
      const usedPercent = Math.min(100, Math.round((used / budget) * 1000) / 10)
      snapshots.push(
        snapshot(window.agent, window.label, window.minutes, group.bucketStart + 7 * MINUTE, {
          _tag: "Known",
          usedPercent,
          resetsAt: windowStart + length
        })
      )
    }
  }
  // One failed Claude poll on Thursday afternoon: every Claude window is unknown until the next read.
  snapshots.push(
    snapshot("claude", "*", null, WEEK_START + 3 * DAY + 4 * HOUR, {
      _tag: "Unknown",
      reason: "Fetch",
      detail: "HTTP 503"
    })
  )
  return snapshots
}

const balances = (scenario: Scenario): ReadonlyArray<BalanceReading> =>
  scenario === "empty" ? [] : [
    {
      kind: "codex-credits",
      machine: MACHINE,
      observedAt: NOW - 40 * MINUTE,
      value: { _tag: "Known", balance: { _tag: "Credits", credits: 412 } }
    },
    {
      kind: "claude-extra-usage",
      machine: MACHINE,
      observedAt: NOW - 12 * MINUTE,
      value: {
        _tag: "Known",
        balance: { _tag: "Amount", leftMinor: 1_250, limitMinor: 5_000, decimals: 2, currency: "EUR" }
      }
    }
  ]

export interface Week {
  readonly now: number
  readonly range: { readonly from: number; readonly to: number }
  readonly usage: UsageReport
  readonly limits: LimitsReport
  readonly sessions: ReadonlyArray<FixtureSession>
}

/** The week as the API would report it, bucketed by hour (24h-style views) or day. */
export const buildWeek = (scenario: Scenario, bucket: Bucket = "hour"): Week => {
  const facts = generateFacts(scenario)
  const range = { from: WEEK_START, to: NOW }
  const periods = periodsOf({ ...range, timeZone: TIME_ZONE, bucket })
  return {
    now: NOW,
    range,
    usage: buildUsageReport(facts.groups, periods, titlesOf(), PROJECTS, NOW),
    limits: { ...buildLimitsReport(generateSnapshots(facts, scenario), range), balances: balances(scenario) },
    sessions: facts.sessions
  }
}
