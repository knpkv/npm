import { Button, StateLabel, Surface, Text } from "@knpkv/rly/primitives"
import { requiresApproval, type JobRecord, type JobStatus } from "@knpkv/herdr-fleet/model"
import { Predicate } from "effect"
import { useMemo, useState, type KeyboardEvent, type ReactElement } from "react"

export type ActivityFilter = "all" | "exceptions" | "work" | "approvals" | "deployments" | "human" | "agent"

export type ActivityItem = {
  readonly actor: string
  readonly categories: ReadonlyArray<Exclude<ActivityFilter, "all">>
  readonly connectHref: string | null
  readonly connectLabel: string | null
  readonly dateKey: string
  readonly dateLabel: string
  readonly details: ReadonlyArray<string>
  readonly id: string
  readonly searchText: string
  readonly status: JobStatus
  readonly summary: string
  readonly time: string
  readonly timestamp: number
  readonly title: string
}

type ActivityFilterOption = {
  readonly label: string
  readonly value: ActivityFilter
}

const filterOptions: ReadonlyArray<ActivityFilterOption> = [
  { label: "All", value: "all" },
  { label: "Exceptions", value: "exceptions" },
  { label: "Work", value: "work" },
  { label: "Approvals", value: "approvals" },
  { label: "Deployments", value: "deployments" },
  { label: "Human", value: "human" },
  { label: "Agent", value: "agent" }
]

const pageSize = 24

export const statusLabel = (status: JobStatus): string => {
  switch (status) {
    case "pending_approval":
      return "Waiting"
    case "queued":
      return "Queued"
    case "running":
      return "Running"
    case "succeeded":
      return "Completed"
    case "failed":
      return "Failed"
    case "interrupted":
      return "Interrupted"
    case "rejected":
      return "Rejected"
    case "expired":
      return "Expired"
  }
}

export const statusTone = (status: JobStatus): "neutral" | "positive" | "critical" | "caution" | "progress" => {
  switch (status) {
    case "succeeded":
      return "positive"
    case "failed":
    case "rejected":
      return "critical"
    case "interrupted":
      return "neutral"
    case "pending_approval":
    case "expired":
      return "caution"
    case "queued":
    case "running":
      return "progress"
  }
}

export const jobTitle = (record: Pick<JobRecord, "payload">): string => {
  switch (record.payload.kind) {
    case "browser.mcp.recover":
      return "Recover browser MCP"
    case "nix.check":
      return "Check Nix configuration"
    case "nix.apply":
      return "Apply Nix configuration"
    case "agent.delegate":
      return record.payload.mode === "consult" ? "Ask the coordinator" : "Delegate agent work"
    case "agent.message":
      return "Message an agent"
  }
}

const safeSummary = (record: JobRecord): string => {
  switch (record.payload.kind) {
    case "browser.mcp.recover":
      return "Checked the configured Chrome DevTools MCP runtime."
    case "nix.check":
      return "Validated the repository configuration."
    case "nix.apply":
      return "Processed a requested configuration deployment."
    case "agent.delegate":
      return record.worker === undefined
        ? record.payload.mode === "consult"
          ? "Asked the persistent coordinator for an answer."
          : "Assigned typed work through the persistent coordinator."
        : `Started ${record.worker.name} through the persistent coordinator.`
    case "agent.message":
      return `Sent a typed message to ${record.payload.session}.`
  }
}

const isException = (status: JobStatus): boolean =>
  status === "failed" || status === "interrupted" || status === "rejected" || status === "expired"

const categoriesFor = (record: JobRecord): ReadonlyArray<Exclude<ActivityFilter, "all">> => {
  const categories: Array<Exclude<ActivityFilter, "all">> = []
  if (isException(record.status)) categories.push("exceptions")
  if (record.payload.kind.startsWith("agent.")) categories.push("work", "agent")
  if (requiresApproval(record.payload)) categories.push("approvals")
  if (
    record.payload.kind === "nix.apply" ||
    record.payload.kind === "nix.check" ||
    record.payload.kind === "browser.mcp.recover"
  ) {
    categories.push("deployments")
  }
  if (record.approvedBy !== null || record.rejectedBy !== null) categories.push("human")
  return categories
}

