import { agentBucketLabel, agentBuckets, type AgentBucket, agentStatePresentation } from "./agent-state.js"
import { HeroWord } from "@knpkv/rly/patterns"
import { Icon } from "@knpkv/rly/foundations"
import { Text } from "@knpkv/rly/primitives"
import { Schema } from "effect"
import { Fragment, useId, useState, type ReactNode, type Ref } from "react"
import { Creature } from "./creature.js"
import type { ConnectAgent, ConnectPeerFailure } from "./model.js"
import {
  serializeTerminalKey,
  terminalKeyDescriptors,
  terminalModifiers,
  terminalModifierIsActive,
  type TerminalModifier,
  type TerminalModifiers,
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

/** A bad lineage edge still names an agent; a repeated own identity cannot choose a unique terminal. */
export const connectAgentIdentityAmbiguous = (agents: ReadonlyArray<ConnectAgent>, agent: ConnectAgent): boolean =>
  agents.filter((candidate) => candidate.host.toLowerCase() === agent.host.toLowerCase() && candidate.id === agent.id)
    .length > 1

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
      if ((counts.get(parentKey) ?? 0) > 1) return { agent, depth: 0, issue: "ambiguous" }
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
 * (`names` maps host:id to name); an unlisted parent is shown by a short id, never the full hash.
 */
const relationLabel = (
  agent: ConnectAgent,
  issue: ConnectLineageIssue | null,
  names: ReadonlyMap<string, string>
): ReactNode => {
  const parentAgentId = agent.relationship?.parentAgentId
  const parentName =
    parentAgentId === undefined
      ? undefined
      : (names.get(`${agent.host.toLowerCase()}:${parentAgentId}`) ?? shortAgentId(parentAgentId))
  const parent = parentName === undefined ? undefined : <span className="connect-token">{parentName}</span>
  if (issue !== null) return "Relationship unresolved"
  if (agent.relationship === undefined || parent === undefined) return "Primary"
  return (
    <>
      {connectRelationLabel(agent.relationship.relation)} of {parent}
    </>
  )
}

/** A recorded lineage problem, distinct from metadata and never a claim that its edge is valid. */
const lineageIssueLabel = (
  agent: ConnectAgent,
  issue: ConnectLineageIssue,
  agents: ReadonlyArray<ConnectAgent>
): ReactNode => {
  if (issue === "cycle") return "Cyclic relationship"
  if (issue === "ambiguous") return "Ambiguous ownership"
  const parentId = agent.relationship?.parentAgentId
  if (parentId === undefined) return "Malformed relationship"
  const parents = agents.filter((candidate) => candidate.id === parentId)
  const parent = parents.length === 1 ? parents[0] : undefined
  return (
    <>
      {issue === "unknown_parent" ? "Unknown parent" : "Cross-host parent"}{" "}
      <span className="connect-token">{parent?.name ?? shortAgentId(parentId)}</span>
      {issue === "cross_host" && parent !== undefined ? ` on ${parent.host}` : null}
    </>
  )
}

/** Forced colours replace the creature’s colour cues with the shared static state glyph. */
export const AgentStateGlyph = ({ state }: { readonly state: string }) => (
  <span aria-hidden="true" className="connect-creature-state" data-tone={agentStatePresentation(state).tone}>
    <Icon decorative name={agentStatePresentation(state).icon} size="small" />
  </span>
)

/** Words for recorded relationships, shared by rows and the stage. */
export const connectRelationLabel = (relation: NonNullable<ConnectAgent["relationship"]>["relation"]): string =>
  relation === "pair" ? "Pair partner" : relation === "review" ? "Reviewer" : "Worker"

export interface ConnectAgentFamily {
  readonly key: string
  readonly rows: ReadonlyArray<ConnectLineageRow>
  readonly missingParent?: { readonly host: string; readonly id: string }
}

/** Keeps validated ancestry together, with families needing attention first. Invalid edges stay standalone. */
export const connectAgentFamilies = (agents: ReadonlyArray<ConnectAgent>): ReadonlyArray<ConnectAgentFamily> => {
  const families: Array<{ key: string; rows: Array<ConnectLineageRow>; missingParent?: { host: string; id: string } }> =
    []
  const occurrences = new Map<string, number>()
  for (const row of connectLineageRows(agents)) {
    // Only direct siblings of an absent same-host parent share this group. Invalid known edges never attach.
    const parentId = row.agent.relationship?.parentAgentId
    if (row.issue === "unknown_parent" && row.depth === 0 && parentId !== undefined) {
      const key = `missing:${row.agent.host.toLowerCase()}:${parentId}`
      const group = families.find((family) => family.key === key)
      if (group === undefined)
        families.push({ key, rows: [row], missingParent: { host: row.agent.host, id: parentId } })
      else group.rows.push(row)
      continue
    }
    const last = families.at(-1)
    if (row.depth > 0 && row.issue === null && last !== undefined) {
      last.rows.push(row)
    } else {
      const key = connectAgentKey(row.agent)
      const occurrence = occurrences.get(key) ?? 0
      occurrences.set(key, occurrence + 1)
      families.push({ key: `${key}:${String(occurrence)}`, rows: [row] })
    }
  }
  const needsYou = (family: ConnectAgentFamily): boolean =>
    family.missingParent !== undefined ||
    family.rows.some(({ agent }) => agentStatePresentation(agent.state).bucket === "needs-you")
  return families.toSorted(
    (left, right) =>
      Number(right.missingParent !== undefined) - Number(left.missingParent !== undefined) ||
      Number(needsYou(right)) - Number(needsYou(left)) ||
      naturalOrder.compare(left.key, right.key)
  )
}

/** A filtered child brings its ancestors as context; unrelated siblings do not become matches. */
const filterFamily = (family: ConnectAgentFamily, filters: AgentFilters) => {
  const matches = new Set(
    family.rows
      .filter(
        ({ agent }) =>
          matchesQuery(agent, filters.query) &&
          (filters.host === null || filters.host === agent.host) &&
          (filters.activity === "all" || agentStatePresentation(agent.state).bucket === filters.activity)
      )
      .map(({ agent }) => connectAgentKey(agent))
  )
  const included = new Set(matches)
  for (const row of family.rows) {
    if (!matches.has(connectAgentKey(row.agent))) continue
    let current = row.agent
    while (current.relationship !== undefined && row.issue === null) {
      const parent = family.rows.find(
        ({ agent }) =>
          agent.host.toLowerCase() === current.host.toLowerCase() && agent.id === current.relationship?.parentAgentId
      )?.agent
      if (parent === undefined) break
      included.add(connectAgentKey(parent))
      current = parent
    }
  }
  return { ...family, matches, rows: family.rows.filter(({ agent }) => included.has(connectAgentKey(agent))) }
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
  readonly search?: ReactNode
  readonly onClearQuery?: () => void
  /** The directory couldn't refresh: its agents show their last known state, without life. */
  readonly stale?: boolean
  /** Agents that started needing you on this poll, by `connectAgentKey`. */
  readonly arrivals?: ReadonlySet<string>
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
export const silentHostsSentence = (
  failures: ReadonlyArray<ConnectPeerFailure>,
  retainedHosts: ReadonlyArray<string> = []
): string | null => {
  if (failures.length === 0) return null
  const named = failures.map(({ host, reason }) => `${host} (${failureReasonLabel(reason)})`).join(", ")
  if (failures.every(({ host }) => retainedHosts.includes(host))) {
    return `${named} didn't answer; ${failures.length === 1 ? "its readings are" : "their readings are"} old.`
  }
  return failures.length === 1
    ? `${named} didn't answer; its agents aren't listed.`
    : `${named} didn't answer; their agents aren't listed.`
}

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

/**
 * The title's attention count; total agents and families belong to the list below.
 * Hosts that didn't answer are named once above the list. The separator is decorative CSS.
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
  return (
    <span
      aria-label="Connect summary"
      className="connect-attention-count"
      data-attention={agents !== null && needAttention > 0 ? "" : undefined}
    >
      {agents === null ? (
        unavailable ? (
          "The fleet directory didn't answer"
        ) : (
          "Loading the fleet…"
        )
      ) : needAttention === 0 ? null : (
        <>
          {" "}
          <HeroWord tone="held">{`${String(needAttention)} need${needAttention === 1 ? "s" : ""} you`}</HeroWord>
        </>
      )}
    </span>
  )
}

export const AgentDirectory = ({
  activityFilter,
  agents,
  arrivals = new Set(),
  hostFilter,
  onActivityFilter,
  onClearQuery,
  onHostFilter,
  onSelect,
  query,
  search,
  selectedKey,
  silentHosts = [],
  stale = false,
  timeZone
}: AgentDirectoryProps) => {
  const hostFilterLabelId = useId()
  const statusFilterLabelId = useId()
  const filtersId = useId()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const hosts = connectAgentHosts(agents)
  const names = new Map(agents.map((entry) => [`${entry.host.toLowerCase()}:${entry.id}`, entry.name]))
  const counts = agentBucketCounts(agents, hostFilter)
  const filterCount = Number(hostFilter !== null) + Number(activityFilter !== "all")
  const scoped = filterCount > 0 || query.trim().length > 0
  const families = connectAgentFamilies(agents)
    .map((family) => filterFamily(family, { activity: activityFilter, host: hostFilter, query }))
    .filter((family) => family.matches.size > 0)
  const matchingCount = families.reduce((total, family) => total + family.matches.size, 0)
  const clear = (): void => {
    onHostFilter(null)
    onActivityFilter("all")
    onClearQuery?.()
  }
  return (
    <>
      <div className="connect-directory-toolbar">
        {search}
        <button
          aria-controls={filtersId}
          aria-expanded={filtersOpen}
          className="connect-filters-toggle"
          onClick={() => setFiltersOpen(!filtersOpen)}
          type="button"
        >
          Filters{filterCount === 0 ? "" : ` ${String(filterCount)}`}
        </button>
      </div>
      <p className="connect-filter-summary">
        <span>{hostFilter ?? "All hosts"}</span>
        <span>{activityFilter === "all" ? "All states" : activityFilterLabel(activityFilter)}</span>
        {scoped ? (
          <>
            {" "}
            <span>{plural(matchingCount, "matching agent", "matching agents")}</span>{" "}
            <button className="connect-filters-clear" onClick={clear} type="button">
              Clear filters
            </button>
          </>
        ) : null}
      </p>
      <div className="connect-filter-row" hidden={!filtersOpen} id={filtersId}>
        <div className="connect-filter-set">
          <span className="connect-filter-label" id={hostFilterLabelId}>
            Host
          </span>
          <div aria-labelledby={hostFilterLabelId} className="connect-group-filter" role="group">
            <button aria-pressed={hostFilter === null} onClick={() => onHostFilter(null)} type="button">
              All hosts
            </button>
            {hosts.map((host) => (
              <button
                aria-pressed={hostFilter === host}
                key={host}
                onClick={() => onHostFilter(host)}
                title={host}
                type="button"
              >
                {host}
              </button>
            ))}
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
        {families.length === 0 ? (
          <div className="connect-empty">
            <Text tone="secondary">No agents match “{query.trim()}”.</Text>
            <button className="connect-filters-clear" onClick={clear} type="button">
              Clear filters
            </button>
          </div>
        ) : (
          <p className="connect-family-count">
            {plural(matchingCount, "agent", "agents")} in {plural(families.length, "family", "families")}
          </p>
        )}
        <div className="connect-agent-list">
          {families.map((family) => {
            const shown = new Set(
              family.rows
                .filter(
                  (row, index) =>
                    expanded.has(family.key) ||
                    index <= 2 ||
                    row.depth > 2 ||
                    scoped ||
                    agentStatePresentation(row.agent.state).bucket === "needs-you"
                )
                .map(({ agent }) => connectAgentKey(agent))
            )
            // A visible descendant keeps the ancestry that makes its place in this family readable.
            for (const row of family.rows) {
              if (!shown.has(connectAgentKey(row.agent))) continue
              let current = row.agent
              while (current.relationship !== undefined && row.issue === null) {
                const parent = family.rows.find(({ agent }) => agent.id === current.relationship?.parentAgentId)?.agent
                if (parent === undefined) break
                shown.add(connectAgentKey(parent))
                current = parent
              }
            }
            const hiddenCount = family.rows.filter(({ agent }) => !shown.has(connectAgentKey(agent))).length
            return (
              <section
                aria-label={`${family.rows[0]?.agent.name ?? "Agent"} family`}
                className="connect-family"
                key={family.key}
              >
                {family.missingParent === undefined ? null : (
                  <div className="connect-family-missing">
                    <span>
                      <Icon decorative name="alert" size="small" /> Primary not listed
                    </span>
                    <p>
                      {shortAgentId(family.missingParent.id)} on {family.missingParent.host} isn't in the directory; its
                      children are shown here.
                    </p>
                  </div>
                )}
                {family.rows
                  .filter(({ agent }) => shown.has(connectAgentKey(agent)))
                  .map(({ agent, depth, issue }) => {
                    const key = connectAgentKey(agent)
                    const activity = agentStatePresentation(agent.state).bucket
                    const context = !family.matches.has(key)
                    const ambiguousIdentity = connectAgentIdentityAmbiguous(agents, agent)
                    return (
                      <Fragment key={key}>
                        <button
                          aria-pressed={selectedKey === key}
                          className="connect-agent"
                          data-activity={activity}
                          data-agent-key={key}
                          data-context={context ? "true" : undefined}
                          data-depth={String(
                            family.missingParent !== undefined ? 1 : issue === null ? Math.min(depth, 2) : 0
                          )}
                          data-lineage-issue={issue ?? "none"}
                          data-selected={selectedKey === key}
                          disabled={ambiguousIdentity}
                          key={key}
                          onClick={() => onSelect(agent)}
                          type="button"
                        >
                          <Creature
                            arrived={arrivals.has(key)}
                            host={agent.host}
                            id={String(agent.id)}
                            size="row"
                            stale={stale || silentHosts.includes(agent.host)}
                            state={agent.state}
                          />
                          <AgentStateGlyph state={agent.state} />
                          <span className="connect-visually-hidden">{agentStatePresentation(agent.state).word}, </span>
                          <span className="connect-agent-copy">
                            <Text as="strong" variant="label">
                              {agent.name}
                            </Text>
                            <span className="connect-agent-work">{agent.work}</span>
                            <Text as="small" variant="meta" tone="secondary">
                              {relationLabel(agent, family.missingParent === undefined ? issue : null, names)}
                              {hosts.length > 1 ? (
                                <>
                                  {agent.relationship === undefined ? (
                                    " on "
                                  ) : (
                                    <span aria-hidden="true" className="connect-row-separator" />
                                  )}
                                  <span className="connect-token">{agent.host}</span>
                                </>
                              ) : null}
                              <span aria-hidden="true" className="connect-row-separator" />
                              <time dateTime={new Date(agent.lastActivityAt).toISOString()}>
                                <span className="connect-visually-hidden"> last active at </span>
                                {timeLabel(agent.lastActivityAt, timeZone)}
                              </time>
                              {context ? ", context" : ""}
                              {stale || silentHosts.includes(agent.host) ? ", Old reading" : ""}
                            </Text>
                            {issue === null && !ambiguousIdentity ? null : (
                              <span className="connect-agent-issue" data-tone="caution">
                                <Icon decorative name="alert" size="small" />
                                <span>
                                  {issue === null ? null : lineageIssueLabel(agent, issue, agents)}
                                  {ambiguousIdentity
                                    ? ". Can't open: this host lists the same agent identity more than once."
                                    : ""}
                                </span>
                              </span>
                            )}
                          </span>
                          <span className="connect-visually-hidden">, open stage</span>
                        </button>
                        {depth <= 2 || issue !== null ? null : (
                          <button
                            className="connect-deep-parent"
                            type="button"
                            onClick={() => {
                              const parent = family.rows.find(
                                ({ agent: candidate }) => candidate.id === agent.relationship?.parentAgentId
                              )?.agent
                              if (parent !== undefined) onSelect(parent)
                            }}
                          >
                            Nested deeper: open{" "}
                            {names.get(`${agent.host.toLowerCase()}:${agent.relationship?.parentAgentId}`)} →
                          </button>
                        )}
                      </Fragment>
                    )
                  })}
                {hiddenCount === 0 ? null : (
                  <button
                    className="connect-family-more"
                    onClick={() => setExpanded(new Set([...expanded, family.key]))}
                    type="button"
                  >
                    Show {String(hiddenCount)} more
                  </button>
                )}
              </section>
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
  readonly modifier: TerminalModifiers
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
  /** The terminal's text input holds focus, so a touch keyboard is up. */
  readonly keyboardOpen?: boolean
  /** Offers a pinned Keyboard toggle when given; it must focus or blur within the click. */
  readonly onKeyboardToggle?: (open: boolean) => void
  /** Offers a pinned Paste action when given; it must start reading the clipboard within the click. */
  readonly onPaste?: () => void
}

const modifierLabel = (modifier: TerminalModifier): string =>
  modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"

/** A fixed, keyboard-accessible set of terminal controls for touch layouts. */
export const TerminalKeyRail = ({
  disabled = false,
  error = null,
  keyboardOpen = false,
  keysHidden = false,
  linesBack = 0,
  modifier,
  onFocusTerminal,
  onJumpToLatest,
  onKey,
  onKeyboardToggle,
  onKeysHiddenChange,
  onModifierChange,
  onPaste,
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
    readonly pressed?: boolean
  }> = [
    ...(onKeyboardToggle === undefined
      ? []
      : [
          {
            key: "keyboard",
            label: "Keyboard",
            ariaLabel: "Keyboard",
            onClick: () => onKeyboardToggle(!keyboardOpen),
            pressed: keyboardOpen
          }
        ]),
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
    ...(onPaste === undefined
      ? []
      : [{ key: "paste", label: "Paste", ariaLabel: "Paste from clipboard", onClick: onPaste }]),
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
              aria-pressed={terminalModifierIsActive(modifier, item)}
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
                aria-label={[
                  ...terminalModifiers.filter((item) => terminalModifierIsActive(modifier, item)).map(modifierLabel),
                  descriptor.ariaLabel
                ].join(" ")}
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
                aria-pressed={action.pressed}
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
