/**
 * What the hub's Usage tab draws, from the fleet's `agent-usage usage` reads: one token chart for
 * the whole fleet, stacked by agent and model, and each host's limit series under it.
 *
 * **Mental model**
 *
 * - **One calendar.** Every host is asked with the viewer's zone, so the same day or hour has the
 *   same period key everywhere. The chart's columns are the union of every host's period keys, in
 *   time order, and each host's cells land on their key; a host whose clock is a little off never
 *   gets its own column.
 * - **Tokens only.** A series is an agent's model ("Claude claude-opus-5"); nothing else reached
 *   the hub, so nothing else can be drawn.
 * - **A host with nothing is said, not hidden.** A host that could not be read, a peer that could
 *   not be asked, and a fleet that could not be listed each get a note.
 *
 * @module
 */
import { agentName } from "@knpkv/agent-usage/limits"
import type { SeriesCell, ViewRange } from "@knpkv/agent-usage/usage"
import type { FleetUsage, UsageNow } from "./usage.js"

type LimitSeries = UsageNow["limits"][number]

export interface HostLimitSeries {
  readonly host: string
  /** This host's range, on its own clock. */
  readonly range: ViewRange
  /** This host's "now": its `observedAt` plus the time since the page received the read. */
  readonly now: number
  readonly series: ReadonlyArray<LimitSeries>
}

export interface UsageTabView {
  /** The chart's columns: every host's periods, merged by key, oldest first. */
  readonly periods: ReadonlyArray<{ readonly key: string; readonly start: number }>
  readonly range: ViewRange | null
  readonly cells: ReadonlyArray<SeriesCell>
  readonly labels: ReadonlyMap<string, string>
  readonly totalTokens: number
  readonly hosts: ReadonlyArray<HostLimitSeries>
  /** Hosts and peers that gave no reading, in words. */
  readonly notes: ReadonlyArray<string>
}

const seriesId = (agent: string, model: string): string => `${agent}:${model}`

/** agent-usage's stderr sentence, without its own "agent-usage:" prefix or Markdown backticks. */
const plainDetail = (detail: string): string => detail.replace(/^(?:agent-usage:\s*)+/u, "").replaceAll("`", "")

const unavailableNote = (host: string, reason: string, detail: string): string => {
  switch (reason) {
    case "not_configured":
      return `${host}: usage is not set up on this host.`
    case "unsupported_version":
      return `${host}: its agent-usage is newer than this hub reads (${plainDetail(detail)}).`
    case "timeout":
      return `${host}: agent-usage did not answer in time.`
    default:
      return `${host}: ${plainDetail(detail)}`
  }
}

const failureNote = (host: string, reason: string): string =>
  reason === "offline"
    ? `${host} is offline.`
    : `${host} could not be asked for its usage (${reason.replace("_", " ")}).`

/**
 * The Usage tab's view of a fleet read. `sinceReceived` is how long ago this page received it, on
 * this page's clock; each host's "now" is its own `observedAt` plus that.
 */
export const usageTabView = (fleet: FleetUsage, sinceReceived: number): UsageTabView => {
  const reads = fleet.hosts.flatMap((host) =>
    host.reading._tag === "Read" ? [{ host: host.host, usage: host.reading.usage, skipped: host.reading.skipped }] : []
  )
  const byKey = new Map<string, number>()
  for (const { usage } of reads) {
    for (const period of usage.periods) {
      const known = byKey.get(period.key)
      if (known === undefined || period.start < known) byKey.set(period.key, period.start)
    }
  }
  const periods = [...byKey].map(([key, start]) => ({ key, start })).sort((left, right) => left.start - right.start)
  const index = new Map(periods.map((period, at) => [period.key, at]))
  const labels = new Map<string, string>()
  const cells: Array<SeriesCell> = []
  let totalTokens = 0
  for (const { usage } of reads) {
    for (const cell of usage.tokens) {
      const key = usage.periods[cell.period]?.key
      const period = key === undefined ? undefined : index.get(key)
      if (period === undefined) continue
      const id = seriesId(cell.agent, cell.model)
      labels.set(id, `${agentName(cell.agent)} ${cell.model}`)
      cells.push({ period, id, value: cell.tokens })
      totalTokens += cell.tokens
    }
  }
  const first = reads[0]?.usage
  const range: ViewRange | null = first === undefined
    ? null
    : {
      from: periods[0]?.start ?? first.range.from,
      to: Math.max(...reads.map(({ usage }) => usage.range.to)),
      bucket: first.range.bucket
    }
  const notes = [
    ...fleet.hosts.flatMap((host) =>
      host.reading._tag === "Unavailable" ? [unavailableNote(host.host, host.reading.reason, host.reading.detail)] : []
    ),
    ...reads.flatMap(({ host, skipped }) =>
      skipped === 0 ? [] : [`${host}: ${String(skipped)} entries from a newer agent-usage are not shown.`]
    ),
    ...fleet.failures.map((failure) => failureNote(failure.host, failure.reason)),
    ...(fleet.peersListed ? [] : ["The other machines could not be listed, so only this host is shown."])
  ]
  return {
    periods,
    range,
    cells,
    labels,
    totalTokens,
    hosts: reads.map(({ host, usage }) => ({
      host,
      range: { from: usage.range.from, to: usage.range.to, bucket: usage.range.bucket },
      now: usage.observedAt + sinceReceived,
      series: usage.limits
    })),
    notes
  }
}
