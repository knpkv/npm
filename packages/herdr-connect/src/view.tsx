import { StateLabel, Text } from "@knpkv/rly/primitives"
import { Schema } from "effect"
import type { ReactNode, Ref } from "react"
import type { ConnectAgent } from "./model.js"
import {
  serializeTerminalKey,
  terminalKeyDescriptors,
  terminalModifiers,
  type TerminalModifier,
  type TerminalRailKey
} from "./terminal-keyboard.js"

type AgentActivity = "working" | "ready" | "attention" | "finished"
export type AgentActivityFilter = "all" | AgentActivity

type AgentFilters = {
  readonly activity: AgentActivityFilter
  readonly host: string | null
  readonly query: string
}

export type ConnectLineageIssue = "ambiguous" | "cross_host" | "cycle" | "unknown_parent"

export interface ConnectLineageRow {
  readonly agent: ConnectAgent
  readonly depth: number
  readonly issue: ConnectLineageIssue | null
}

type AgentCalendarDay = {
  readonly dateLabel: string
  readonly key: string
  readonly label: string
  readonly agents: ReadonlyArray<ConnectAgent>
}

type CalendarOptions = {
  readonly now: number
  readonly timeZone?: string
}

const activityOrder: ReadonlyArray<AgentActivity> = ["working", "attention", "ready", "finished"]
const activityFilters: ReadonlyArray<AgentActivityFilter> = ["all", ...activityOrder]

const naturalOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
})

class ConnectCalendarFormatError extends Schema.TaggedError<ConnectCalendarFormatError>()(
  "ConnectCalendarFormatError",
  { timestamp: Schema.Number }
) {}

export const connectAgentKey = (agent: ConnectAgent): string => `${agent.host}:${agent.id}`

export const connectAgentHosts = (agents: ReadonlyArray<ConnectAgent>): ReadonlyArray<string> =>
  [...new Set(agents.map(({ host }) => host))].toSorted(naturalOrder.compare)

const activityFor = (state: string): AgentActivity => {
  switch (state.toLocaleLowerCase("en-US")) {
    case "running":
    case "working":
      return "working"
    case "idle":
    case "waiting":
    case "ready":
      return "ready"
    case "blocked":
    case "unknown":
      return "attention"
    case "done":
      return "finished"
    default:
      return "attention"
  }
}

const activityLabel = (activity: AgentActivity): string =>
  activity === "working"
    ? "Working"
    : activity === "ready"
      ? "Ready"
      : activity === "attention"
        ? "Attention"
        : "Finished"

const activityFilterLabel = (activity: AgentActivityFilter): string =>
  activity === "all" ? "All" : activityLabel(activity)

const workSummary = (agent: ConnectAgent): string => {
  switch (activityFor(agent.state)) {
    case "working":
      return `Working in ${agent.work}`
    case "ready":
      return `Ready in ${agent.work}`
    case "attention":
      return `Needs attention in ${agent.work}`
    case "finished":
      return `Last active in ${agent.work}`
  }
}

const agentTone = (state: string): "positive" | "progress" | "neutral" =>
  activityFor(state) === "working" ? "progress" : activityFor(state) === "ready" ? "positive" : "neutral"

const matchesQuery = (agent: ConnectAgent, query: string): boolean => {
  const normalized = query.trim().toLocaleLowerCase("en-US")
  if (normalized.length === 0) return true
  return [agent.host, agent.name, agent.kind, agent.state, agent.work].some((value) =>
    value.toLocaleLowerCase("en-US").includes(normalized)
  )
}

