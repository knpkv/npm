import { TimelineRow as RlyTimelineRow } from "@knpkv/rly/patterns"
import { Button, StatePanel, Text } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"
import { type ReactElement, useMemo, useState } from "react"
import { Link, useLocation } from "react-router"

import type { TimelineActorKind, TimelineEvent, TimelineSourceKind } from "../../domain/timeline.js"
import { browserReadableSessionKey, useBrowserSession } from "../BrowserSession.js"
import { contextualAgentPath } from "../contextualAgentPath.js"
import styles from "./TimelinePage.module.css"
import {
  browserTimelineTransport,
  formatTimelineTimestamp,
  type TimelineFilters,
  type TimelineTransport,
  useTimeline
} from "./useTimeline.js"

const actorOptions: ReadonlyArray<{ readonly label: string; readonly value: TimelineActorKind | "all" }> = [
  { label: "Everyone", value: "all" },
  { label: "People", value: "human" },
  { label: "Agents", value: "agent" },
  { label: "Services", value: "plugin" },
  { label: "System", value: "system" }
]
const timelineSources: ReadonlyArray<TimelineSourceKind> = ["action", "relationship", "plugin-sync", "system"]

const actorFilter = (value: string): TimelineFilters["actorKind"] =>
  actorOptions.find((option) => option.value === value)?.value ?? "all"

const sourcePresentation: Readonly<Record<TimelineSourceKind, { readonly label: string }>> = {
  action: { label: "Governed action" },
  "plugin-sync": { label: "Service sync" },
  relationship: { label: "Delivery link" },
  system: { label: "Control Center" }
}

const TimelineRow = ({
  continued,
  event
}: {
  readonly continued: boolean
  readonly event: TimelineEvent
}): ReactElement => (
  <RlyTimelineRow
    continued={continued}
    event={{
      actor: event.actor.label,
      actorKind: event.actor.kind,
      dateTime: DateTime.formatIso(event.occurredAt),
      detail: sourcePresentation[event.sourceKind].label,
      ...(event.href === null ? {} : { href: event.href }),
      id: event.eventKey,
      ...(event.service === null ? {} : { service: event.service }),
      time: formatTimelineTimestamp(event.occurredAt),
      title: event.title
    }}
  />
)

const SourceSummary = ({ events }: { readonly events: ReadonlyArray<TimelineEvent> }): ReactElement => {
  const totals = useMemo(
    () =>
      new Map<TimelineSourceKind, number>([
        ["action", events.filter(({ sourceKind }) => sourceKind === "action").length],
        ["relationship", events.filter(({ sourceKind }) => sourceKind === "relationship").length],
        ["plugin-sync", events.filter(({ sourceKind }) => sourceKind === "plugin-sync").length],
        ["system", events.filter(({ sourceKind }) => sourceKind === "system").length]
      ]),
    [events]
  )
  return (
    <dl className={styles.summary}>
      {timelineSources.map((source) => {
        return (
          <div data-source={source} key={source}>
            <dt>{sourcePresentation[source].label}</dt>
            <dd>{totals.get(source) ?? 0}</dd>
          </div>
        )
      })}
    </dl>
  )
}

/** Bird's-eye view of attributable human, agent, service, and system activity. */
export const TimelinePage = ({
  transport = browserTimelineTransport
}: { readonly transport?: TimelineTransport } = {}): ReactElement => {
  const location = useLocation()
  const browserSession = useBrowserSession()
  const sessionKey = browserReadableSessionKey(browserSession.state)
  const [filters, setFilters] = useState<TimelineFilters>({ actorKind: "all", from: "", to: "" })
  const controller = useTimeline(filters, sessionKey, browserSession.invalidateSession, transport)

  if (controller.state._tag === "idle" || controller.state._tag === "loading") {
    return (
      <StatePanel description="Combining durable activity across your connected services." title="Loading Timeline" />
    )
  }
  if (controller.state._tag === "failed") {
    return (
      <StatePanel
        action={<Button onClick={controller.retry}>Try again</Button>}
        description="The Timeline could not be read."
        title="Timeline unavailable"
      />
    )
  }
  const timelineState = controller.state

  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <Text as="p" tone="secondary" variant="label">
          Timeline
        </Text>
        <Text as="h1" variant="verdict">
          Everything
          <br />
          that moved.
        </Text>
        <Text className={styles.intro} tone="secondary" variant="body-large">
          One chronological truth across people, agents, code, delivery links, and connected services.
        </Text>
        <Link className={styles.askRelay} to={contextualAgentPath(location.pathname, location.search, location.hash)}>
          Ask Relay about this Timeline
        </Link>
      </header>

      <SourceSummary events={timelineState.events} />

      <section aria-label="Timeline filters" className={styles.filters}>
        <label>
          <span>Actor</span>
          <select
            value={filters.actorKind}
            onChange={(event) => setFilters({ ...filters, actorKind: actorFilter(event.currentTarget.value) })}
          >
            {actorOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>From</span>
          <input
            type="date"
            value={filters.from}
            onChange={(event) => setFilters({ ...filters, from: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => setFilters({ ...filters, to: event.currentTarget.value })}
          />
        </label>
      </section>

      {timelineState.events.length === 0 ? (
        <StatePanel description="Try a wider date range or another actor." title="No activity in this view" />
      ) : (
        <ol className={styles.events}>
          {timelineState.events.map((event, index) => (
            <TimelineRow continued={index < timelineState.events.length - 1} event={event} key={event.eventKey} />
          ))}
        </ol>
      )}
      {timelineState.nextCursor === null ? null : (
        <Button disabled={timelineState.isLoadingMore} onClick={controller.loadMore} size="principal" stretch>
          {timelineState.isLoadingMore ? "Loading…" : "Show earlier activity"}
        </Button>
      )}
    </article>
  )
}
