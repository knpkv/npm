import {
  AgentStateLabel,
  agentBucketLabel,
  agentBuckets,
  type AgentBucket,
  agentStatePresentation
} from "./agent-state.js"
import { Hero, HeroWord } from "@knpkv/rly/patterns"
import { Text } from "@knpkv/rly/primitives"
import { Schema } from "effect"
import { useId, useState, type ReactNode, type Ref } from "react"
import type { ConnectAgent, ConnectPeerFailure } from "./model.js"
import {
  serializeTerminalKey,
  terminalKeyDescriptors,
  terminalModifiers,
  type TerminalModifier,
  type TerminalRailKey
} from "./terminal-keyboard.js"
import { nextTerminalRailIndex } from "./terminal-rail-navigation.js"

export type AgentActivityFilter = "all" | AgentBucket

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

const activityFilters: ReadonlyArray<AgentActivityFilter> = ["all", ...agentBuckets]

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

const activityFilterLabel = (activity: AgentActivityFilter): string =>
  activity === "all" ? "All" : agentBucketLabel(activity)

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

/** An agent id as a reader can scan it: the prefix and the first eight characters of its hash. */
const shortAgentId = (id: string): string => (id.length > 14 ? `${id.slice(0, 14)}…` : id)

/**
 * How an agent relates to its parent, naming the parent by its name when the directory lists it
 * (`names` maps agent id to name); an unlisted parent is shown by a short id, never the full hash.
 */
const relationLabel = (
  agent: ConnectAgent,
  issue: ConnectLineageIssue | null,
  names: ReadonlyMap<string, string>
): ReactNode => {
  const parentAgentId = agent.relationship?.parentAgentId
  const parentName = parentAgentId === undefined ? undefined : (names.get(parentAgentId) ?? shortAgentId(parentAgentId))
  const parent = parentName === undefined ? undefined : <span className="connect-token">{parentName}</span>
  if (issue === "unknown_parent" || issue === "cross_host") {
    if (parent === undefined) return "Malformed relationship"
    return (
      <>
        {issue === "unknown_parent" ? "Unknown parent" : "Cross-host parent"} {parent}
      </>
    )
  }
  if (issue === "cycle") return "Cyclic relationship"
  if (issue === "ambiguous") return "Ambiguous ownership"
  if (agent.relationship === undefined || parent === undefined) return "Root agent"
  return (
    <>
      {agent.relationship.relation} for {parent}
    </>
  )
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
      const activity = agentStatePresentation(agent.state).bucket
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
  /** Hosts that didn't answer this read; the Host filter names them so the gap in the list is visible. */
  readonly silentHosts?: ReadonlyArray<string>
  readonly timeZone?: string
}

/**
 * How many agents each Status filter option holds, within the current Host filter. The search
 * query is ignored, so typing never changes the option labels under the cursor.
 */
export const agentBucketCounts = (
  agents: ReadonlyArray<ConnectAgent>,
  hostFilter: string | null
): ReadonlyMap<AgentActivityFilter, number> => {
  const inHost = agents.filter((agent) => hostFilter === null || agent.host === hostFilter)
  return new Map<AgentActivityFilter, number>([
    ["all", inHost.length],
    ...agentBuckets.map((bucket): readonly [AgentActivityFilter, number] => [
      bucket,
      inHost.filter((agent) => agentStatePresentation(agent.state).bucket === bucket).length
    ])
  ])
}

const failureReasonLabel = (reason: ConnectPeerFailure["reason"]): string => {
  switch (reason) {
    case "offline":
      return "offline"
    case "unavailable":
      return "Connect unavailable"
    case "timeout":
      return "timed out"
    case "request_failed":
      return "request failed"
    case "invalid_response":
      return "unreadable answer"
  }
}

/** One line naming the hosts that didn't answer, each with its cause, and what that means for the list. */
export const silentHostsSentence = (failures: ReadonlyArray<ConnectPeerFailure>): string | null => {
  if (failures.length === 0) return null
  const named = failures.map(({ host, reason }) => `${host} (${failureReasonLabel(reason)})`).join(", ")
  return failures.length === 1
    ? `${named} didn't answer; its agents aren't listed.`
    : `${named} didn't answer; their agents aren't listed.`
}

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

/**
 * The Connect directory's one sentence: how many agents are listed, how many are working, and how
 * many need you. Hosts that didn't answer are named once, by the line above the list, not here.
 * `agents` is null while the first list loads or when it failed.
 */