export const connectLineageRows = (agents: ReadonlyArray<ConnectAgent>): ReadonlyArray<ConnectLineageRow> => {
  const keyOf = (agent: Pick<ConnectAgent, "host" | "id">): string => `${agent.host.toLowerCase()}\u0000${agent.id}`
  const counts = new Map<string, number>()
  const byKey = new Map<string, ConnectAgent>()
  for (const agent of agents) {
    const key = keyOf(agent)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    byKey.set(key, agent)
  }
  const rows = agents.map((agent): ConnectLineageRow => {
    const ownKey = keyOf(agent)
    if ((counts.get(ownKey) ?? 0) > 1) return { agent, depth: 0, issue: "ambiguous" }
    let depth = 0
    let current = agent
    const path = new Set<string>([ownKey])
    while (current.relationship !== undefined) {
      const parentKey = `${current.host.toLowerCase()}\u0000${current.relationship.parentAgentId}`
      const parent = byKey.get(parentKey)
      if (parent === undefined) {
        const foreign = agents.some((candidate) => candidate.id === current.relationship?.parentAgentId)
        return { agent, depth, issue: foreign ? "cross_host" : "unknown_parent" }
      }
      if (path.has(parentKey)) return { agent, depth, issue: "cycle" }
      path.add(parentKey)
      depth += 1
      current = parent
    }
    return { agent, depth, issue: null }
  })
  const compare = (left: ConnectLineageRow, right: ConnectLineageRow): number =>
    naturalOrder.compare(left.agent.host, right.agent.host) || naturalOrder.compare(left.agent.name, right.agent.name)
  const children = new Map<string, Array<ConnectLineageRow>>()
  for (const row of rows) {
    if (row.issue !== null || row.agent.relationship === undefined) continue
    const parentKey = `${row.agent.host.toLowerCase()}\u0000${row.agent.relationship.parentAgentId}`
    const siblings = children.get(parentKey) ?? []
    siblings.push(row)
    children.set(parentKey, siblings)
  }
  const ordered: Array<ConnectLineageRow> = []
  const seen = new Set<string>()
  const visit = (row: ConnectLineageRow): void => {
    const key = keyOf(row.agent)
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(row)
    for (const child of (children.get(key) ?? []).toSorted(compare)) visit(child)
  }
  for (const root of rows.filter((row) => row.issue === null && row.depth === 0).toSorted(compare)) visit(root)
  return [...ordered, ...rows.filter((row) => !seen.has(keyOf(row.agent))).toSorted(compare)]
}

const relationLabel = (agent: ConnectAgent, issue: ConnectLineageIssue | null): string => {
  if (issue === "unknown_parent" || issue === "cross_host") {
    const parentAgentId = agent.relationship?.parentAgentId
    if (parentAgentId === undefined) return "Malformed relationship"
    return issue === "unknown_parent" ? `Unknown parent ${parentAgentId}` : `Cross-host parent ${parentAgentId}`
  }
  if (issue === "cycle") return "Cyclic relationship"
  if (issue === "ambiguous") return "Ambiguous ownership"
  if (agent.relationship === undefined) return "Root agent"
  return `${agent.relationship.relation} by ${agent.relationship.parentAgentId}`
}

interface CalendarParts {
  readonly day: number
  readonly key: string
}

const calendarParts = (timestamp: number, timeZone: string | undefined): CalendarParts => {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric"
  }).formatToParts(timestamp)
  const year = Number(parts.find(({ type }) => type === "year")?.value)
  const month = Number(parts.find(({ type }) => type === "month")?.value)
  const date = Number(parts.find(({ type }) => type === "day")?.value)
  if (![year, month, date].every(Number.isInteger)) {
    throw new ConnectCalendarFormatError({ timestamp })
  }
  return {
    day: Date.UTC(year, month - 1, date) / 86_400_000,
    key: `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`
  }
}

const dateLabel = (timestamp: number, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    timeZone,
    weekday: "long"
  }).format(timestamp)

const timeLabel = (timestamp: number, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone
  }).format(timestamp)

