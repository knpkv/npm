/**
 * The hub's Usage tab: the range switch, each host's "Limits now" cards, the fleet's tokens per day
 * (or hour) stacked by agent and model, and each host's limits over the range. Renders the views
 * {@link connectLimitsView} and {@link usageTabView} build; reads no clock.
 *
 * @module
 */
import { LimitsSummary } from "@knpkv/agent-usage/limits"
import {
  assignSlots,
  LimitChart,
  OTHER,
  seriesColor,
  stackSeries,
  TokenUsageChart,
  type UsagePreset
} from "@knpkv/agent-usage/usage"
import { Skeleton, Text, ToggleGroup } from "@knpkv/rly/primitives"
import { type ReactElement, useId, useMemo, useRef } from "react"
import type { LimitsState, UsageState } from "./fleet-reads-client.js"

export const USAGE_RANGES: ReadonlyArray<UsagePreset> = ["24h", "7d", "30d"]

const rangeLabel = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" } satisfies Record<UsagePreset, string>

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** agent-usage's own page on its default port: loopback only, so only a browser on that machine can open it. */
export const AGENT_USAGE_PAGE = "http://127.0.0.1:3112/"

export interface UsageTabProps {
  /** The page is open on the hub's own machine, where agent-usage's loopback page can be reached. */
  readonly onHubMachine: boolean
  readonly range: UsagePreset
  readonly onRangeChange: (range: UsagePreset) => void
  readonly limits: LimitsState
  readonly usage: UsageState
}

export const UsageTab = ({ limits, onHubMachine, onRangeChange, range, usage }: UsageTabProps): ReactElement => {
  const headingId = useId()
  const tokensId = useId()
  const historyId = useId()
  const view = usage.view
  const slotsRef = useRef<ReadonlyMap<string, number>>(new Map())
  const stacked = useMemo(() => (view === null ? null : stackSeries(view.periods.length, view.cells, null)), [view])
  const slots = useMemo(() => {
    // Other takes its own neutral colour, not a slot; a model keeps its colour while it stays on screen.
    const next = assignSlots(
      slotsRef.current,
      stacked?.series.map((series) => series.id).filter((id) => id !== OTHER) ?? []
    )
    slotsRef.current = next
    return next
  }, [stacked])
  const labelOf = (id: string) => view?.labels.get(id) ?? "Other models"
  const severalHosts = (limits.view?.hosts.length ?? 0) > 1
  const bucket = view?.range?.bucket === "hour" ? "hour" : "day"
  return (
    <section aria-labelledby={headingId} className="usage-tab">
      <header className="usage-tab-header">
        <Text as="h1" id={headingId} variant="card-title">
          Usage
        </Text>
        <ToggleGroup
          aria-label="Range"
          items={USAGE_RANGES.map((value) => ({ value, label: value }))}
          onValueChange={(value) => {
            const next = USAGE_RANGES.find((candidate) => candidate === value)
            if (next !== undefined) onRangeChange(next)
          }}
          size="compact"
          value={range}
        />
        {onHubMachine ? (
          <a className="usage-tab-full" href={AGENT_USAGE_PAGE} rel="noreferrer" target="_blank">
            Open agent-usage on this machine
          </a>
        ) : null}
      </header>

      {/* Which hosts are missing or partial, before anything is read as the whole fleet. */}
      {view === null || view.notes.length === 0 ? null : (
        <ul className="usage-tab-notes">
          {view.notes.map((note) => (
            <li key={note}>
              <Text as="span" tone="secondary" variant="meta">
                {note}
              </Text>
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Limits now" className="usage-tab-now">
        {limits.problem === null ? null : (
          <Text as="p" tone="secondary" variant="meta">
            {limits.problem}
          </Text>
        )}
        {limits.view === null ? (
          limits.problem === null ? (
            <Skeleton decorative={false} height="9rem" label="Loading limits" variant="block" />
          ) : null
        ) : (
          limits.view.hosts.map((host) => (
            <LimitsSummary
              balances={[]}
              key={host.host}
              latest={host.latest}
              now={host.now}
              title={severalHosts ? `Limits on ${host.host}` : "Limits now"}
            />
          ))
        )}
        {limits.view === null || limits.view.notes.length === 0 ? null : (
          <ul className="usage-tab-notes">
            {limits.view.notes.map((note) => (
              <li key={note}>
                <Text as="span" tone="secondary" variant="meta">
                  {note}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={tokensId} className="usage-tab-panel">
        <div className="usage-tab-panel-head">
          <Text as="h2" id={tokensId} variant="card-title">
            Tokens
          </Text>
          {view === null ? null : (
            <Text tone="secondary" variant="meta">
              {compact.format(view.totalTokens)} tokens in the last {rangeLabel[range]}
            </Text>
          )}
        </div>
        {usage.problem === null ? null : (
          <Text as="p" tone="secondary" variant="meta">
            {usage.problem}
          </Text>
        )}
        {view === null || stacked === null || view.range === null ? (
          usage.problem === null ? (
            <Skeleton decorative={false} height="16rem" label="Loading usage" variant="block" />
          ) : null
        ) : stacked.columns.every((column) => column.total === 0) ? (
          <p className="usage-empty">No tokens in this range.</p>
        ) : (
          <>
            <TokenUsageChart
              label={`Tokens per ${bucket}, stacked by model`}
              labelOf={labelOf}
              periods={view.periods}
              range={view.range}
              slots={slots}
              stacked={stacked}
            />
            <ul aria-label="Models in the chart" className="usage-legend">
              {stacked.series.map((series) => (
                <li key={series.id}>
                  <span
                    aria-hidden="true"
                    className="usage-swatch"
                    style={{ background: seriesColor(series.id, slots) }}
                  />
                  {labelOf(series.id)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* Each host's history needs a read; until one arrives the token panel says why there is none. */}
      {view === null ? null : (
        <section aria-labelledby={historyId} className="usage-tab-panel">
          <Text as="h2" id={historyId} variant="card-title">
            Limits over time
          </Text>
          {view.hosts.map((host) => (
            <div className="usage-tab-host" key={host.host}>
              {view.hosts.length > 1 ? (
                <Text as="h3" variant="label">
                  {host.host}
                </Text>
              ) : null}
              <LimitChart now={host.now} range={host.range} series={host.series} />
            </div>
          ))}
        </section>
      )}
    </section>
  )
}
