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
import { Button, StateLabel, ToggleGroup } from "@knpkv/rly/primitives"
import { Effect, Fiber, Option, Result, Schedule } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { useContext, useEffect, useId, useMemo, useState, type ReactElement } from "react"
import { createPortal } from "react-dom"
import { UsageEmptyArt } from "./internal/usage-empty-art.js"
import { UsageEmptyChromeContext } from "./internal/usage-empty-chrome.js"
import { ShellIcon } from "./internal/shell-icon.js"
import {
  canonicalUsageSelection,
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

const usagePollInterval = "5 minutes"

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

/** Only complete matching host reads can establish that neither tokens nor limits have been recorded. */
const emptyFleetReadings = (usage: FleetUsage, limits: FleetLimits): boolean => {
  if (!usage.peersListed || !limits.peersListed || usage.failures.length > 0 || limits.failures.length > 0) return false
  const usageHosts = new Set(usage.hosts.map(({ host }) => host.toLowerCase()))
  const limitHosts = new Set(limits.hosts.map(({ host }) => host.toLowerCase()))
  return (
    usageHosts.size > 0 &&
    usageHosts.size === usage.hosts.length &&
    limitHosts.size === limits.hosts.length &&
    usageHosts.size === limitHosts.size &&
    [...usageHosts].every((host) => limitHosts.has(host)) &&
    usage.hosts.every(
      ({ reading }) =>
        reading._tag === "Read" &&
        reading.skipped === 0 &&
        reading.usage.tokens.length === 0 &&
        reading.usage.limits.length === 0
    ) &&
    limits.hosts.every(
      ({ reading }) => reading._tag === "Read" && reading.skipped === 0 && reading.limits.latest.length === 0
    )
  )
}

const rangeLabels = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" } satisfies Record<
  UsageSelection["range"],
  string
>
type ReportedTool = Extract<
  FleetUsage["hosts"][number]["reading"],
  { readonly _tag: "Read" }
>["usage"]["tokens"][number]["agent"]
const toolLabels = { claude: "Claude Code", codex: "Codex" } satisfies Record<ReportedTool, string>
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
  readonly page: "limits" | "tokens" | "by-tool"
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
  const usage = useUsageRead(read, enabled, usagePollInterval, refresh)
  const limits = useUsageRead(content.reads.limits, enabled && page === "limits", "1 minute", refresh)
  const usageReading = Option.getOrNull(AsyncResult.value(usage))
  const limitsReading = Option.getOrNull(AsyncResult.value(limits))
  const emptyChrome = useContext(UsageEmptyChromeContext)
  const empty =
    page === "limits" &&
    AsyncResult.isSuccess(usage) &&
    AsyncResult.isSuccess(limits) &&
    emptyFleetReadings(usage.value.fleet, limits.value.fleet)
  const setEmpty = emptyChrome?.setEmpty
  useEffect(() => {
    setEmpty?.(mount.active && empty)
    return () => setEmpty?.(false)
  }, [empty, mount.active, setEmpty])
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
    (page !== "limits" || (AsyncResult.isSuccess(limits) && limits.value.fleet.peersListed))
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
      <section className="usage-details" data-usage-page={page}>
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
      const label = `${toolLabels[cell.agent]}, ${cell.model}`
      modelTotals.set(label, (modelTotals.get(label) ?? 0) + cell.tokens)
    }
  }
  const shownRange = counted.find((host) => host.reading._tag === "Read")?.reading
  const summary =
    counted.length === 0
      ? "No token reading is available yet."
      : `${compact.format(total)} reported tokens in the last ${shownRange?._tag === "Read" ? rangeLabels[shownRange.usage.range.preset] : rangeLabels[range]} from ${counted.length} ${counted.length === 1 ? "host" : "hosts"}.`
  const tabProps: UsageTabProps = {
    presentation: { page: page === "limits" ? "limits" : "tokens", labelledBy: headingId },
    onHubMachine: false,
    range,
    onRangeChange: (range) => changeSelection({ ...decoded.success.selection, range }),
    usage: usageState(filteredUsage, content.now),
    limits: limitsState(filteredLimits, content.now)
  }
  const toolReading = hostTotals.find((host) => host.host.toLowerCase() === breakdownHost?.toLowerCase())?.reading
  const toolFailure = shown?.fleet.failures.find((entry) => entry.host.toLowerCase() === breakdownHost?.toLowerCase())
  const toolTotal =
    toolReading?._tag === "Read" ? [...providerTotals.values()].reduce((sum, tokens) => sum + tokens, 0) : null
  if (empty && emptyChrome !== null) {
    const mast = (
      <div className="usage-empty-mast">
        <div className="usage-empty-titles">
          <h1 id={headingId}>Usage</h1>
          <p>Usage details on {emptyChrome.host}. Account readings stay on this machine.</p>
        </div>
        <nav aria-label="Usage pages" className="usage-empty-tabs" data-region="tabs">
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
      </div>
    )
    return (
      <div className="usage-limits-empty" data-usage-page="limits" data-usage-empty="true" aria-label="Usage Limits">
        {emptyChrome.headerOutlet === null ? mast : createPortal(mast, emptyChrome.headerOutlet)}
        <section className="usage-empty-notice" data-region="notice">
          <UsageEmptyArt />
          <h2>No usage readings yet</h2>
          <p>{emptyChrome.host} hasn’t recorded any limits or token use. Unknown is not zero.</p>
          <a
            href={moduleHref(usageModule, "tokens", decoded.success.search)}
            className="usage-empty-action"
            data-region="action"
          >
            See fleet token readings
          </a>
        </section>
      </div>
    )
  }
  return (
    <div className="usage-details" data-usage-page={page}>
      <div className="usage-details-mast">
        <header className="usage-details-intro">
          <h1 id={headingId}>Usage</h1>
          <p>Limits and tokens, per host, tool and model</p>
          {repaired ? <p>Some URL selectors were reset. Valid selections were kept.</p> : null}
        </header>
        <nav aria-label="Usage pages" className="usage-details-tabs" data-region="tabs">
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
      </div>
      <div className="usage-details-controls">
        <label htmlFor={hostId}>
          Host
          <select
            id={hostId}
            name="usage-host"
            value={page === "by-tool" ? (breakdownHost ?? "") : (selectedHost ?? "")}
            onChange={(event) =>
              changeSelection({ ...decoded.success.selection, host: event.currentTarget.value || null })
            }
          >
            {page === "by-tool" ? (
              breakdownHost === null ? (
                <option value="">No reported host</option>
              ) : null
            ) : (
              <option value="">All hosts</option>
            )}
            {knownHosts.map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
            {selectedHost !== null && !knownHosts.includes(selectedHost) ? (
              <option value={selectedHost}>{selectedHost}</option>
            ) : null}
          </select>
          {page === "by-tool" ? <ShellIcon name="next" /> : null}
        </label>
        <ToggleGroup
          aria-label="Range"
          value={range}
          items={Object.entries(rangeLabels).map(([value, label]) => ({ value, label }))}
          onValueChange={(value) => {
            const next = value === "24h" || value === "7d" || value === "30d" ? value : null
            if (next !== null) changeSelection({ ...decoded.success.selection, range: next })
          }}
        />
        <span className="usage-details-time-zone">Periods in {timeZone}</span>
        {content.onHubMachine ? (
          <a href={AGENT_USAGE_PAGE} target="_blank" rel="noreferrer">
            Open agent-usage on this machine
          </a>
        ) : null}
        {(AsyncResult.isFailure(usage) && (page !== "by-tool" || toolReading?._tag !== "Read")) ||
        (page === "limits" && AsyncResult.isFailure(limits)) ? (
          <Button
            data-region={page === "limits" ? "action" : undefined}
            onClick={() => setRefresh((previous) => previous + 1)}
          >
            Retry
          </Button>
        ) : null}
      </div>
      {page === "by-tool" &&
      toolReading?._tag === "Read" &&
      usage.waiting &&
      toolReading.usage.range.preset !== range ? (
        <StateLabel
          className="usage-by-tool-updating"
          role="status"
          tone="neutral"
          icon="loader"
          size="compact"
          label={`Updating to ${rangeLabels[range]}… showing the last ${rangeLabels[toolReading.usage.range.preset]}`}
        />
      ) : null}
      {page === "by-tool" && toolReading?._tag === "Read" && AsyncResult.isFailure(usage) ? (
        <div className="usage-by-tool-notice" role="status">
          <div>
            <StateLabel label="Couldn’t refresh" tone="caution" icon="alert" size="compact" />
            {toolReading?._tag !== "Read" ? null : (
              <span>
                Previous reading{" "}
                <time dateTime={new Date(toolReading.usage.observedAt).toISOString()}>
                  {new Date(toolReading.usage.observedAt).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone
                  })}
                </time>
                . Retrying every {usagePollInterval}.
              </span>
            )}
          </div>
          <Button variant="secondary" size="dense" onClick={() => setRefresh((previous) => previous + 1)}>
            Retry
          </Button>
        </div>
      ) : null}
      {page === "by-tool" ? (
        <section className="usage-details-section usage-by-tool" aria-label="By tool">
          <h2 className="usage-by-tool-heading">By tool</h2>
          <div className="usage-by-tool-reading">
            <strong className="usage-by-tool-total">
              {toolTotal === null ? "Unknown" : `${compact.format(toolTotal)} tokens`}
            </strong>
            <p>
              {toolReading?._tag === "Read" ? (
                <>
                  {breakdownHost}, last {rangeLabels[toolReading.usage.range.preset]}, read{" "}
                  <time dateTime={new Date(toolReading.usage.observedAt).toISOString()}>
                    {new Date(toolReading.usage.observedAt).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone
                    })}
                  </time>
                </>
              ) : toolReading !== undefined ? (
                toolReading.detail
              ) : toolFailure !== undefined ? (
                `${toolFailure.host}: ${failureWords[toolFailure.reason]}`
              ) : (
                "No tool reading is available yet."
              )}
            </p>
          </div>
          <table aria-label={breakdownHost === null ? "By tool and model" : `By tool and model on ${breakdownHost}`}>
            <thead>
              <tr>
                <th scope="col">Tool and model</th>
                <th scope="col">Tokens</th>
                <th scope="col">Share</th>
                <th scope="col">Share track</th>
              </tr>
            </thead>
            <tbody>
              {[...modelTotals]
                .sort(([, left], [, right]) => right - left)
                .map(([label, tokens]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>{compact.format(tokens)}</td>
                    <td>
                      {toolTotal === null || toolTotal === 0
                        ? "0%"
                        : `${String(Math.round((tokens / toolTotal) * 100))}%`}
                    </td>
                    <td className="usage-by-tool-track">
                      <progress
                        aria-hidden="true"
                        max={100}
                        value={toolTotal === null || toolTotal === 0 ? 0 : (tokens / toolTotal) * 100}
                      />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p>
            Per tool and model on one host at a time; splits are never summed across hosts. Moved here from Fleet /
            Usage.
          </p>
          {shown === null ||
          (shown.fleet.peersListed &&
            shown.fleet.failures.length === 0 &&
            counted.length === hostTotals.length) ? null : (
            <p>Unknown hosts are left out of totals. No token reading is treated as zero.</p>
          )}
        </section>
      ) : (
        <UsageTab {...tabProps} />
      )}
      {page === "tokens" ? (
        <>
          <section className="usage-details-section" aria-label="By host">
            <h2>By host</h2>
            <p>{summary}</p>
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
      <footer className="usage-details-footer" data-region={page === "limits" ? "footer" : undefined}>
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
  navigationIcon: <ShellIcon name="usage" />,
  pages: {
    limits: (search, mount) => <UsagePage content={content} mount={mount} page="limits" search={search} />,
    tokens: (search, mount) => <UsagePage content={content} mount={mount} page="tokens" search={search} />,
    "by-tool": (search, mount) => <UsagePage content={content} mount={mount} page="by-tool" search={search} />
  }
})
