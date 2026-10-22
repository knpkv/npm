/**
 * The Usage Limits page as the 06 Usage design draws it: one verdict sentence about the hub, notices for old or
 * unreadable limits, then one card per tool. Built from the hub's own `agent-usage limits` read; other hosts'
 * account limits stay on their machines. Pure: the caller supplies the hub's clock and the page time zone.
 *
 * @module
 */
import { type Agent, agentName, NEAR_PERCENT, summarizeLimits, type WindowSummary } from "@knpkv/agent-usage/limits"
import type { FleetLimits } from "@knpkv/herdr-connect/usage"

type Tone = "neutral" | "caution" | "critical"

export interface LimitsCard {
  readonly agent: Agent
  readonly name: string
  /** "atlas, read 14:01", or "atlas, sign-in required". */
  readonly read: string
  /** Share of the tool's primary window, or null when it cannot be read. */
  readonly figure: number | null
  /** What the figure measures: "5-hour limit used". */
  readonly measures: string
  readonly state: { readonly label: string; readonly tone: Tone } | null
  readonly track: {
    readonly value: number
    readonly stale: boolean
    readonly label: string
    readonly valueText: string
  } | null
  /** Term and value; a null value reads "Unknown". */
  readonly details: ReadonlyArray<readonly [string, string | null]>
  readonly note: string | null
}

export interface LimitsPage {
  readonly summary: { readonly verdict: string; readonly note: string }
  readonly notices: ReadonlyArray<{ readonly title: string; readonly text: string }>
  readonly cards: ReadonlyArray<LimitsCard>
}

/** Claude is limited by its 5-hour window first, Codex by its weekly one. */
const primaryWindow = { claude: "5-hour", codex: "Weekly" } satisfies Record<Agent, "5-hour" | "Weekly">
const agents: ReadonlyArray<Agent> = ["claude", "codex"]

interface ToolReading {
  readonly agent: Agent
  readonly name: string
  readonly primary: WindowSummary | undefined
  readonly fiveHour: WindowSummary | undefined
  readonly weekly: WindowSummary | undefined
}

const known = (window: WindowSummary | undefined): number | null =>
  window === undefined || window.usedPercent === null ? null : Math.round(window.usedPercent)

const status = (tool: ToolReading): "unknown" | "stale" | "at-limit" | "near" | "ok" => {
  const used = known(tool.primary)
  if (used === null) return "unknown"
  if (tool.primary?.freshness === "stale") return "stale"
  if (used >= 100) return "at-limit"
  return used >= NEAR_PERCENT ? "near" : "ok"
}

/** "Today, 16:40" on the reset's own day in the page time zone, otherwise "Wednesday, 07:00". */
const formatter = (timeZone: string) => {
  const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone })
  const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone })
  return {
    clock: (at: number) => clock.format(at),
    reset: (at: number, now: number) =>
      `${day.format(at) === day.format(now) ? "Today" : weekday.format(at)}, ${clock.format(at)}`,
    resetWords: (at: number, now: number) =>
      `${day.format(at) === day.format(now) ? "today" : weekday.format(at)} at ${clock.format(at)}`
  }
}

/** "72% of its 5-hour limit" for a 5-hour primary, "31% weekly" for a weekly one. */
const primaryPhrase = (tool: ToolReading): string =>
  primaryWindow[tool.agent] === "Weekly"
    ? `${String(known(tool.primary))}% weekly`
    : `${String(known(tool.primary))}% of its 5-hour limit`

/** "Claude is at 72% of its 5-hour limit and 48% weekly", "Codex is at 31% weekly". */
const standing = (tool: ToolReading): string => {
  const weekly = known(tool.weekly)
  return primaryWindow[tool.agent] === "Weekly" || weekly === null
    ? `${tool.name} is at ${primaryPhrase(tool)}`
    : `${tool.name} is at ${primaryPhrase(tool)} and ${String(weekly)}% weekly`
}

