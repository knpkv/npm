/** Home groups the existing directory reading; selection and terminal authority remain with ConnectSurface. */
import { Button, StateLabel, Text } from "@knpkv/rly/primitives"
import { useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { AgentStateLabel } from "./agent-state.js"
import { connectAgentGroup, type ConnectAgentGroup } from "./agent-state-core.js"
import { Creature } from "./creature.js"
import type { AgentDirectory } from "./view.js"
import {
  AgentStateGlyph,
  connectAgentHosts,
  connectAgentIdentityAmbiguous,
  connectAgentKey,
  connectLineageRows,
  connectRelationLabel,
  matchesConnectAgent
} from "./view.js"

type HomeGroup = ConnectAgentGroup
export const connectHomePurpose = "Who’s working, who’s blocked, who needs you"
const groupOrder: ReadonlyArray<HomeGroup> = ["needs-you", "working", "ready", "finished", "unknown"]
const groupLabels = {
  "needs-you": "Needs you",
  working: "Working",
  ready: "Ready",
  finished: "Recently done",
  unknown: "Unknown"
} satisfies Record<HomeGroup, string>

/** Ready/idle retain their reported word; missing-host and unknown states never count as Needs you. */
export const ConnectHomeDirectory = ({
  activityFilter,
  agents,
  arrivals = new Set(),
  configuredHosts = [],
  empty,
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
}: ComponentProps<typeof AgentDirectory> & { readonly empty?: ReactNode }) => {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [focusSearch, setFocusSearch] = useState(false)
  useLayoutEffect(() => {
    if (!focusSearch || !filtersOpen || root.current?.closest('[hidden], [inert], [aria-hidden="true"]') !== null)
      return
    root.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
    setFocusSearch(false)
  }, [filtersOpen, focusSearch])
  const hosts = [...new Set([...configuredHosts, ...connectAgentHosts(agents), ...silentHosts])].toSorted(
    (left, right) => left.localeCompare(right, "en", { numeric: true })
  )
  const offline = (host: string): boolean => silentHosts.some((each) => each.toLowerCase() === host.toLowerCase())
  const groupOf = (state: string, host: string): HomeGroup =>
    connectAgentGroup(state, { presentation: "home", offline: offline(host) })
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US")
  const rows = connectLineageRows(agents).filter(({ agent }) =>
    matchesConnectAgent(
      agent,
      { host: hostFilter, activity: activityFilter, query },
      { presentation: "home", offline: offline(agent.host) }
    )
  )
  const scoped = normalizedQuery.length > 0 || hostFilter !== null || activityFilter !== "all"
  const occurrences = new Map<string, number>()
  const keyedRows = rows.map((row) => {
    const key = connectAgentKey(row.agent)
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    return { ...row, key: `${key}:${String(occurrence)}` }
  })
  const clear = (): void => {
    setFiltersOpen(true)
    setFocusSearch(true)
    onHostFilter(null)
    onActivityFilter("all")
    onClearQuery?.()
  }
  const readTime = (timestamp: number): string =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(timestamp)
  if (agents.length === 0 && !scoped && silentHosts.length === 0 && empty !== undefined) return <>{empty}</>
  return (
    <div className="connect-home-directory" ref={root}>
      <div className="connect-home-filter-row" data-connect-home-filters="" hidden={!filtersOpen} id={`${id}-filters`}>
        {search}
        <label>
          Host{" "}
          <select onChange={(event) => onHostFilter(event.currentTarget.value || null)} value={hostFilter ?? ""}>
            <option value="">All hosts</option>
            {hosts.map((host) => (
              <option key={host} value={host}>
                {host}
                {offline(host) ? " — didn't answer" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status{" "}
          <select
            onChange={(event) => {
              const next = groupOrder.find((group) => group === event.currentTarget.value)
              onActivityFilter(next === "unknown" || next === undefined ? "all" : next)
            }}
            value={activityFilter}
          >
            <option value="all">All states</option>
            {groupOrder
              .filter((group) => group !== "unknown")
              .map((group) => (
                <option key={group} value={group}>
                  {groupLabels[group]}
                </option>
              ))}
          </select>
        </label>
      </div>
      {scoped ? (
        <p className="connect-filter-summary">
          {hostFilter ?? "All hosts"}, {activityFilter === "all" ? "All states" : groupLabels[activityFilter]}
          {normalizedQuery.length === 0 ? null : `, “${query.trim()}”`}
          <Button className="connect-scope-clear" onClick={clear} size="compact" variant="quiet">
            Clear
          </Button>
        </p>
      ) : null}
      {groupOrder.map((group) => {
        const grouped = keyedRows.filter(({ agent }) => groupOf(agent.state, agent.host) === group)
        if (group !== "needs-you" && grouped.length === 0) return null
        const unknownHosts = [
          ...new Set(grouped.filter(({ agent }) => offline(agent.host)).map(({ agent }) => agent.host))
        ]
        const label =
          group === "unknown" && unknownHosts.length > 0
            ? `Unknown, ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(unknownHosts)} not answering`
            : groupLabels[group]
        return (
          <section
            aria-labelledby={`${id}-${group}`}
            className="connect-home-group"
            data-home-group={group}
            key={group}
          >
            <header className="connect-home-group-heading">
              <h2 id={`${id}-${group}`}>
                {label} <span>{String(grouped.length)}</span>
              </h2>
              {group !== "needs-you" ? null : (
                <button
                  aria-controls={`${id}-filters`}
                  aria-expanded={filtersOpen}
                  className="connect-filters-toggle connect-home-tap"
                  data-connect-search-reveal=""
                  onClick={() => setFiltersOpen(!filtersOpen)}
                  type="button"
                >
                  Filters
                </button>
              )}
            </header>
            <div className="connect-home-cards">
              {grouped.map(({ agent, issue, key: rowKey }) => {
                const key = connectAgentKey(agent)
                const hostSilent = offline(agent.host)
                const old = stale || hostSilent
                const parent = agents.find(
                  (candidate) =>
                    candidate.host.toLowerCase() === agent.host.toLowerCase() &&
                    candidate.id === agent.relationship?.parentAgentId
                )
                return (
                  <button
                    aria-pressed={selectedKey === key}
                    className="connect-agent connect-home-agent"
                    data-agent-key={key}
                    data-lineage-issue={issue ?? "none"}
                    disabled={connectAgentIdentityAmbiguous(agents, agent)}
                    key={rowKey}
                    onClick={() => onSelect(agent)}
                    type="button"
                  >
                    <Creature
                      arrived={arrivals.has(key)}
                      host={agent.host}
                      hueFamily={agent.hue}
                      id={String(agent.id)}
                      name={agent.name}
                      size="row"
                      stale={old}
                      state={agent.state}
                      statePolicy="home"
                    />
                    <AgentStateGlyph state={agent.state} />
                    <span className="connect-agent-copy">
                      <span className="connect-home-agent-title">
                        <Text as="strong" variant="label">
                          {agent.name}
                        </Text>
                        <span data-home-state="">
                          {hostSilent ? (
                            <StateLabel icon="minus" label="Unknown" tone="neutral" size="compact" />
                          ) : (
                            <AgentStateLabel state={agent.state} statePolicy="home" />
                          )}
                        </span>
                      </span>
                      <Text as="small" tone="secondary" variant="meta">
                        {issue !== null ? (
                          "Relationship unresolved"
                        ) : agent.relationship === undefined ? (
                          "Primary"
                        ) : (
                          <>
                            {connectRelationLabel(agent.relationship.relation)}
                            {parent === undefined ? null : ` with ${parent.name}`}
                          </>
                        )}
                        {`, ${agent.host}`}
                      </Text>
                      {group === "ready" ? (
                        <span>
                          Idle since{" "}
                          <time dateTime={new Date(agent.lastActivityAt).toISOString()}>
                            {readTime(agent.lastActivityAt)}
                          </time>
                        </span>
                      ) : (
                        <>
                          {group !== "finished" && !hostSilent ? null : (
                            <span className="connect-home-last-activity">
                              Last activity{" "}
                              <time dateTime={new Date(agent.lastActivityAt).toISOString()}>
                                {readTime(agent.lastActivityAt)}
                              </time>
                            </span>
                          )}
                          <span className="connect-agent-work">{agent.voice?.text ?? agent.work}</span>
                        </>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
      {rows.length !== 0 ? null : (
        <div className="connect-empty">
          <Text as="p">
            {scoped
              ? "No agents match these filters."
              : silentHosts.length > 0
                ? "The hosts that answered have no agents. Other hosts are unknown."
                : "No agents running on any host."}
          </Text>
          {scoped ? (
            <Button onClick={clear} variant="secondary">
              Clear filters
            </Button>
          ) : configuredHosts.length === 0 ? null : (
            <Text as="p" tone="secondary">
              Start an agent on{" "}
              {new Intl.ListFormat("en", { style: "long", type: "disjunction" }).format(configuredHosts)} and it appears
              here.
            </Text>
          )}
        </div>
      )}
    </div>
  )
}