const iso = (timestamp: number): string => new Date(timestamp).toISOString()

const dateKey = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(timestamp)

const dateLabel = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full"
  }).format(timestamp)

const timeLabel = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp)

const evidenceFor = (record: JobRecord): ReadonlyArray<string> => {
  const evidence = [`Status: ${statusLabel(record.status)}`, `Submitted by ${record.actor}`]
  if (record.approvedBy !== null) evidence.push(`Approved by ${record.approvedBy}`)
  if (record.rejectedBy !== null) evidence.push(`Rejected by ${record.rejectedBy}`)
  if (record.worker !== undefined) evidence.push(`Worker: ${record.worker.name} on ${record.worker.host}`)
  if (record.status === "expired") evidence.push("The approval window expired before execution.")
  if (record.status === "interrupted") evidence.push("The job stopped before a terminal result was recorded.")
  if (record.status === "failed") evidence.push("The operation returned a typed failure. Open the agent for details.")
  return evidence
}

export const activityItemsFor = (records: ReadonlyArray<JobRecord>): ReadonlyArray<ActivityItem> =>
  records
    .map((record): ActivityItem => {
      const categories = categoriesFor(record)
      const title = jobTitle(record)
      const summary = safeSummary(record)
      const workerName = record.worker?.name ?? ""
      const searchable = [title, summary, statusLabel(record.status), record.actor, workerName, ...categories]
        .join(" ")
        .toLocaleLowerCase()
      return {
        actor: record.actor,
        categories,
        connectHref: record.connectTarget?.url ?? null,
        connectLabel: record.worker === undefined ? null : `Open ${record.worker.name} in Connect`,
        dateKey: dateKey(record.updatedAt),
        dateLabel: dateLabel(record.updatedAt),
        details: evidenceFor(record),
        id: record.id,
        searchText: searchable,
        status: record.status,
        summary,
        time: timeLabel(record.updatedAt),
        timestamp: record.updatedAt,
        title
      }
    })
    .sort((left, right) => right.timestamp - left.timestamp)

export const filterActivityItems = (
  items: ReadonlyArray<ActivityItem>,
  filter: ActivityFilter,
  query: string
): ReadonlyArray<ActivityItem> => {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return items.filter(
    (item) =>
      (filter === "all" || item.categories.includes(filter)) &&
      (normalizedQuery === "" || item.searchText.includes(normalizedQuery))
  )
}

export const activityNavigationIndex = ({
  current,
  key,
  total
}: {
  readonly current: number
  readonly key: string
  readonly total: number
}): number | null => {
  if (total === 0) return null
  if (key === "Home") return 0
  if (key === "End") return total - 1
  if (key === "j" || key === "ArrowDown") return current < 0 ? 0 : Math.min(current + 1, total - 1)
  if (key === "k" || key === "ArrowUp") return current < 0 ? total - 1 : Math.max(current - 1, 0)
  return null
}

const ActivityRow = ({
  expanded,
  item,
  onToggle
}: {
  readonly expanded: boolean
  readonly item: ActivityItem
  readonly onToggle: () => void
}): ReactElement => {
  const detailId = `activity-detail-${item.id}`
  return (
    <li className="activity-item">
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className="activity-row"
        data-activity-row=""
        onClick={onToggle}
        type="button"
      >
        <time dateTime={iso(item.timestamp)}>{item.time}</time>
        <span className="activity-status">
          <StateLabel label={statusLabel(item.status)} size="compact" tone={statusTone(item.status)} />
        </span>
        <span className="activity-row-copy">
          <Text as="strong" variant="label">
            {item.title}
          </Text>
          <Text as="small" tone="secondary" variant="meta">
            {item.summary}
          </Text>
        </span>
        <Text as="small" className="activity-actor" tone="secondary" variant="meta">
          {item.actor}
        </Text>
        <span aria-hidden="true" className="activity-disclosure">
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded ? (
        <div className="activity-detail" id={detailId} role="region" aria-label={`${item.title} details`}>
          <ul>
            {item.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
          {item.connectHref === null || item.connectLabel === null ? null : (
            <a href={item.connectHref}>{item.connectLabel} →</a>
          )}
        </div>
      ) : null}
    </li>
  )
}

