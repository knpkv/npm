/**
 * What the hub says about Claude and Codex subscription limits, from every host's
 * `agent-limits` read. Limits belong to an account, not a host, so the hosts' reads are merged
 * per account and window, and the freshest reading wins; the window names the host it was read on.
 * A window nobody could read stays unknown, with the reason in words, and never becomes 0%.
 *
 * @module
 */
import type { FleetLimits, HostLimits, LimitProvider, LimitWindowId, LimitWindowState } from "./limits-schema.js"

/** The limits vocabulary agent-usage already uses, so the fleet says it one way. */
export type LimitTone = "ok" | "near" | "at-limit" | "unknown"

export const limitToneLabel = {
  ok: "OK",
  near: "Near limit",
  "at-limit": "At limit",
  unknown: "Unknown"
} satisfies Record<LimitTone, string>

export interface LimitWindowView {
  readonly key: string
  /** "5-hour", "Weekly". */
  readonly name: string
  readonly tone: LimitTone
  /** Percent used when a reading exists, old ones included; null when there is none. */
  readonly value: number | null
  /** The reading is older than the CLI trusts: it says how full the window was. */
  readonly stale: boolean
  /** Where the window stands at its reset at the current pace, when both are known. */
  readonly projected: number | null
  /** The reserve the fleet keeps back: past this mark, dispatch avoids the provider. */
  readonly reserveMark: number
  /** "47% used", "47% used, old reading", or "Unknown". */
  readonly usedText: string
  /** "resets in 3d 4h", or why there is no reading ("No reading for 6h"). */
  readonly detailText: string
  /** "lasts until reset", "reaches the reserve Thu 18:30", or null when the pace is unknown. */
  readonly paceText: string | null
  /** "read on SER8, 2m ago"; null when no host has read it. */
  readonly sourceText: string | null
}

export type LimitProviderId = "claude" | "codex"

export interface LimitAccountView {
  readonly key: string
  readonly provider: LimitProviderId
  /** "Claude" or "Codex". */
  readonly name: string
  /** The account's label (an email) when a host reports it. */
  readonly account: string | null
  readonly windows: ReadonlyArray<LimitWindowView>
  /** The window to show when there is room for one: the closest to its limit. */
  readonly headline: LimitWindowView | null
}

