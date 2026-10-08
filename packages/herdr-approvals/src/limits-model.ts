/**
 * What the hub says about Claude and Codex subscription limits, from every host's
 * `agent-limits` read. Limits belong to an account, not a host, so the hosts' reads are merged
 * per account and window, and the freshest reading wins; the window names the host it was read on.
 * A window nobody could read stays unknown, with the reason in words, and never becomes 0%.
 *
 * Every time in a read is on the reading host's clock, so the model never compares one with this
 * page's clock or with another host's. Ages and countdowns are measured against the CLI's own `now`,
 * plus the time since this page received the read: neither clock skew moves them.
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
  /** "resets in 3d 4h", or why there is no reading ("No reading for 6h"); null when the source says it. */
  readonly detailText: string | null
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
  /**
   * The host that read it, when the CLI names no account: two hosts may hold different
   * subscriptions, so their unnamed reads stay apart.
   */
  readonly host: string | null
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
  /** The CLI's `now` for this read, on the same host clock as every time in `state`. */
  readonly readNow: number
}

/** How old the reading was when the CLI ran; unknown readings may not say. */
const ageAtRead = (candidate: Candidate): number => candidate.state.ageMs ?? Number.POSITIVE_INFINITY

/** A Known reading beats an unknown one; between two of a kind, the younger reading wins. */
const fresher = (left: Candidate, right: Candidate): Candidate => {
  const leftKnown = left.state._tag === "Known"
  const rightKnown = right.state._tag === "Known"
  if (leftKnown !== rightKnown) return leftKnown ? left : right
  return ageAtRead(right) < ageAtRead(left) ? right : left
}

const percentText = (used: number): string => `${String(Math.round(used))}%`

const toneRank = { "at-limit": 3, near: 2, unknown: 1, ok: 0 } satisfies Record<LimitTone, number>

const windowView = (
  candidate: Candidate,
  clock: LimitsClock,
  formatTime: (millis: number) => string
): LimitWindowView => {
  const { host, provider, readNow, state, window } = candidate
  // A host time `at` is this far ahead of now, measured on the host's own clock.
  const fromNow = (at: number): number => at - readNow - clock.sinceLoad
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
      sourceText: state.ageMs === undefined ? null : `last read on ${host}, ${ago(state.ageMs + clock.sinceLoad)}`
    }
  }
  const age = state.ageMs + clock.sinceLoad
  const sourceText = `read on ${host}, ${ago(age)}`
  const used = state.usedPercent
  if (age > maxAge(window)) {
    return {
      ...base,
      tone: "unknown",
      value: used,
      stale: true,
      projected: null,
      usedText: `${percentText(used)} used, old reading`,
      // The source line already says how old it is.
      detailText: null,
      paceText: null,
      sourceText
    }
  }
  const projected = state.burnPerHour._tag === "Known" && state.resetsAt !== null
    ? used + (state.burnPerHour.value * Math.max(0, fromNow(state.resetsAt))) / HOUR
    : null
  const exhausts = state.exhaustsAt
  const runsOutBeforeReset = exhausts._tag === "Known" && exhausts.value !== "NotBeforeReset"
  const paceText = used >= reserveMark
    ? "inside the reserve"
    : exhausts._tag === "Unknown"
    ? null
    : exhausts.value === "NotBeforeReset"
    ? "lasts until reset"
    : `reaches the reserve ${formatTime(clock.now + fromNow(exhausts.value))}`
  return {
    ...base,
    tone: used >= 100 ? "at-limit" : used >= reserveMark || runsOutBeforeReset ? "near" : "ok",
    value: used,
    stale: false,
    projected,
    usedText: `${percentText(used)} used`,
    detailText: state.resetsAt === null
      ? "reset time unknown"
      : fromNow(state.resetsAt) <= 0
      ? "reset"
      : `resets in ${duration(fromNow(state.resetsAt))}`,
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
 * The page's side of time: how long ago it received the reads, and its own clock, used only to
 * print an absolute moment. Both are this page's clock, so their difference is skew-free.
 */
export interface LimitsClock {
  readonly sinceLoad: number
  readonly now: number
}

/**
 * Merges every host's read into one view per account. `formatTime` renders an absolute moment
 * ("Thu 18:30") on the page's clock; the caller owns the locale and time zone.
 */
export const limitsView = (
  fleet: FleetLimits,
  clock: LimitsClock,
  formatTime: (millis: number) => string
): LimitsView => {
  const accounts = new Map<
    string,
    {
      readonly provider: LimitProviderId
      readonly account: string | null
      readonly host: string | null
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
      const key = account === null ? `${provider}:host:${host.host}` : `${provider}:account:${account.id}`
      const entry = accounts.get(key) ?? {
        provider,
        account: account?.label ?? null,
        host: account === null ? host.host : null,
        windows: new Map()
      }
      accounts.set(key, entry)
      for (const { state, window } of report.windows) {
        if (state._tag === "NotReported") continue
        const candidate: Candidate = {
          host: host.host,
          provider: report,
          readNow: host.reading.limits.now,
          state,
          window
        }
        const current = entry.windows.get(windowKey(window))
        entry.windows.set(windowKey(window), current === undefined ? candidate : fresher(current, candidate))
      }
    }
  }
  for (const failure of fleet.failures) notes.push(`No reading from ${failure.host} (${failureWords[failure.reason]})`)
  if (!fleet.peersListed) notes.push("Other machines unknown: the hub couldn't list the fleet")
  const views = [...accounts.entries()]
    .map(([key, entry]): LimitAccountView => {
      const windows = [...entry.windows.values()]
        .sort((left, right) => windowOrder(left.window) - windowOrder(right.window))
        .map((candidate) => windowView(candidate, clock, formatTime))
      return {
        key,
        provider: entry.provider,
        name: providerNames[entry.provider],
        account: entry.account,
        host: entry.host,
        windows,
        headline: headlineWindow(windows)
      }
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        (left.account ?? left.host ?? "").localeCompare(right.account ?? right.host ?? "")
    )
  return { accounts: views, notes }
}
