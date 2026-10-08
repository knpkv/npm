/**
 * What Connect says about Claude and Codex limits, from the fleet's `agent-usage limits` reads:
 * one line ("Claude 48% weekly, Codex unknown") naming each agent's window closest to its limit,
 * and each host's own cards behind it.
 *
 * **Mental model**
 *
 * - **Every time stays on its host's clock.** A read carries `observedAt` on the reading host's
 *   clock, and so does every snapshot in it. A host's "now" is that `observedAt` plus the time since
 *   this page received the read, so neither this browser's clock nor another host's moves an age.
 * - **No account means no merging.** agent-usage does not yet say which subscription a host reads,
 *   so each host's windows stay its own; the line still names each agent once, by the window
 *   closest to its limit on any host.
 * - **Old is not current.** A window agent-usage marks stale reads as "unknown" on the line; its
 *   card still shows the old level, hatched, with its age.
 *
 * @module
 */
import {
  type Agent,
  agentName,
  type LimitSnapshot,
  type LimitTone,
  summarizeLimits,
  type WindowSummary
} from "@knpkv/agent-usage/limits"
import type { FleetLimits, HostLimits } from "./limits.js"

export interface HostLimitsView {
  readonly host: string
  /** This host's "now", on its own clock: its read time plus the time since the page got it. */
  readonly now: number
  readonly latest: ReadonlyArray<LimitSnapshot>
}

export interface LimitsLineItem {
  readonly agent: Agent
  /** "Claude 48% weekly", or "Codex unknown". */
  readonly text: string
  readonly tone: LimitTone
}

export interface ConnectLimitsView {
  readonly line: ReadonlyArray<LimitsLineItem>
  readonly hosts: ReadonlyArray<HostLimitsView>
  /** Hosts that gave no reading, in words. */
  readonly notes: ReadonlyArray<string>
  /** No host is set up to read limits and none failed: Connect shows nothing about them. */
  readonly off: boolean
}

const toneRank = { "at-limit": 3, near: 2, unknown: 1, ok: 0 } satisfies Record<LimitTone, number>

/** An old reading is not the level now: on the line it counts as unknown. */
const lineTone = (window: WindowSummary): LimitTone => (window.freshness === "stale" ? "unknown" : window.tone)

const closer = (left: WindowSummary, right: WindowSummary): WindowSummary => {
  const byTone = toneRank[lineTone(right)] - toneRank[lineTone(left)]
  if (byTone !== 0) return byTone > 0 ? right : left
  return (right.usedPercent ?? -1) > (left.usedPercent ?? -1) ? right : left
}

const lineItem = (agent: Agent, window: WindowSummary | undefined): LimitsLineItem => {
  const tone = window === undefined ? "unknown" : lineTone(window)
  return {
    agent,
    tone,
    text: window === undefined || window.usedPercent === null || tone === "unknown"
      ? `${agentName(agent)} unknown`
      : `${agentName(agent)} ${String(Math.round(window.usedPercent))}% ${window.name.toLowerCase()}`
  }
}

const unavailableNote = (host: string, reading: Extract<HostLimits["reading"], { _tag: "Unavailable" }>) => {
  switch (reading.reason) {
    case "not_configured":
      return `Limits are off on ${host}`
    case "failed":
      return reading.detail === "" ? `agent-usage failed on ${host}` : `${host}: ${reading.detail}`
    case "timeout":
      return `agent-usage didn't answer on ${host}`
    case "unsupported_version":
      return `agent-usage on ${host} is newer than this hub; update hostd to read it`
    case "invalid_output":
      return `agent-usage answered something unexpected on ${host}`
  }
}

const failureWords = {
  offline: "offline",
  unavailable: "no tailnet address",
  timeout: "no answer",
  request_failed: "request failed",
  invalid_response: "unexpected answer"
} satisfies Record<FleetLimits["failures"][number]["reason"], string>

/** The fleet's limits as Connect shows them, `sinceLoad` milliseconds after the page received them. */
export const connectLimitsView = (fleet: FleetLimits, sinceLoad: number): ConnectLimitsView => {
  const hosts: Array<HostLimitsView> = []
  const notes: Array<string> = []
  for (const host of fleet.hosts) {
    if (host.reading._tag === "Unavailable") notes.push(unavailableNote(host.host, host.reading))
    else {
      const skipped = host.reading.skipped
      if (skipped > 0) {
        notes.push(
          `${host.host}: ${String(skipped)} ${
            skipped === 1 ? "reading is" : "readings are"
          } from a newer agent-usage and not shown`
        )
      }
      hosts.push({
        host: host.host,
        now: host.reading.limits.observedAt + Math.max(0, sinceLoad),
        latest: host.reading.limits.latest
      })
    }
  }
  for (const failure of fleet.failures) notes.push(`No reading from ${failure.host} (${failureWords[failure.reason]})`)
  if (!fleet.peersListed) notes.push("Other machines unknown: the hub couldn't list the fleet")
  const groups = hosts.flatMap((host) => summarizeLimits(host.latest, host.now))
  const agents: ReadonlyArray<Agent> = ["claude", "codex"]
  const line = agents.flatMap((agent): ReadonlyArray<LimitsLineItem> => {
    const own = groups.filter((group) => group.agent === agent)
    if (own.length === 0) return []
    const windows = own.flatMap((group) => group.windows)
    const worst = windows.reduce<WindowSummary | undefined>(
      (best, window) => (best === undefined ? window : closer(best, window)),
      undefined
    )
    return [lineItem(agent, worst)]
  })
  const off = hosts.length === 0 && fleet.failures.length === 0 && fleet.peersListed &&
    fleet.hosts.every((host) => host.reading._tag === "Unavailable" && host.reading.reason === "not_configured")
  return { line, hosts, notes, off }
}