export interface LimitsView {
  readonly accounts: ReadonlyArray<LimitAccountView>
  /** Hosts that gave no reading, in words. */
  readonly notes: ReadonlyArray<string>
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long agent-limits trusts a reading; past it, the hub calls the reading old as well. */
const maxAge = (window: LimitWindowId): number => (window === "weekly" ? HOUR : HOUR / 4)

/** Claude first: the order the masthead and the panel list providers in. */
export const limitProviders: ReadonlyArray<LimitProviderId> = ["claude", "codex"]

const providerNames = { claude: "Claude", codex: "Codex" } satisfies Record<LimitProviderId, string>

export const windowKey = (window: LimitWindowId): string =>
  window === "five_hour" || window === "weekly" ? window : `other:${String(window.other)}`

const windowName = (window: LimitWindowId): string =>
  window === "five_hour"
    ? "5-hour"
    : window === "weekly"
    ? "Weekly"
    : window.other % 1_440 === 0
    ? `${String(window.other / 1_440)}-day`
    : `${String(Math.round(window.other / 60))}-hour`

const windowOrder = (window: LimitWindowId): number =>
  window === "five_hour" ? 0 : window === "weekly" ? 1 : 2 + window.other

/** "3d 4h", "2h 5m", "7m": the two largest units, never "0m". */
export const duration = (millis: number): string => {
  const span = Math.max(0, millis)
  if (span >= DAY) return `${String(Math.floor(span / DAY))}d ${String(Math.floor((span % DAY) / HOUR))}h`
  if (span >= HOUR) return `${String(Math.floor(span / HOUR))}h ${String(Math.floor((span % HOUR) / MINUTE))}m`
  return `${String(Math.max(1, Math.round(span / MINUTE)))}m`
}

const ago = (millis: number): string => (millis < MINUTE ? "just now" : `${duration(millis)} ago`)

const unknownReason = (reason: string, ageMs: number | undefined): string => {
  switch (reason) {
    case "Stale":
      return ageMs === undefined ? "No recent reading" : `No reading for ${duration(ageMs)}`
    case "Missing":
      return "No reading yet"
    case "TooFewSamples":
      return "Not enough readings yet"
    case "NoReset":
      return "No reset time reported"
    case "Malformed":
      return "Readings disagree; waiting for a fresh one"
    case "Unreadable":
      return "Couldn't read the usage files"
    default:
      return `No reading (${reason})`
  }
}

const unavailableNote = (host: string, reading: Extract<HostLimits["reading"], { _tag: "Unavailable" }>) => {
  switch (reading.reason) {
    case "not_configured":
      return `Limits are off on ${host}`
    case "failed":
      return `agent-limits failed on ${host}`
    case "timeout":
      return `agent-limits didn't answer on ${host}`
    case "unsupported_version":
      return `agent-limits on ${host} is newer than this hub`
    case "invalid_output":
      return `agent-limits printed something unexpected on ${host}`
  }
}

const failureWords = {
  offline: "offline",
  unavailable: "no tailnet address",
  timeout: "no answer",
  request_failed: "request failed",
  invalid_response: "unexpected answer"
} satisfies Record<FleetLimits["failures"][number]["reason"], string>

interface Candidate {
  readonly host: string
  readonly provider: LimitProvider
  readonly window: LimitWindowId
  readonly state: Exclude<LimitWindowState, { readonly _tag: "NotReported" }>
}

const observedAt = (candidate: Candidate): number => candidate.state.observedAt ?? Number.NEGATIVE_INFINITY

/** A Known reading beats an unknown one; between two of a kind, the later observation wins. */
const fresher = (left: Candidate, right: Candidate): Candidate => {
  const leftKnown = left.state._tag === "Known"
  const rightKnown = right.state._tag === "Known"
  if (leftKnown !== rightKnown) return leftKnown ? left : right
  return observedAt(right) > observedAt(left) ? right : left
}

const toneRank = { "at-limit": 3, near: 2, unknown: 1, ok: 0 } satisfies Record<LimitTone, number>

const windowView = (
  candidate: Candidate,
  now: number,
  formatTime: (millis: number) => string
): LimitWindowView => {
  const { host, provider, state, window } = candidate
  const reserveMark = 100 - provider.reservePp
  const base = { key: windowKey(window), name: windowName(window), reserveMark }
  if (state._tag === "Unknown") {
    return {
      ...base,
      tone: "unknown",
      value: null,
      stale: false,
      projected: null,
      usedText: "Unknown",
      detailText: unknownReason(state.reason, state.ageMs),
      paceText: null,
      sourceText: state.observedAt === undefined ? null : `last read on ${host}, ${ago(now - state.observedAt)}`
    }
  }
  const age = now - state.observedAt
  const sourceText = `read on ${host}, ${ago(age)}`
  const used = state.usedPercent
  if (age > maxAge(window)) {
    return {
      ...base,
      tone: "unknown",
      value: used,
      stale: true,
      projected: null,
      usedText: `${String(used)}% used, old reading`,
      detailText: `No reading for ${duration(age)}`,
      paceText: null,
      sourceText
    }
  }
  const projected = state.burnPerHour._tag === "Known" && state.resetsAt !== null
    ? used + (state.burnPerHour.value * Math.max(0, state.resetsAt - now)) / HOUR
    : null
  const exhausts = state.exhaustsAt
  const runsOutBeforeReset = exhausts._tag === "Known" && exhausts.value !== "NotBeforeReset"
  const paceText = used >= reserveMark
    ? "inside the reserve"
    : exhausts._tag === "Unknown"
    ? null
    : exhausts.value === "NotBeforeReset"
    ? "lasts until reset"
    : `reaches the reserve ${formatTime(exhausts.value)}`
  return {
    ...base,
    tone: used >= 100 ? "at-limit" : used >= reserveMark || runsOutBeforeReset ? "near" : "ok",
    value: used,
    stale: false,
    projected,
    usedText: `${String(used)}% used`,
    detailText: state.resetsAt === null
      ? "reset time unknown"
      : state.resetsAt <= now
      ? "reset"
      : `resets in ${duration(state.resetsAt - now)}`,
    paceText,
    sourceText
  }
}

/** The window closest to its limit; between equal tones, the fuller one. */
export const headlineWindow = (windows: ReadonlyArray<LimitWindowView>): LimitWindowView | null =>
  windows.reduce<LimitWindowView | null>((worst, window) => {
    if (worst === null) return window
    const byTone = toneRank[window.tone] - toneRank[worst.tone]
    if (byTone !== 0) return byTone > 0 ? window : worst
    return (window.value ?? -1) > (worst.value ?? -1) ? window : worst
  }, null)

/**
 * Merges every host's read into one view per account. `formatTime` renders an absolute moment
 * ("Thu 18:30"); the caller owns the locale and time zone.
 */
export const limitsView = (
  fleet: FleetLimits,
  now: number,
  formatTime: (millis: number) => string
): LimitsView => {
  const accounts = new Map<
    string,
    {
      readonly provider: LimitProviderId
      readonly account: string | null
      readonly windows: Map<string, Candidate>
    }
  >()
  const notes: Array<string> = []
  for (const host of fleet.hosts) {
    if (host.reading._tag === "Unavailable") {
      notes.push(unavailableNote(host.host, host.reading))
      continue
    }
    for (const provider of limitProviders) {
      const report = host.reading.limits.providers[provider]
      const account = report.account?._tag === "Known" ? report.account : null
      const key = `${provider}:${account === null ? "" : account.id}`
      const entry = accounts.get(key) ?? { provider, account: account?.label ?? null, windows: new Map() }
      accounts.set(key, entry)
      for (const { state, window } of report.windows) {
        if (state._tag === "NotReported") continue
        const candidate: Candidate = { host: host.host, provider: report, state, window }
        const current = entry.windows.get(windowKey(window))
        entry.windows.set(windowKey(window), current === undefined ? candidate : fresher(current, candidate))
      }
    }
  }
  for (const failure of fleet.failures) notes.push(`No reading from ${failure.host} (${failureWords[failure.reason]})`)
  const views = [...accounts.entries()]
    .map(([key, entry]): LimitAccountView => {
      const windows = [...entry.windows.values()]
        .sort((left, right) => windowOrder(left.window) - windowOrder(right.window))
        .map((candidate) => windowView(candidate, now, formatTime))
      return {
        key,
        provider: entry.provider,
        name: providerNames[entry.provider],
        account: entry.account,
        windows,
        headline: headlineWindow(windows)
      }
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || (left.account ?? "").localeCompare(right.account ?? "")
    )
  return { accounts: views, notes }
}