export const ConnectSummary = ({
  agents,
  unavailable
}: {
  readonly agents: ReadonlyArray<ConnectAgent> | null
  readonly unavailable: boolean
}) => {
  const needAttention =
    agents?.filter((agent) => agentStatePresentation(agent.state).bucket === "needs-you").length ?? 0
  const working = agents?.filter((agent) => agentStatePresentation(agent.state).bucket === "working").length ?? 0
  const total = agents?.length ?? 0
  return (
    <>
      <Hero
        fact={
          agents === null ? (
            unavailable ? (
              "The fleet directory didn't answer"
            ) : (
              "Loading the fleet…"
            )
          ) : (
            <>
              {plural(total, "agent", "agents")}, {String(working)} working
              {needAttention === 0 ? null : (
                <>
                  ,{" "}
                  <HeroWord tone="held">{`${String(needAttention)} need${needAttention === 1 ? "s" : ""} you`}</HeroWord>
                </>
              )}
            </>
          )
        }
        label="Connect summary"
      />
      {/* Connect's own caption, so narrow screens can drop it without reaching into the Hero's markup. */}
      <p className="connect-intro-caption">Choose a worker, reviewer, or coordinator to open its exact terminal.</p>
    </>
  )
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
  silentHosts = [],
  timeZone
}: AgentDirectoryProps) => {
  const hostFilterLabelId = useId()
  const statusFilterLabelId = useId()
  const hosts = connectAgentHosts(agents)
  const names: ReadonlyMap<string, string> = new Map(agents.map((entry) => [String(entry.id), entry.name]))
  // With one host the filter already names it; rows repeat it only when it tells agents apart.
  const severalHosts = hosts.length > 1
  const counts = agentBucketCounts(agents, hostFilter)
  const rows = connectLineageRows(agents).filter(({ agent }) => {
    const activity = agentStatePresentation(agent.state).bucket
    return (
      matchesQuery(agent, query) &&
      (hostFilter === null || agent.host === hostFilter) &&
      (activityFilter === "all" || activity === activityFilter)
    )
  })
  return (
    <>
      <div className="connect-filter-row">
        <div className="connect-filter-set">
          <span className="connect-filter-label" id={hostFilterLabelId}>
            Host
          </span>
          <div aria-labelledby={hostFilterLabelId} className="connect-group-filter" role="group">
            <button aria-pressed={hostFilter === null} onClick={() => onHostFilter(null)} type="button">
              All hosts
            </button>
            {hosts.map((host) => (
              <button aria-pressed={hostFilter === host} key={host} onClick={() => onHostFilter(host)} type="button">
                {host}
              </button>
            ))}
            {/* A host that didn't answer has no agents to filter to; it is named, not offered. */}
            {silentHosts
              .filter((host) => !hosts.includes(host))
              .map((host) => (
                <span className="connect-host-silent" key={host}>
                  {host} <small>didn't answer</small>
                </span>
              ))}
          </div>
        </div>
        <div className="connect-filter-set">
          <span className="connect-filter-label" id={statusFilterLabelId}>
            Status
          </span>
          <div aria-labelledby={statusFilterLabelId} className="connect-status-filter" role="group">
            {activityFilters.map((activity) => (
              <button
                aria-pressed={activityFilter === activity}
                key={activity}
                onClick={() => onActivityFilter(activity)}
                type="button"
              >
                {activityFilterLabel(activity)}
                <span className="connect-visually-hidden">,</span>{" "}
                <span className="connect-filter-count">{String(counts.get(activity) ?? 0)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="connect-agent-tree">
        {rows.length === 0 ? <Text tone="secondary">No agents match “{query.trim()}”.</Text> : null}
        {rows.length === 0 ? null : (
          <div aria-hidden="true" className="connect-list-head">
            <span>State</span>
            <span>Agent</span>
            <span>Active</span>
          </div>
        )}
        <div className="connect-agent-list">
          {rows.map(({ agent, depth, issue }, index) => {
            const key = connectAgentKey(agent)
            const activity = agentStatePresentation(agent.state).bucket
            return (
              <button
                aria-pressed={selectedKey === key}
                className="connect-agent"
                data-activity={activity}
                data-agent-key={key}
                data-lineage-issue={issue ?? "none"}
                data-selected={selectedKey === key}
                key={`${key}:${String(index)}`}
                onClick={() => onSelect(agent)}
              >
                {/* The state leads in a fixed track, so names line up whatever the state's word. */}
                <span className="connect-agent-state" data-activity={activity}>
                  <AgentStateLabel state={agent.state} />
                </span>
                {/* Lineage indents the name, not the state, so the state column stays straight. */}
                <span className="connect-agent-copy" style={{ paddingInlineStart: `${String(depth * 20)}px` }}>
                  <Text as="strong" variant="label">
                    {agent.name}
                  </Text>
                  <Text as="small" variant="meta" tone="secondary">
                    {/* Host and work names are identifiers: each moves to the next line whole rather than splitting at a hyphen. */}
                    {severalHosts ? (
                      <>
                        <span className="connect-token">{agent.host}</span>,{" "}
                      </>
                    ) : null}
                    {relationLabel(agent, issue, names)}, <span className="connect-token">{agent.work}</span>
                  </Text>
                </span>
                <time dateTime={new Date(agent.lastActivityAt).toISOString()}>
                  <span className="connect-visually-hidden">, last active at </span>
                  {timeLabel(agent.lastActivityAt, timeZone)}
                </time>
                {/* The row's own content names it; the action is added, never put in its place. */}
                <span className="connect-visually-hidden">, open terminal</span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

type ConnectWorkspaceProps = {
  readonly directoryViewportRef?: Ref<HTMLDivElement>
  readonly directory: ReactNode
  readonly mode: "directory" | "terminal"
  readonly terminal: ReactNode
  readonly terminalViewportRef?: Ref<HTMLDivElement>
  readonly workspaceRef?: Ref<HTMLDivElement>
}

export const ConnectWorkspace = ({
  directory,
  directoryViewportRef,
  mode,
  terminal,
  terminalViewportRef,
  workspaceRef
}: ConnectWorkspaceProps) => (
  <div className="connect-workspace" data-mode={mode} ref={workspaceRef} tabIndex={-1}>
    <div
      aria-hidden={mode === "terminal"}
      className="connect-directory-screen"
      inert={mode === "terminal"}
      ref={directoryViewportRef}
      tabIndex={-1}
    >
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
  readonly onFocusTerminal: () => void
  readonly onModifierChange: (modifier: TerminalModifier) => void
  readonly onKey: (key: TerminalRailKey) => void
  readonly error?: string | null
  readonly disabled?: boolean
  /** Show the screen as selectable text; the touch counterpart of a mouse selection. */
  readonly onSelectText?: () => void
  /** Return to the newest output; always offered because the client may not know it is behind. */
  readonly onJumpToLatest?: () => void
  /** Lines this client knows it scrolled back; above 0 the rail says so beside Latest. */
  readonly linesBack?: number
  /** The position is not confirmed (Latest's last reading never came, or a read failed); the rail says so instead of nothing. */
  readonly positionUnconfirmed?: boolean
  /** The modifier and terminal keys are hidden; the view actions and this toggle stay. */
  readonly keysHidden?: boolean
  /** Offers a pinned Keys toggle when given; the caller remembers the choice. */
  readonly onKeysHiddenChange?: (hidden: boolean) => void
}

const modifierLabel = (modifier: TerminalModifier): string => (modifier === "ctrl" ? "Ctrl" : "Alt")

/** A fixed, keyboard-accessible set of terminal controls for touch layouts. */
export const TerminalKeyRail = ({
  disabled = false,
  error = null,
  keysHidden = false,
  linesBack = 0,
  modifier,
  onFocusTerminal,
  onJumpToLatest,
  onKey,
  onKeysHiddenChange,
  onModifierChange,
  onSelectText,
  positionUnconfirmed = false
}: TerminalKeyRailProps) => {
  const keysId = useId()
  const [activeIndex, setActiveIndex] = useState(0)
  const modifierCount = terminalModifiers.length
  const terminalKeyAvailability = terminalKeyDescriptors.map(
    (descriptor) => serializeTerminalKey(descriptor.key, modifier)._tag === "supported"
  )
  // View actions stay pinned at the rail's end, in reach while the keys scroll under them.
  const viewActions: ReadonlyArray<{
    readonly key: string
    readonly label: string
    readonly ariaLabel: string
    readonly onClick: () => void
    readonly expanded?: boolean
  }> = [
    ...(onKeysHiddenChange === undefined
      ? []
      : [
          {
            key: "keys",
            label: "Keys",
            ariaLabel: keysHidden ? "Show terminal keys" : "Hide terminal keys",
            onClick: () => onKeysHiddenChange(!keysHidden),
            expanded: !keysHidden
          }
        ]),
    ...(onJumpToLatest === undefined
      ? []
      : [{ key: "latest", label: "Latest", ariaLabel: "Jump to latest output", onClick: onJumpToLatest }]),
    ...(onSelectText === undefined
      ? []
      : [{ key: "select", label: "Select", ariaLabel: "Select terminal text to copy", onClick: onSelectText }])
  ]
  const viewActionStart = modifierCount + terminalKeyDescriptors.length
  const enabledRail = [
    ...terminalModifiers.map(() => !disabled && !keysHidden),
    ...terminalKeyAvailability.map((available) => !disabled && !keysHidden && available),
    ...viewActions.map(() => !disabled)
  ]
  const tabStopIndex = enabledRail[activeIndex] === true ? activeIndex : enabledRail.findIndex((enabled) => enabled)
  return (
    <div
      aria-label="Terminal keyboard controls"
      aria-orientation="horizontal"
      className="terminal-key-rail"
      data-terminal-key-rail
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-terminal-key]")]
        const currentIndex = buttons.findIndex((button) => button === event.target)
        if (currentIndex < 0) return
        const nextIndex = nextTerminalRailIndex(
          event.key,
          currentIndex,
          buttons.map(({ disabled }) => !disabled)
        )
        if (nextIndex === null) return
        const next = buttons.at(nextIndex)
        if (next === undefined) return
        event.preventDefault()
        setActiveIndex(nextIndex)
        next.focus()
      }}
      role="toolbar"
    >
      <div className="terminal-key-scroll">
        <div
          aria-label="Terminal modifiers"
          className="terminal-key-group"
          hidden={keysHidden}
          id={`${keysId}-modifiers`}
          role="group"
        >
          {terminalModifiers.map((item, index) => (
            <button
              aria-pressed={modifier === item}
              className="terminal-key terminal-key-modifier"
              data-terminal-key={item}
              disabled={disabled || keysHidden}
              key={item}
              onClick={(event) => {
                setActiveIndex(index)
                onModifierChange(item)
                if (event.detail === 0) onFocusTerminal()
              }}
              onFocus={() => setActiveIndex(index)}
              onPointerDown={(event) => event.preventDefault()}
              tabIndex={tabStopIndex === index ? 0 : -1}
              type="button"
            >
              {modifierLabel(item)}
            </button>
          ))}
        </div>
        <div
          aria-label="Terminal keys"
          className="terminal-key-group"
          hidden={keysHidden}
          id={`${keysId}-keys`}
          role="group"
        >
          {terminalKeyDescriptors.map((descriptor, index) => {
            const serialization = serializeTerminalKey(descriptor.key, modifier)
            const unavailable = serialization._tag === "unsupported"
            const railIndex = modifierCount + index
            return (
              <button
                aria-label={
                  modifier === null ? descriptor.ariaLabel : `${modifierLabel(modifier)} ${descriptor.ariaLabel}`
                }
                className="terminal-key"
                data-terminal-key={descriptor.key}
                disabled={disabled || keysHidden || unavailable}
                key={descriptor.key}
                onClick={() => onKey(descriptor.key)}
                onFocus={() => setActiveIndex(railIndex)}
                onPointerDown={(event) => event.preventDefault()}
                tabIndex={tabStopIndex === railIndex ? 0 : -1}
                title={unavailable ? "Choose a supported modifier combination" : undefined}
                type="button"
              >
                {descriptor.label}
              </button>
            )
          })}
        </div>
        {viewActions.length === 0 ? null : (
          <div aria-label="Terminal view" className="terminal-key-group terminal-key-group-pinned" role="group">
            {linesBack > 0 ? (
              <span
                aria-label={`Older output, ${linesBack} ${linesBack === 1 ? "line" : "lines"} back`}
                className="terminal-older-output"
                role="status"
              >
                <span aria-hidden="true">{`${linesBack} ${linesBack === 1 ? "line" : "lines"} back`}</span>
              </span>
            ) : positionUnconfirmed ? (
              <span aria-label="Position not confirmed" className="terminal-older-output" role="status">
                <span aria-hidden="true">Not confirmed</span>
              </span>
            ) : null}
            {viewActions.map((action, index) => (
              <button
                aria-controls={action.expanded === undefined ? undefined : `${keysId}-modifiers ${keysId}-keys`}
                aria-expanded={action.expanded}
                aria-label={action.ariaLabel}
                className="terminal-key"
                data-behind={action.key === "latest" && (linesBack > 0 || positionUnconfirmed) ? "true" : undefined}
                data-terminal-key={action.key}
                disabled={disabled}
                key={action.key}
                onClick={action.onClick}
                onFocus={() => setActiveIndex(viewActionStart + index)}
                onPointerDown={(event) => event.preventDefault()}
                tabIndex={tabStopIndex === viewActionStart + index ? 0 : -1}
                type="button"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <small aria-live="polite" className="terminal-key-error">
        {error ?? ""}
      </small>
    </div>
  )
}