export const calendarConnectAgents = (
  agents: ReadonlyArray<ConnectAgent>,
  filters: AgentFilters,
  options: CalendarOptions
): ReadonlyArray<AgentCalendarDay> => {
  const today = calendarParts(options.now, options.timeZone).day
  const days = new Map<string, AgentCalendarDay>()
  const filtered = agents
    .filter((agent) => {
      const activity = activityFor(agent.state)
      return (
        matchesQuery(agent, filters.query) &&
        (filters.host === null || agent.host === filters.host) &&
        (filters.activity === "all" || activity === filters.activity)
      )
    })
    .toSorted(
      (left, right) =>
        right.lastActivityAt - left.lastActivityAt ||
        naturalOrder.compare(left.name, right.name) ||
        naturalOrder.compare(connectAgentKey(left), connectAgentKey(right))
    )
  for (const agent of filtered) {
    const parts = calendarParts(agent.lastActivityAt, options.timeZone)
    const relativeDay = today - parts.day
    const existing = days.get(parts.key)
    if (existing === undefined) {
      days.set(parts.key, {
        key: parts.key,
        label:
          relativeDay === 0
            ? "Today"
            : relativeDay === 1
              ? "Yesterday"
              : dateLabel(agent.lastActivityAt, options.timeZone),
        dateLabel: dateLabel(agent.lastActivityAt, options.timeZone),
        agents: [agent]
      })
    } else {
      days.set(parts.key, { ...existing, agents: [...existing.agents, agent] })
    }
  }
  return [...days.values()]
}

type AgentDirectoryProps = {
  readonly activityFilter: AgentActivityFilter
  readonly agents: ReadonlyArray<ConnectAgent>
  readonly hostFilter: string | null
  readonly onActivityFilter: (activity: AgentActivityFilter) => void
  readonly onHostFilter: (host: string | null) => void
  readonly onSelect: (agent: ConnectAgent) => void
  readonly now?: number
  readonly query: string
  readonly selectedKey: string | null
  readonly timeZone?: string
}