/** "31% weekly", "72% 5-hour": a tool's primary level in passing. */
const level = (tool: ToolReading): string =>
  `${String(known(tool.primary))}% ${primaryWindow[tool.agent].toLowerCase()}`

const card = (tool: ToolReading, host: string, now: number, format: ReturnType<typeof formatter>): LimitsCard => {
  const used = known(tool.primary)
  const readAt = tool.primary?.observedAt ?? null
  const state = status(tool)
  const primaryName = primaryWindow[tool.agent]
  const stale = state === "stale"
  const resetOf = (window: WindowSummary | undefined): string | null =>
    window?.resetsAt === null || window?.resetsAt === undefined || window.usedPercent === null
      ? null
      : format.reset(window.resetsAt, now)
  const usedText = (window: WindowSummary | undefined): string | null => {
    const share = known(window)
    return share === null ? null : `${String(share)}% used`
  }
  const details: ReadonlyArray<readonly [string, string | null]> = primaryName === "5-hour"
    ? [
      ["5-hour reset", resetOf(tool.fiveHour)],
      ["Weekly limit", usedText(tool.weekly)],
      ["Weekly reset", resetOf(tool.weekly)]
    ]
    : [
      ["5-hour limit", usedText(tool.fiveHour)],
      ["5-hour reset", resetOf(tool.fiveHour)],
      ["Weekly reset", resetOf(tool.weekly)]
    ]
  const primaryReset = tool.primary?.resetsAt ?? null
  return {
    agent: tool.agent,
    name: tool.name,
    read: used === null || readAt === null ? `${host}, sign-in required` : `${host}, read ${format.clock(readAt)}`,
    figure: used,
    measures: used === null ? `${primaryName} limit` : `${primaryName} limit used`,
    state: state === "unknown"
      ? { label: "Sign-in required", tone: "caution" }
      : stale && readAt !== null
      ? { label: `Stale, as of ${format.clock(readAt)}`, tone: "neutral" }
      : state === "at-limit"
      ? { label: "Limit reached", tone: "critical" }
      : state === "near"
      ? { label: "Near limit", tone: "caution" }
      : null,
    track: used === null
      ? null
      : {
        value: used,
        stale,
        label: `${tool.name} ${primaryName === "Weekly" ? "weekly" : "5-hour"} limit`,
        valueText: stale && readAt !== null
          ? `${String(used)}% used as of ${format.clock(readAt)}`
          : `${String(used)}% used`
      },
    details,
    note: state === "unknown"
      ? `Unknown is not zero. Sign in on ${host}, then read again.`
      : state === "at-limit" && primaryReset !== null
      ? `New ${tool.name} work on ${host} waits until ${format.clock(primaryReset)}.`
      : state === "near" && used !== null && primaryReset !== null
      ? `${String(100 - used)}% left until ${format.clock(primaryReset)}.`
      : null
  }
}

