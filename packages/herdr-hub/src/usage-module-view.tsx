import {
  AGENT_USAGE_PAGE,
  type FleetLimits,
  type FleetReadLoadError,
  type FleetUsage,
  limitsState,
  type Received,
  UsageTab,
  type UsageTabProps,
  usageState,
  type UsageQuery
} from "@knpkv/herdr-connect/usage"
import { Button, ToggleGroup } from "@knpkv/rly/primitives"
import { Effect, Fiber, Option, Result, Schedule } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useEffect, useId, useMemo, useState, type ReactElement } from "react"
import {
  canonicalUsageSelection,
  fleetModule,
  moduleHref,
  usageModule,
  type ModulePageMount,
  type ModuleViews,
  type UsageSelection
} from "./modules.js"

export interface UsageModuleReads {
  readonly usage: (query: UsageQuery) => Effect.Effect<Received<FleetUsage>, FleetReadLoadError>
  readonly limits: Effect.Effect<Received<FleetLimits>, FleetReadLoadError>
}

interface UsageModuleContent {
  readonly reads: UsageModuleReads
  readonly viewerTimeZone: string
  readonly now: number
  readonly onHubMachine: boolean
}

/** Serial cached reads stop when the module is inactive or hidden, including an in-flight request. */
const useUsageRead = <A,>(
  read: Effect.Effect<Received<A>, FleetReadLoadError>,
  enabled: boolean,
  interval: "5 minutes" | "1 minute",
  refresh: number
) => {
  const [result, setResult] = useState<AsyncResult.AsyncResult<Received<A>, FleetReadLoadError>>(AsyncResult.initial())
  useEffect(() => {
    if (!enabled) return
    let current = true
    const pass = Effect.gen(function* () {
      yield* Effect.sync(() => setResult((previous) => AsyncResult.waiting(previous)))
      const exit = yield* Effect.exit(read)
      if (!current) return
      yield* Effect.sync(() => setResult((previous) => AsyncResult.fromExitWithPrevious(exit, Option.some(previous))))
    }).pipe(Effect.repeat(Schedule.spaced(interval)))
    const fiber = Effect.runFork(pass)
    return () => {
      current = false
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [read, enabled, interval, refresh])
  return result
}

const filterHosts = <A extends FleetUsage | FleetLimits>(fleet: A, host: string | null): A =>
  host === null
    ? fleet
    : {
        ...fleet,
        hosts: fleet.hosts.filter((entry) => entry.host.toLowerCase() === host.toLowerCase()),
        failures: fleet.failures.filter((entry) => entry.host.toLowerCase() === host.toLowerCase())
      }

const rangeLabels = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" } satisfies Record<
  UsageSelection["range"],
  string
>
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
const failureWords = {
  offline: "Offline",
  unavailable: "No tailnet address",
  timeout: "No answer",
  request_failed: "Request failed",
  invalid_response: "Unexpected answer"
} satisfies Record<FleetUsage["failures"][number]["reason"], string>

const UsagePage = ({
  content,
  mount,
  page,
  search
}: {
  readonly content: UsageModuleContent
  readonly mount: ModulePageMount
  readonly page: "limits" | "tokens"
  readonly search: URLSearchParams
}): ReactElement => {
  const headingId = useId()
  const hostId = useId()
  const [visible, setVisible] = useState(() => document.visibilityState === "visible")
  const [repaired, setRepaired] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", changed)
    return () => document.removeEventListener("visibilitychange", changed)
  }, [])
  const query = search.toString()
  const decoded = useMemo(
    () => canonicalUsageSelection(new URLSearchParams(query), content.viewerTimeZone),
    [query, content.viewerTimeZone]
  )
  const selection = Result.isSuccess(decoded) ? decoded.success.selection : null
  const range = selection?.range ?? "7d"
  const timeZone = selection?.timeZone ?? content.viewerTimeZone
  const read = useMemo(() => content.reads.usage({ range, timeZone }), [content.reads.usage, range, timeZone])
  const enabled = mount.active && visible && selection !== null
  const usage = useUsageRead(read, enabled, "5 minutes", refresh)
  const limits = useUsageRead(content.reads.limits, enabled && page === "limits", "1 minute", refresh)
  const usageReading = Option.getOrNull(AsyncResult.value(usage))
  const limitsReading = Option.getOrNull(AsyncResult.value(limits))
  const knownHosts = [
    ...new Set([
      ...(usageReading?.fleet.hosts.map((entry) => entry.host) ?? []),
      ...(usageReading?.fleet.failures.map((entry) => entry.host) ?? []),
      ...(page === "limits" ? (limitsReading?.fleet.hosts.map((entry) => entry.host) ?? []) : []),
      ...(page === "limits" ? (limitsReading?.fleet.failures.map((entry) => entry.host) ?? []) : [])
    ])
  ].sort((a, b) => a.localeCompare(b))
  const hostsComplete =
    AsyncResult.isSuccess(usage) &&
    usage.value.fleet.peersListed &&
    (page === "tokens" || (AsyncResult.isSuccess(limits) && limits.value.fleet.peersListed))
  const unknownHost =
    selection?.host !== null &&
    selection?.host !== undefined &&
    hostsComplete &&
    !knownHosts.some((host) => host.toLowerCase() === selection.host?.toLowerCase())
  const selectedHost = unknownHost ? null : (selection?.host ?? null)
  useEffect(() => {
    if (!mount.active || Result.isFailure(decoded)) return
    const canonical = new URLSearchParams(decoded.success.search)
    if (unknownHost) canonical.delete("host")
    if (canonical.toString() === query) return
    if (decoded.success.repaired || unknownHost) setRepaired(true)
    mount.navigate(moduleHref(usageModule, page, canonical), "replace", null)
  }, [decoded, unknownHost, query, page, mount.active, mount.navigate])
  if (Result.isFailure(decoded))
    return (
      <section className="usage-details">
        <h1>Usage unavailable</h1>
        <p>The browser's time zone could not be read.</p>
      </section>
    )
  const changeSelection = (next: UsageSelection) => {
    setRepaired(false)
    const query = new URLSearchParams({ range: next.range, timeZone: next.timeZone })
    if (next.host !== null) query.set("host", next.host)
    mount.navigate(moduleHref(usageModule, page, query), "replace", null)
  }
  const filteredUsage = AsyncResult.map(usage, (received) => ({
    ...received,
    fleet: filterHosts(received.fleet, selectedHost)
  }))
  const filteredLimits = AsyncResult.map(limits, (received) => ({
    ...received,
    fleet: filterHosts(received.fleet, selectedHost)
  }))
  const shown = Option.getOrNull(AsyncResult.value(filteredUsage))
  const hostTotals =
    shown?.fleet.hosts.map((host) => ({
      host: host.host,
      reading: host.reading,
      total: host.reading._tag === "Read" ? host.reading.usage.tokens.reduce((sum, cell) => sum + cell.tokens, 0) : null
    })) ?? []
  const counted = hostTotals.filter((host) => host.total !== null)
  const total = counted.reduce((sum, host) => sum + (host.total ?? 0), 0)
  const breakdownHost = selectedHost ?? counted[0]?.host ?? null
  const providerTotals = new Map<string, number>()
  const modelTotals = new Map<string, number>()
  for (const host of hostTotals) {
    if (host.reading._tag !== "Read" || host.host.toLowerCase() !== breakdownHost?.toLowerCase()) continue
    for (const cell of host.reading.usage.tokens) {
      providerTotals.set(cell.agent, (providerTotals.get(cell.agent) ?? 0) + cell.tokens)
      const label = `${cell.agent} / ${cell.model}`
      modelTotals.set(label, (modelTotals.get(label) ?? 0) + cell.tokens)
    }
  }
  const shownRange = counted.find((host) => host.reading._tag === "Read")?.reading
  const summary =
    counted.length === 0
      ? "No token reading is available yet."
      : `${compact.format(total)} reported tokens in the last ${shownRange?._tag === "Read" ? rangeLabels[shownRange.usage.range.preset] : rangeLabels[range]} from ${counted.length} ${counted.length === 1 ? "host" : "hosts"}.`
  const tabProps: UsageTabProps = {
    presentation: { page, labelledBy: headingId },
    onHubMachine: false,
    range,
    onRangeChange: (range) => changeSelection({ ...decoded.success.selection, range }),
    usage: usageState(filteredUsage, content.now),
    limits: limitsState(filteredLimits, content.now)
  }
  return (
    <div className="usage-details">
      <header className="usage-details-intro">
        <h1 id={headingId}>{page === "limits" ? "Limits" : "Tokens"}</h1>
        <p>{page === "limits" ? "Know when to wait, and when there is room for another task." : summary}</p>
        {repaired ? <p>Some URL selectors were reset. Valid selections were kept.</p> : null}
      </header>
      <nav aria-label="Usage pages" className="usage-details-tabs">
        {usageModule.pages.map((entry) => (
          <a
            key={entry.id}
            href={moduleHref(usageModule, entry.id, decoded.success.search)}
            aria-current={page === entry.id ? "page" : undefined}
            data-module-page={entry.id}
          >
            {entry.label}
          </a>
        ))}
      </nav>
      <div className="usage-details-controls">
        <ToggleGroup
          aria-label="Range"
          value={range}
          items={Object.entries(rangeLabels).map(([value, label]) => ({ value, label }))}
          onValueChange={(value) => {
            const next = value === "24h" || value === "7d" || value === "30d" ? value : null
            if (next !== null) changeSelection({ ...decoded.success.selection, range: next })
          }}
        />
        <label htmlFor={hostId}>
          Host
          <select
            id={hostId}
            name="usage-host"
            value={selectedHost ?? ""}
            onChange={(event) =>
              changeSelection({ ...decoded.success.selection, host: event.currentTarget.value || null })
            }
          >
            <option value="">All hosts</option>
            {knownHosts.map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
            {selectedHost !== null && !knownHosts.includes(selectedHost) ? (
              <option value={selectedHost}>{selectedHost}</option>
            ) : null}
          </select>
        </label>
        <span>Periods in {timeZone}</span>
        {content.onHubMachine ? (
          <a href={AGENT_USAGE_PAGE} target="_blank" rel="noreferrer">
            Open agent-usage on this machine
          </a>
        ) : null}
        {AsyncResult.isFailure(usage) || AsyncResult.isFailure(limits) ? (
          <Button onClick={() => setRefresh((previous) => previous + 1)}>Retry</Button>
        ) : null}
      </div>
      <UsageTab {...tabProps} />
      {page === "tokens" ? (
        <>
          <section className="usage-details-section" aria-label="By host">
            <h2>By host</h2>
            <ul>
              {hostTotals.map((host) => (
                <li key={host.host}>
                  <span>
                    <strong>{host.host}</strong>
                    {host.reading._tag === "Read" ? (
                      <time dateTime={new Date(host.reading.usage.observedAt).toISOString()}>
                        Read{" "}
                        {new Date(host.reading.usage.observedAt).toLocaleTimeString("en-GB", {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZone
                        })}{" "}
                        in {timeZone}
                      </time>
                    ) : (
                      <small>{host.reading.detail}</small>
                    )}
                  </span>
                  <strong>{host.total === null ? "Unknown" : compact.format(host.total)}</strong>
                </li>
              ))}
              {shown?.fleet.failures.map((failure) => (
                <li key={failure.host}>
                  <span>
                    <strong>{failure.host}</strong>
                    <small>{failureWords[failure.reason]}</small>
                  </span>
                  <strong>Unknown</strong>
                </li>
              ))}
            </ul>
            {shown !== null &&
            (!shown.fleet.peersListed || shown.fleet.failures.length > 0 || counted.length < hostTotals.length) ? (
              <p>Unknown hosts are left out of the total.</p>
            ) : null}
          </section>
          <section className="usage-details-section" aria-label="By provider">
            <h2>By provider</h2>
            <p>
              {breakdownHost === null
                ? "No provider reading is available yet."
                : `On ${breakdownHost}. Splits stay on this host.`}
            </p>
            <ul>
              {[...providerTotals]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([label, total]) => (
                  <li key={label}>
                    <span>{label}</span>
                    <strong>{compact.format(total)}</strong>
                  </li>
                ))}
            </ul>
          </section>
          <section className="usage-details-section" aria-label="By agent and model">
            <h2>By agent and model</h2>
            <p>
              {breakdownHost === null
                ? "No agent and model reading is available yet."
                : `On ${breakdownHost}. Tokens cannot be attributed to individual bots.`}
            </p>
            <ul>
              {[...modelTotals]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([label, total]) => (
                  <li key={label}>
                    <span>{label}</span>
                    <strong>{compact.format(total)}</strong>
                  </li>
                ))}
            </ul>
          </section>
        </>
      ) : null}
      <footer className="usage-details-footer">
        <a href={moduleHref(fleetModule, "usage")}>Fleet usage</a>
        <p>
          Only reported tokens and limit readings travel between hosts. Costs, balances, sessions and paths stay on
          their machines. Cost isn't reported.
        </p>
      </footer>
    </div>
  )
}

/** The shared page root keeps prior readings across tabs and shell navigation; Fleet owns transport. */
export const makeUsageModuleViews = (content: UsageModuleContent): ModuleViews<typeof usageModule> => ({
  descriptor: usageModule,
  pages: {
    limits: (search, mount) => <UsagePage content={content} mount={mount} page="limits" search={search} />,
    tokens: (search, mount) => <UsagePage content={content} mount={mount} page="tokens" search={search} />
  }
})
