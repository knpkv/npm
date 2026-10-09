/**
 * The usage page: the limits as they stand now, then range and filters, usage stacked by Booking
 * with its total, limits on the same time axis beneath it, the Booking table, and the ingest status.
 *
 * @module
 */
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { PortalProvider, ThemeProvider } from "@knpkv/rly/foundations"
import { Button, Skeleton, StatePanel, Text, ToggleGroup } from "@knpkv/rly/primitives"
import { Effect } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import { bootstrapSession } from "./api.js"
import {
  agentAtom,
  limitsAtom,
  measureAtom,
  presetAtom,
  selectedAtom,
  statusAtom,
  timeZone,
  usageAtom
} from "./atoms.js"
import { BookingTable } from "./BookingTable.js"
import { assignSlots, bookingLabel, type Measure, OTHER, rangeTotal, stackUsage } from "../usage/chartModel.js"
import { formatTokens } from "../limits/format.js"
import { LimitChart } from "../usage/LimitChart.js"
import { LimitsSummary } from "../limits/LimitsSummary.js"
import { LiveIndicator } from "./LiveIndicator.js"
import { PRESETS } from "../usage/range.js"
import { outcomeOf, shown } from "./result.js"
import { StatusStrip } from "./StatusStrip.js"
import { useLiveUpdates } from "./useLiveUpdates.js"
import { formatMeasure, UsageChart } from "../usage/UsageChart.js"
import type { AgentFilter } from "../shared/contracts.js"