export const ActivityHistory = ({ records }: { readonly records: ReadonlyArray<JobRecord> }): ReactElement => {
  const items = useMemo(() => activityItemsFor(records), [records])
  const [filter, setFilter] = useState<ActivityFilter>("all")
  const [query, setQuery] = useState("")
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const filtered = useMemo(() => filterActivityItems(items, filter, query), [filter, items, query])
  const visible = filtered.slice(0, visibleCount)
  const groups = new Map<string, Array<ActivityItem>>()
  for (const item of visible) {
    const group = groups.get(item.dateKey)
    if (group === undefined) groups.set(item.dateKey, [item])
    else group.push(item)
  }
  const handleKeyboard = (event: KeyboardEvent<HTMLElement>): void => {
    if (
      Predicate.hasProperty(event.target, "nodeName") &&
      Predicate.isString(event.target.nodeName) &&
      (event.target.nodeName === "INPUT" || event.target.nodeName === "TEXTAREA")
    )
      return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-activity-row]")]
    const current = rows.findIndex((row) => row === document.activeElement)
    const next = activityNavigationIndex({ current, key: event.key, total: rows.length })
    if (next === null) return
    event.preventDefault()
    rows[next]?.focus()
  }
  return (
    <Surface as="section" padding="spacious" className="history-panel" onKeyDown={handleKeyboard}>
      <div className="section-heading">
        <div>
          <Text variant="meta" tone="secondary">
            Durable activity
          </Text>
          <Text as="h2" variant="section-title">
            Activity history
          </Text>
        </div>
        <Text variant="meta" tone="secondary">
          {visible.length} visible · {filtered.length} matching · {items.length} jobs
        </Text>
      </div>
      <div className="activity-toolbar">
        <label className="activity-search">
          <span>Search</span>
          <input
            aria-label="Search activity"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("")
                event.currentTarget.blur()
              } else if (event.key === "ArrowDown") {
                event.preventDefault()
                event.currentTarget.closest("section")?.querySelector<HTMLButtonElement>("[data-activity-row]")?.focus()
              }
            }}
            placeholder="Agent, status, or operation"
            type="search"
            value={query}
          />
        </label>
        <div className="activity-filters" aria-label="Filter activity">
          {filterOptions.map((option) => (
            <button
              aria-pressed={filter === option.value}
              key={option.value}
              onClick={() => {
                setFilter(option.value)
                setVisibleCount(pageSize)
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="activity-empty">
          <Text as="strong" variant="label">
            No matching activity
          </Text>
          <Text tone="secondary">Change the filter or clear the search.</Text>
        </div>
      ) : (
        [...groups.values()].map((group) => (
          <section className="day-group" key={group[0]?.dateKey ?? "unknown"}>
            <Text as="h3" variant="label" tone="secondary">
              {group[0]?.dateLabel ?? "Date unavailable"}
            </Text>
            <ol className="activity-list">
              {group.map((item) => (
                <ActivityRow
                  expanded={expandedId === item.id}
                  item={item}
                  key={item.id}
                  onToggle={() => setExpandedId((current) => (current === item.id ? null : item.id))}
                />
              ))}
            </ol>
          </section>
        ))
      )}
      {visible.length < filtered.length ? (
        <div className="activity-load-more">
          <Button onClick={() => setVisibleCount((count) => count + pageSize)} type="button" variant="quiet">
            {`Load earlier · ${String(filtered.length - visible.length)} remaining`}
          </Button>
        </div>
      ) : null}
      <Text as="p" className="activity-keyboard-help" tone="secondary" variant="meta">
        <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> details · <kbd>Esc</kbd> clear search
      </Text>
    </Surface>
  )
}