export const AgentDirectory = ({
  activityFilter,
  agents,
  hostFilter,
  onActivityFilter,
  onHostFilter,
  onSelect,
  query,
  selectedKey,
  timeZone
}: AgentDirectoryProps) => {
  const hosts = connectAgentHosts(agents)
  const rows = connectLineageRows(agents).filter(({ agent }) => {
    const activity = activityFor(agent.state)
    return (
      matchesQuery(agent, query) &&
      (hostFilter === null || agent.host === hostFilter) &&
      (activityFilter === "all" || activity === activityFilter)
    )
  })
  return (
    <>
      <div className="connect-filter-row">
        <div aria-label="Filter agents by host" className="connect-group-filter" role="group">
          <button aria-pressed={hostFilter === null} onClick={() => onHostFilter(null)} type="button">
            All hosts
          </button>
          {hosts.map((host) => (
            <button aria-pressed={hostFilter === host} key={host} onClick={() => onHostFilter(host)} type="button">
              {host}
            </button>
          ))}
        </div>
        <div aria-label="Filter agents by status" className="connect-status-filter" role="group">
          {activityFilters.map((activity) => (
            <button
              aria-pressed={activityFilter === activity}
              key={activity}
              onClick={() => onActivityFilter(activity)}
              type="button"
            >
              {activityFilterLabel(activity)}
            </button>
          ))}
        </div>
      </div>
      <div className="connect-agent-tree">
        {rows.length === 0 ? <Text tone="secondary">No agents match “{query.trim()}”.</Text> : null}
        <div className="connect-agent-list">
          {rows.map(({ agent, depth, issue }, index) => {
            const key = connectAgentKey(agent)
            const activity = activityFor(agent.state)
            return (
              <button
                aria-pressed={selectedKey === key}
                className="connect-agent"
                data-activity={activity}
                data-agent-key={key}
                data-lineage-issue={issue ?? "none"}
                data-selected={selectedKey === key}
                style={{ paddingInlineStart: `calc(var(--rly-space-12) + ${String(depth * 20)}px)` }}
                key={`${key}:${String(index)}`}
                onClick={() => onSelect(agent)}
              >
                <time dateTime={new Date(agent.lastActivityAt).toISOString()}>
                  {timeLabel(agent.lastActivityAt, timeZone)}
                </time>
                <span className="agent-presence" data-activity={activity} aria-hidden="true" />
                <span className="connect-agent-copy">
                  <Text as="strong" variant="label">
                    {agent.name}
                  </Text>
                  <Text as="small" variant="meta" tone="secondary">
                    {agent.host} · {relationLabel(agent, issue)} · {workSummary(agent)}
                  </Text>
                </span>
                <StateLabel label={agent.state} tone={agentTone(agent.state)} size="compact" />
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

type ConnectWorkspaceProps = {
  readonly directory: ReactNode
  readonly mode: "directory" | "terminal"
  readonly terminal: ReactNode
  readonly terminalViewportRef?: Ref<HTMLDivElement>
}

export const ConnectWorkspace = ({ directory, mode, terminal, terminalViewportRef }: ConnectWorkspaceProps) => (
  <div className="connect-workspace" data-mode={mode}>
    <div aria-hidden={mode === "terminal"} className="connect-directory-screen" inert={mode === "terminal"}>
      {directory}
    </div>
    <div
      aria-hidden={mode === "directory"}
      className="connect-terminal-screen"
      inert={mode === "directory"}
      ref={terminalViewportRef}
    >
      {terminal}
    </div>
  </div>
)

type TerminalKeyRailProps = {
  readonly modifier: TerminalModifier | null
  readonly onModifierChange: (modifier: TerminalModifier) => void
  readonly onKey: (key: TerminalRailKey) => void
  readonly error?: string | null
  readonly disabled?: boolean
}

const modifierLabel = (modifier: TerminalModifier): string => (modifier === "ctrl" ? "Ctrl" : "Alt")

const modifierShortcut = (modifier: TerminalModifier | null, shortcut: string): string =>
  modifier === null ? shortcut : `${modifier === "ctrl" ? "Control" : "Alt"}+${shortcut}`

/** A fixed, keyboard-accessible set of terminal controls for touch layouts. */
export const TerminalKeyRail = ({
  disabled = false,
  error = null,
  modifier,
  onKey,
  onModifierChange
}: TerminalKeyRailProps) => (
  <div aria-label="Terminal keyboard controls" className="terminal-key-rail" data-terminal-key-rail role="toolbar">
    <div aria-label="Terminal modifiers" className="terminal-key-group" role="group">
      {terminalModifiers.map((item) => (
        <button
          aria-keyshortcuts={item === "ctrl" ? "Control" : "Alt"}
          aria-pressed={modifier === item}
          className="terminal-key terminal-key-modifier"
          data-terminal-key={item}
          disabled={disabled}
          key={item}
          onClick={() => onModifierChange(item)}
          onPointerDown={(event) => event.preventDefault()}
          type="button"
        >
          {modifierLabel(item)}
        </button>
      ))}
    </div>
    <div aria-label="Terminal keys" className="terminal-key-group" role="group">
      {terminalKeyDescriptors.map((descriptor) => {
        const serialization = serializeTerminalKey(descriptor.key, modifier)
        const unavailable = serialization._tag === "unsupported"
        return (
          <button
            aria-keyshortcuts={modifierShortcut(modifier, descriptor.shortcut)}
            aria-label={modifier === null ? descriptor.ariaLabel : `${modifierLabel(modifier)} ${descriptor.ariaLabel}`}
            className="terminal-key"
            data-terminal-key={descriptor.key}
            disabled={disabled || unavailable}
            key={descriptor.key}
            onClick={() => onKey(descriptor.key)}
            onPointerDown={(event) => event.preventDefault()}
            title={unavailable ? "Choose a supported modifier combination" : undefined}
            type="button"
          >
            {descriptor.label}
          </button>
        )
      })}
    </div>
    {error === null ? null : (
      <small aria-live="polite" className="terminal-key-error">
        {error}
      </small>
    )}
  </div>
)