const AGENTS: ReadonlyArray<{ readonly value: AgentFilter; readonly label: string }> = [
  { value: "all", label: "All agents" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" }
]

const MEASURES: ReadonlyArray<{ readonly value: Measure; readonly label: string }> = [
  { value: "cost", label: "API-eq. $" },
  { value: "tokens", label: "Tokens" }
]

/** Re-renders once a minute so ages like "read 3m ago" stay true between refreshes. */
const useNow = (): number => {
  const [now, setNow] = useState(() => performance.timeOrigin + performance.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.timeOrigin + performance.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

const PANEL_LOADING = <Skeleton height="16rem" variant="block" />

const Dashboard = () => {
  const [preset, setPreset] = useAtom(presetAtom)
  const [agent, setAgent] = useAtom(agentAtom)
  const [measure, setMeasure] = useAtom(measureAtom)
  const [selected, setSelected] = useAtom(selectedAtom)
  const usageResult = useAtomValue(usageAtom)
  const limitsResult = useAtomValue(limitsAtom)
  const statusResult = useAtomValue(statusAtom)
  const usage = shown(usageResult)
  const limits = shown(limitsResult)
  const status = shown(statusResult)
  const now = useNow()
  const refreshUsage = useAtomRefresh(usageAtom)
  const refreshLimits = useAtomRefresh(limitsAtom)
  const refreshStatus = useAtomRefresh(statusAtom)
  const live = useLiveUpdates({
    usage: { refresh: refreshUsage, result: usageResult, outcome: outcomeOf(usageResult) },
    limits: { refresh: refreshLimits, result: limitsResult, outcome: outcomeOf(limitsResult) },
    status: { refresh: refreshStatus, result: statusResult, outcome: outcomeOf(statusResult) }
  })
  const slotsRef = useRef<ReadonlyMap<string, number>>(new Map())

  const stacked = useMemo(
    () => (usage.value === null ? null : stackUsage(usage.value.report, measure, selected)),
    [usage.value, measure, selected]
  )
  // Colours come from the unfiltered ranking, so picking one Booking does not repaint the rest.
  const named = useMemo(
    () =>
      new Set(
        (usage.value === null ? [] : stackUsage(usage.value.report, measure, null).series)
          .map((series) => series.id)
          .filter((id) => id !== OTHER)
      ),
    [usage.value, measure]
  )
  const slots = useMemo(() => {
    slotsRef.current = assignSlots(slotsRef.current, [...named])
    return slotsRef.current
  }, [named])
  const labels = useMemo(() => {
    const byId = new Map(
      (usage.value?.report.bookings ?? []).map((summary) => [summary.id, bookingLabel(summary.booking)])
    )
    return (id: string) => (id === OTHER ? "Other" : (byId.get(id) ?? id))
  }, [usage.value])

  const range = usage.value?.range ?? null
  return (
    <>
      <main className="usage-app">
        <header className="usage-heading">
          <Text as="h1" variant="section-title">
            Agent usage
          </Text>
          <div className="usage-heading-meta">
            <LiveIndicator state={live} />
            <Text tone="secondary" variant="meta">
              {timeZone}
            </Text>
          </div>
        </header>

        {limits.failure === null ? null : (
          <StatePanel description={limits.failure} title="Limits could not be read" tone="critical" />
        )}
        {limits.value === null ? (
          <Skeleton decorative={false} height="9rem" label="Loading limits" variant="block" />
        ) : (
          <LimitsSummary balances={limits.value.limits.balances} latest={limits.value.limits.latest} now={now} />
        )}

        <div className="usage-bar">
          <ToggleGroup
            aria-label="Range"
            items={PRESETS.map((value) => ({ value, label: value }))}
            onValueChange={(value) => {
              const next = PRESETS.find((candidate) => candidate === value)
              if (next === undefined) return
              setPreset(next)
              setSelected(null)
            }}
            size="compact"
            value={preset}
          />
          <ToggleGroup
            aria-label="Agent"
            items={AGENTS}
            onValueChange={(value) => {
              const next = AGENTS.find((candidate) => candidate.value === value)
              if (next === undefined) return
              setAgent(next.value)
              setSelected(null)
            }}
            size="compact"
            value={agent}
          />
          <ToggleGroup
            aria-label="Measure"
            items={MEASURES}
            onValueChange={(value) => {
              const next = MEASURES.find((candidate) => candidate.value === value)
              if (next !== undefined) setMeasure(next.value)
            }}
            size="compact"
            value={measure}
          />
        </div>

        <section aria-labelledby="usage-title" className="usage-panel">
          <div className="usage-panel-head">
            <div>
              <Text as="h2" id="usage-title" variant="card-title">
                Usage by booking{selected === null ? "" : ` — ${labels(selected)} only`}
              </Text>
              {usage.value === null || range === null ? null : (
                <p className="usage-headline">
                  <span className="usage-headline-value" data-testid="usage-total">
                    {formatMeasure(measure, rangeTotal(usage.value.report, measure, selected))}
                  </span>{" "}
                  <Text as="span" tone="secondary" variant="meta">
                    {measure === "cost" ? "API-equivalent" : "tokens"} · {usage.value.preset}
                    {selected === null ? "" : ` · ${labels(selected)}`}
                  </Text>
                </p>
              )}
            </div>
            {selected === null ? null : <Button onClick={() => setSelected(null)}>Show all</Button>}
          </div>
          {usage.failure === null ? null : (
            <StatePanel description={usage.failure} title="Usage could not be read" tone="critical" />
          )}
          {usage.value === null || stacked === null ? (
            PANEL_LOADING
          ) : usage.value.report.bookings.length === 0 ? (
            <StatePanel
              description="No Claude or Codex request was made in this range."
              title="No usage"
              tone="neutral"
            />
          ) : (
            <>
              <UsageChart
                labelOf={labels}
                measure={measure}
                range={usage.value.range}
                periods={usage.value.report.periods}
                slots={slots}
                stacked={stacked}
              />
              <ul aria-label="Bookings in the chart" className="usage-legend">
                {stacked.series.map((series) => (
                  <li key={series.id}>
                    <span
                      className="usage-swatch"
                      style={{
                        background:
                          series.id === OTHER
                            ? "var(--usage-series-other)"
                            : `var(--usage-series-${(slots.get(series.id) ?? 0) + 1})`
                      }}
                    />
                    {labels(series.id)}
                  </li>
                ))}
              </ul>
              {measure === "cost" && usage.value.report.unpriced.tokens > 0 ? (
                <p className="usage-note" data-tone="warning">
                  {formatTokens(usage.value.report.unpriced.tokens)} tokens have no price and are not in these dollars (
                  {usage.value.report.unpriced.models.join(", ")}).
                </p>
              ) : null}
              {measure === "cost" ? (
                <details className="usage-explain">
                  <summary>What is API-equivalent?</summary>
                  <Text as="p" tone="secondary" variant="meta">
                    Today's API list price applied to all history; it is not what a subscription charges.
                  </Text>
                </details>
              ) : null}
            </>
          )}
        </section>

        <section aria-labelledby="limits-title" className="usage-panel">
          <Text as="h2" id="limits-title" variant="card-title">
            Limits over time
          </Text>
          {limits.value === null ? (
            PANEL_LOADING
          ) : (
            <LimitChart now={now} range={limits.value.range} series={limits.value.limits.series} />
          )}
        </section>

        <div className="usage-panel">
          {usage.value === null ? (
            PANEL_LOADING
          ) : (
            <BookingTable
              bookings={usage.value.report.bookings}
              named={named}
              onSelect={setSelected}
              selected={selected}
              slots={slots}
            />
          )}
        </div>
      </main>
      {status.value === null ? null : (
        <StatusStrip ignoredKeys={usage.value?.report.ignoredKeys ?? []} now={now} status={status.value} />
      )}
    </>
  )
}

type Boot =
  { readonly _tag: "Booting" } | { readonly _tag: "Ready" } | { readonly _tag: "Failed"; readonly message: string }

export const App = () => {
  const [boot, setBoot] = useState<Boot>({ _tag: "Booting" })
  useEffect(() => {
    void Effect.runPromise(
      bootstrapSession.pipe(
        Effect.match({
          onFailure: (failure): Boot => ({ _tag: "Failed", message: failure.message }),
          onSuccess: (): Boot => ({ _tag: "Ready" })
        })
      )
    ).then(setBoot)
  }, [])
  return (
    <ThemeProvider className="usage-shell" theme="system">
      {boot._tag === "Ready" ? (
        <PortalProvider>
          <Dashboard />
        </PortalProvider>
      ) : boot._tag === "Booting" ? (
        <StatePanel title="Signing in" tone="neutral" description="Exchanging the one-time code." />
      ) : (
        <StatePanel
          title="Could not sign in"
          tone="critical"
          description={`${boot.message}. Run agent-usage login for a fresh link.`}
        />
      )}
    </ThemeProvider>
  )
}
