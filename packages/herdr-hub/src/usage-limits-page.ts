/**
 * The Usage Limits page as the 06 Usage design draws it: one verdict sentence about the hub, notices for old or
 * unreadable limits, then one card per tool. Built from the hub's own `agent-usage limits` read; other hosts'
 * account limits stay on their machines. agent-usage's own model decides each window's tone and freshness. Pure:
 * the caller supplies the hub's clock and the page time zone.
 *
 * @module
 */
import {
  type Agent,
  agentName,
  type LimitSnapshot,
  summarizeLimits,
  type UnknownReason,
  windowName,
  type WindowSummary
} from "@knpkv/agent-usage/limits"
import type { FleetLimits } from "@knpkv/herdr-connect/usage"

type Tone = "neutral" | "caution" | "critical"

export interface LimitsCard {
  readonly agent: Agent
  readonly name: string
  /** "atlas, read 14:01", "atlas, sign-in required" or "atlas, could not be fetched". */
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
/** Only these reasons mean the account needs a sign-in; any other failure is Unknown with its own cause. */
const signInReasons: ReadonlySet<UnknownReason> = new Set(["NoAuth", "AuthExpired"])

type Status = "unknown" | "stale" | "at-limit" | "near" | "ok"

/** Why a tool cannot be read: a sign-in, or another cause in agent-usage's words. */
type Unreadable = { readonly _tag: "SignIn" } | { readonly _tag: "Cause"; readonly words: string }

interface ToolReading {
  readonly agent: Agent
  readonly name: string
  readonly primary: WindowSummary | undefined
  readonly fiveHour: WindowSummary | undefined
  readonly weekly: WindowSummary | undefined
  readonly unreadable: Unreadable
}

const known = (window: Pick<WindowSummary, "usedPercent"> | undefined): number | null =>
  window === undefined || window.usedPercent === null ? null : Math.round(window.usedPercent)

/**
 * A primary window's status. The tone is agent-usage's: it counts a window projected to run out before its reset
 * as near, whatever share it has used.
 */
export const windowStatus = (
  window: Pick<WindowSummary, "tone" | "freshness" | "usedPercent"> | undefined
): Status => {
  if (window === undefined || known(window) === null || window.tone === "unknown") return "unknown"
  if (window.freshness === "stale") return "stale"
  return window.tone === "at-limit" ? "at-limit" : window.tone === "near" ? "near" : "ok"
}

const status = (tool: ToolReading): Status => windowStatus(tool.primary)

/** "weekly" or "5-hour", as a limit's name inside a sentence. */
const windowWord = (agent: Agent): string => (primaryWindow[agent] === "Weekly" ? "weekly" : "5-hour")

/** Reset times in the page time zone: today, a weekday within the week, "next" for the same weekday a week out. */
const formatter = (timeZone: string, now: number) => {
  const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone })
  const date = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone })
  const dayNumber = (at: number) => {
    const [year, month, day] = date.format(at).split("-").map(Number)
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1) / 86_400_000
  }
  const days = (at: number) => dayNumber(at) - dayNumber(now)
  const dayName = (at: number) =>
    days(at) <= 0 ? "today" : days(at) >= 6 ? `next ${weekday.format(at)}` : weekday.format(at)
  const capital = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}`
  return {
    clock: (at: number) => clock.format(at),
    /** "Today, 16:40", "Wednesday, 07:00", "Next Sunday, 07:00". */
    reset: (at: number) => `${capital(dayName(at))}, ${clock.format(at)}`,
    /** "today at 16:40", "Tuesday at 03:29". */
    resetWords: (at: number) => `${dayName(at)} at ${clock.format(at)}`,
    /** "16:40" today, otherwise with its day: "Tuesday at 03:29". */
    until: (at: number) => (days(at) <= 0 ? clock.format(at) : `${dayName(at)} at ${clock.format(at)}`)
  }
}
type Format = ReturnType<typeof formatter>

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
const level = (tool: ToolReading): string => `${String(known(tool.primary))}% ${windowWord(tool.agent)}`

const card = (tool: ToolReading, host: string, format: Format): LimitsCard => {
  const used = known(tool.primary)
  const readAt = tool.primary?.observedAt ?? null
  const state = status(tool)
  const primaryName = primaryWindow[tool.agent]
  const stale = state === "stale"
  const signIn = tool.unreadable._tag === "SignIn"
  const resetOf = (window: WindowSummary | undefined): string | null =>
    window?.resetsAt === null || window?.resetsAt === undefined || window.usedPercent === null
      ? null
      : format.reset(window.resetsAt)
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
    read: state === "unknown" || readAt === null
      ? `${host}, ${tool.unreadable._tag === "SignIn" ? "sign-in required" : tool.unreadable.words}`
      : `${host}, read ${format.clock(readAt)}`,
    figure: state === "unknown" ? null : used,
    measures: state === "unknown" ? `${primaryName} limit` : `${primaryName} limit used`,
    state: state === "unknown"
      ? signIn
        ? { label: "Sign-in required", tone: "caution" }
        : { label: "Unknown", tone: "neutral" }
      : stale && readAt !== null
      ? { label: `Stale, as of ${format.clock(readAt)}`, tone: "neutral" }
      : state === "at-limit"
      ? { label: "Limit reached", tone: "critical" }
      : state === "near"
      ? { label: "Near limit", tone: "caution" }
      : null,
    track: state === "unknown" || used === null
      ? null
      : {
        value: used,
        stale,
        label: `${tool.name} ${windowWord(tool.agent)} limit`,
        valueText: stale && readAt !== null
          ? `${String(used)}% used as of ${format.clock(readAt)}`
          : `${String(used)}% used`
      },
    details,
    note: state === "unknown"
      ? signIn
        ? `Unknown is not zero. Sign in on ${host}, then read again.`
        : `Unknown is not zero. Read again on ${host}.`
      : state === "at-limit" && primaryReset !== null
      ? `New ${tool.name} work on ${host} waits until ${format.until(primaryReset)}.`
      : state === "near" && used !== null && primaryReset !== null
      ? `${String(100 - used)}% left until ${format.until(primaryReset)}.`
      : null
  }
}

/** "Codex can’t be read until you sign in." or "Codex can’t be read: could not be fetched." */
const unreadableSentence = (tool: ToolReading): string =>
  tool.unreadable._tag === "SignIn"
    ? `${tool.name} can’t be read until you sign in.`
    : `${tool.name} can’t be read: ${tool.unreadable.words}.`

/**
 * One sentence on whether the hub has room. A current full or near limit leads, then old readings, then unreadable
 * tools; stale and unreadable tools keep their own notices whatever leads.
 */
const summary = (tools: ReadonlyArray<ToolReading>, host: string, format: Format): LimitsPage["summary"] => {
  const readable = tools.filter((tool) => status(tool) !== "unknown")
  const unknown = tools.filter((tool) => status(tool) === "unknown")
  const stale = readable.filter((tool) => status(tool) === "stale")
  const full = readable.find((tool) => status(tool) === "at-limit")
  const near = readable.find((tool) => status(tool) === "near")
  const others = (tool: ToolReading) => readable.filter((other) => other !== tool && status(other) === "ok")
  if (full !== undefined) {
    const reset = full.primary?.resetsAt ?? null
    const rest = others(full).map((tool) => `${tool.name} still has room: ${level(tool)}.`)
    return {
      verdict: `${full.name} is at its ${windowWord(full.agent)} limit on ${host}.`,
      note: [
        reset === null
          ? `New ${full.name} work waits for its reset.`
          : `New ${full.name} work waits until ${format.until(reset)}.`,
        ...rest
      ].join(" ")
    }
  }
  if (near !== undefined) {
    const reset = near.primary?.resetsAt ?? null
    const rest = others(near).map((tool) => `${tool.name} has room: ${level(tool)}.`)
    return {
      verdict: `${host} is close to ${near.name}’s ${windowWord(near.agent)} limit.`,
      note: [
        reset === null
          ? `${near.name} is at ${String(known(near.primary))}%.`
          : `${near.name} is at ${String(known(near.primary))}% and resets ${format.resetWords(reset)}.`,
        ...rest
      ].join(" ")
    }
  }
  if (stale.length > 0) {
    const readAt = Math.min(...stale.map((tool) => tool.primary?.observedAt ?? Number.POSITIVE_INFINITY))
    const levels = stale.map((tool, index) => `${tool.name}${index === 0 ? " was" : ""} at ${primaryPhrase(tool)}`)
    return {
      verdict: `${host}’s limits were last read at ${format.clock(readAt)}.`,
      note: `As of then, ${levels.join(" and ")}. Read again before starting more work.`
    }
  }
  if (unknown.length > 0 && readable.length > 0) {
    return {
      verdict: `${readable.map((tool) => tool.name).join(" and ")} ${
        readable.length === 1 ? "has" : "have"
      } room on ${host}; ${unknown.map((tool) => tool.name).join(" and ")} ${
        unknown.length === 1 ? "is" : "are"
      } Unknown.`,
      note: [...readable.map((tool) => `${standing(tool)}.`), ...unknown.map(unreadableSentence)].join(" ")
    }
  }
  if (readable.length === 0) {
    return { verdict: `${host}’s limits are Unknown.`, note: unknown.map(unreadableSentence).join(" ") }
  }
  return { verdict: `${host} has room for more work.`, note: readable.map((tool) => `${standing(tool)}.`).join(" ") }
}

/**
 * Why `agent`'s primary window cannot be read: the window's own Unknown reading, else the failed poll for the whole
 * agent, else nothing reported yet.
 */
const unreadable = (
  agent: Agent,
  latest: ReadonlyArray<LimitSnapshot>,
  primary: WindowSummary | undefined,
  agentProblem: string | undefined
): Unreadable => {
  const own = latest.filter((snapshot) => snapshot.agent === agent)
  const reading = (
    own.find((snapshot) => snapshot.label !== "*" && windowName(snapshot) === primaryWindow[agent]) ??
      own.find((snapshot) => snapshot.label === "*")
  )?.reading
  if (reading?._tag === "Unknown" && signInReasons.has(reading.reason)) return { _tag: "SignIn" }
  return { _tag: "Cause", words: primary?.problem ?? agentProblem ?? "nothing reported yet" }
}

/**
 * The page for `host`'s own read, `sinceLoad` ms after the page received it, or null when that host has no limits
 * reading to show (the page then shows its empty or unavailable state). Every tool gets a card: a tool with nothing
 * readable is Unknown, never left out.
 */
export const limitsPage = (
  fleet: FleetLimits,
  host: string,
  sinceLoad: number,
  timeZone: string
): LimitsPage | null => {
  const own = fleet.hosts.find((entry) => entry.host.toLowerCase() === host.toLowerCase())
  if (own === undefined || own.reading._tag !== "Read") return null
  const latest = own.reading.limits.latest
  if (latest.length === 0) return null
  const now = own.reading.limits.observedAt + Math.max(0, sinceLoad)
  const groups = summarizeLimits(latest, now)
  const tools = agents.map((agent): ToolReading => {
    const group = groups.find((entry) => entry.agent === agent)
    const window = (name: string) => group?.windows.find((entry) => entry.name === name)
    const primary = window(primaryWindow[agent])
    return {
      agent,
      name: agentName(agent),
      primary,
      fiveHour: window("5-hour"),
      weekly: window("Weekly"),
      unreadable: unreadable(agent, latest, primary, group?.problem?.reason)
    }
  })
  const format = formatter(timeZone, now)
  const stale = tools.filter((tool) => status(tool) === "stale")
  const staleAt = stale.length === 0
    ? null
    : Math.min(...stale.map((tool) => tool.primary?.observedAt ?? Number.POSITIVE_INFINITY))
  const unknown = tools.filter((tool) => status(tool) === "unknown")
  const current = tools.filter((tool) => status(tool) !== "unknown" && status(tool) !== "stale")
  const currentWords = current.length === 0
    ? ""
    : ` ${current.map((other) => other.name).join(" and ")} ${current.length === 1 ? "is" : "are"} current.`
  return {
    summary: summary(tools, own.host, format),
    notices: [
      ...(staleAt === null
        ? []
        : [{
          title: `Limits were last read at ${format.clock(staleAt)}.`,
          text: `They show how full each limit was then, not now. Read again on ${own.host}.`
        }]),
      ...unknown.map((tool) =>
        tool.unreadable._tag === "SignIn"
          ? {
            title: `${tool.name} needs a fresh sign-in on ${own.host}.`,
            text: `${tool.name} limits read Unknown until you sign in on ${own.host} and read again.${currentWords}`
          }
          : {
            title: `${tool.name} limits can’t be read on ${own.host}.`,
            text: `${tool.name} reads Unknown until a read succeeds.${currentWords}`
          }
      )
    ],
    cards: tools.map((tool) => card(tool, own.host, format))
  }
}