const summary = (
  tools: ReadonlyArray<ToolReading>,
  host: string,
  now: number,
  format: ReturnType<typeof formatter>
): LimitsPage["summary"] => {
  const readable = tools.filter((tool) => status(tool) !== "unknown")
  const unknown = tools.filter((tool) => status(tool) === "unknown")
  const stale = readable.filter((tool) => status(tool) === "stale")
  const full = readable.find((tool) => status(tool) === "at-limit")
  const near = readable.find((tool) => status(tool) === "near")
  const others = (tool: ToolReading) => readable.filter((other) => other !== tool && status(other) === "ok")
  if (stale.length > 0) {
    const readAt = Math.min(...stale.map((tool) => tool.primary?.observedAt ?? now))
    const levels = stale.map((tool, index) => `${tool.name}${index === 0 ? " was" : ""} at ${primaryPhrase(tool)}`)
    return {
      verdict: `${host}’s limits were last read at ${format.clock(readAt)}.`,
      note: `As of then, ${levels.join(" and ")}. Read again before starting more work.`
    }
  }
  if (full !== undefined) {
    const reset = full.primary?.resetsAt ?? null
    const rest = others(full).map((tool) => `${tool.name} still has room: ${level(tool)}.`)
    return {
      verdict: `${full.name} is at its ${primaryWindow[full.agent]} limit on ${host}.`,
      note: [
        reset === null
          ? `New ${full.name} work waits for its reset.`
          : `New ${full.name} work waits until ${format.clock(reset)}.`,
        ...rest
      ].join(" ")
    }
  }
  if (near !== undefined) {
    const reset = near.primary?.resetsAt ?? null
    const rest = others(near).map((tool) => `${tool.name} has room: ${level(tool)}.`)
    return {
      verdict: `${host} is close to ${near.name}’s ${primaryWindow[near.agent]} limit.`,
      note: [
        reset === null
          ? `${near.name} is at ${String(known(near.primary))}%.`
          : `${near.name} is at ${String(known(near.primary))}% and resets ${format.resetWords(reset, now)}.`,
        ...rest
      ].join(" ")
    }
  }
  if (unknown.length > 0 && readable.length > 0) {
    return {
      verdict: `${readable.map((tool) => tool.name).join(" and ")} ${
        readable.length === 1 ? "has" : "have"
      } room on ${host}; ${unknown.map((tool) => tool.name).join(" and ")} ${
        unknown.length === 1 ? "is" : "are"
      } Unknown.`,
      note: [
        ...readable.map((tool) => `${standing(tool)}.`),
        ...unknown.map((tool) => `${tool.name} can’t be read until you sign in.`)
      ].join(" ")
    }
  }
  if (readable.length === 0) {
    return {
      verdict: `${host}’s limits are Unknown.`,
      note: "Unknown is not zero. Sign in, then read again."
    }
  }
  return { verdict: `${host} has room for more work.`, note: readable.map((tool) => `${standing(tool)}.`).join(" ") }
}

/**
 * The page for `host`'s own read, `sinceLoad` ms after the page received it, or null when that host has no limits
 * reading to show (the page then shows its empty or unavailable state).
 */
export const limitsPage = (
  fleet: FleetLimits,
  host: string,
  sinceLoad: number,
  timeZone: string
): LimitsPage | null => {
  const own = fleet.hosts.find((entry) => entry.host.toLowerCase() === host.toLowerCase())
  if (own === undefined || own.reading._tag !== "Read") return null
  const now = own.reading.limits.observedAt + Math.max(0, sinceLoad)
  const groups = summarizeLimits(own.reading.limits.latest, now)
  const tools = agents.flatMap((agent): ReadonlyArray<ToolReading> => {
    const group = groups.find((entry) => entry.agent === agent)
    if (group === undefined) return []
    const window = (name: string) => group.windows.find((entry) => entry.name === name)
    return [
      {
        agent,
        name: agentName(agent),
        primary: window(primaryWindow[agent]),
        fiveHour: window("5-hour"),
        weekly: window("Weekly")
      }
    ]
  })
  if (tools.length === 0) return null
  const format = formatter(timeZone)
  const stale = tools.filter((tool) => status(tool) === "stale")
  const staleAt = stale.length === 0 ? null : Math.min(...stale.map((tool) => tool.primary?.observedAt ?? now))
  const signIn = tools.filter((tool) => status(tool) === "unknown")
  const current = tools.filter((tool) => status(tool) !== "unknown" && status(tool) !== "stale")
  return {
    summary: summary(tools, own.host, now, format),
    notices: [
      ...(staleAt === null
        ? []
        : [
          {
            title: `Limits were last read at ${format.clock(staleAt)}.`,
            text: `They show how full each limit was then, not now. Read again on ${own.host}.`
          }
        ]),
      ...signIn.map((tool) => ({
        title: `${tool.name} needs a fresh sign-in on ${own.host}.`,
        text: `${tool.name} limits read Unknown until you sign in on ${own.host} and read again.${
          current.length === 0
            ? ""
            : ` ${current.map((other) => other.name).join(" and ")} ${current.length === 1 ? "is" : "are"} current.`
        }`
      }))
    ],
    cards: tools.map((tool) => card(tool, own.host, now, format))
  }
}
