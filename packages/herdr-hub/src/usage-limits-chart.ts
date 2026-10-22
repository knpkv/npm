/**
 * The Limits page's token chart as the 06 Usage design draws it: the hub's own tokens per period, each bar labelled
 * with its value, and a text legend with per-tool totals. A tool whose limits cannot be read is left out of every
 * total and named as excluded: Unknown is not zero. Pure: the caller supplies the page time zone.
 *
 * @module
 */
import { type Agent, agentName } from "@knpkv/agent-usage/limits"
import type { FleetUsage } from "@knpkv/herdr-connect/usage"

export interface LimitsChart {
  /** "Tokens on atlas, last 7 days", with ", Claude only" when a tool is excluded. */
  readonly title: string
  /** Every bar in words, for the figure's accessible name. */
  readonly label: string
  readonly bars: ReadonlyArray<{ readonly period: string; readonly value: string; readonly height: number }>
  readonly legend: ReadonlyArray<{ readonly text: string; readonly total: boolean; readonly unknown: boolean }>
}

type UsageRange = Extract<FleetUsage["hosts"][number]["reading"], { readonly _tag: "Read" }>["usage"]["range"]

const rangeWords = { "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" } satisfies Record<
  UsageRange["preset"],
  string
>
const agents: ReadonlyArray<Agent> = ["claude", "codex"]
/** The tallest bar's height in pixels; every bar keeps at least 4px so a quiet period stays visible. */
const tallest = 140
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

const periodLabel = (start: number, range: UsageRange): string =>
  new Intl.DateTimeFormat(
    "en-GB",
    range.bucket === "hour"
      ? { hour: "2-digit", minute: "2-digit", timeZone: range.timeZone }
      : range.bucket === "week"
      ? { day: "numeric", month: "short", timeZone: range.timeZone }
      : { weekday: "short", timeZone: range.timeZone }
  ).format(start)

/** The chart for `host`'s own usage read, without `excluded` tools, or null when that host has no read. */
export const limitsChart = (
  fleet: FleetUsage,
  host: string,
  excluded: ReadonlyArray<Agent>
): LimitsChart | null => {
  const own = fleet.hosts.find((entry) => entry.host.toLowerCase() === host.toLowerCase())
  if (own === undefined || own.reading._tag !== "Read") return null
  const usage = own.reading.usage
  const counted = usage.tokens.filter((cell) => !excluded.includes(cell.agent))
  const perPeriod = usage.periods.map((_, index) =>
    counted.filter((cell) => cell.period === index).reduce((sum, cell) => sum + cell.tokens, 0)
  )
  const max = Math.max(0, ...perPeriod)
  const included = agents.filter((agent) => !excluded.includes(agent))
  const only = excluded.length === 0 ? "" : `, ${included.map(agentName).join(" and ")} only`
  const title = `Tokens on ${own.host}, ${rangeWords[usage.range.preset]}${only}`
  const bars = usage.periods.map((period, index) => ({
    period: periodLabel(period.start, usage.range),
    value: compact.format(perPeriod[index] ?? 0),
    height: max === 0 ? 4 : Math.max(4, Math.round(((perPeriod[index] ?? 0) / max) * tallest))
  }))
  const total = perPeriod.reduce((sum, value) => sum + value, 0)
  const agentTotal = (agent: Agent) =>
    counted.filter((cell) => cell.agent === agent).reduce((sum, cell) => sum + cell.tokens, 0)
  return {
    title,
    label: `${own.host} tokens ${rangeWords[usage.range.preset]}${only}: ${
      bars.map((bar) => `${bar.period} ${bar.value}`).join(", ")
    }`,
    bars,
    legend: [
      ...agents.map((agent) =>
        excluded.includes(agent)
          ? { text: `${agentName(agent)} Unknown, excluded`, total: false, unknown: true }
          : { text: `${agentName(agent)} ${compact.format(agentTotal(agent))}`, total: false, unknown: false }
      ),
      { text: `${compact.format(total)} ${excluded.length === 0 ? "total" : "counted"}`, total: true, unknown: false }
    ]
  }
}
