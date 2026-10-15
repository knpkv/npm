import { Skeleton, StateLabel } from "@knpkv/rly/primitives"
import { Clock, Effect, Exit, Fiber, Schedule } from "effect"
import { Fragment, type ReactElement, type ReactNode, useEffect, useId, useState } from "react"
import {
  heavyAbortBytes,
  heavyStartBytes,
  type HostResources,
  type ResourceJob,
  type ResourcePreview,
  type ResourceUnavailable
} from "./host-resources-model.js"
import { ShellIcon } from "./internal/shell-icon.js"
import { type ModulePageMount, type ModuleViews, resourcesModule } from "./modules.js"
import type { ResourcesReadFailed } from "./resources-client.js"
import {
  memoryPaths,
  memoryState,
  resourceAge,
  resourceBytes,
  resourceFreshness,
  resourceTime,
  type ResourcesViewState
} from "./resources-view-model.js"

const headings = {
  memory: "Memory",
  trend: "Memory available, last hour",
  cpu: "CPU",
  disk: "Disk",
  gate: "Heavy gate",
  jobs: "Heavy jobs",
  previews: "Live previews",
  top: "Top memory by agent"
}
const unavailableCopy = (section: ResourceUnavailable) =>
  section.reason === "not_configured"
    ? "Not configured on this host"
    : section.reason === "warming_up"
      ? "Waiting for the next sample"
      : "Reading unavailable on this host"
const previewReasons = {
  not_probed: "Awaiting probe",
  not_tailnet: "Loopback only",
  tailscale_unavailable: "Tailscale unavailable",
  no_dns_name: "No tailnet name",
  probe_failed: "Not answering"
} satisfies Record<Extract<ResourcePreview["open"], { readonly _tag: "Unavailable" }>["reason"], string>
const grantLabel = (grant: string | null) => grant ?? "no grant on cmdline"

/** The positive memory state uses the circled check from the resource reference. */
const MemoryStatus = ({ available }: { readonly available: number }): ReactElement => {
  const state = memoryState(available)
  return state.tone === "positive" ? (
    <span className="hr-memory-positive">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{state.label}</span>
    </span>
  ) : (
    <StateLabel {...state} />
  )
}

const Panel = ({
  children,
  lead,
  note,
  old,
  region
}: {
  readonly region: keyof typeof headings
  readonly children: ReactNode
  readonly lead?: ReactNode
  readonly old: boolean
  readonly note?: ReactNode
}): ReactElement => {
  const id = useId()
  return (
    <section className="hr-panel hr-card" aria-labelledby={id} data-region={region}>
      {lead}
      <div className="hr-card-head">
        <h2 id={id}>
          {headings[region]}
          {old ? <span className="hr-sr">, last values, not current</span> : null}
        </h2>
        {note === undefined ? null : <small>{note}</small>}
      </div>
      {children}
    </section>
  )
}

const ProcessList = ({ job }: { readonly job: ResourceJob }): ReactElement => (
  <details>
    <summary>Processes, {job.processes.length}</summary>
    <ul className="hr-procs" aria-label={`Processes, ${job.lane ?? `pid ${job.pid}`}`}>
      {job.processes.map((proc) => (
        <li key={proc.pid}>
          <span>{proc.pid}</span>
          <span>{proc.command}</span>
          <span>{resourceBytes(proc.rssBytes, true)}</span>
        </li>
      ))}
    </ul>
  </details>
)

export interface HostResourcesViewProps extends ResourcesViewState {
  readonly now: number
}

/** Read-only observations. Old readings remain visibly labelled through failed refreshes. */
export const HostResourcesView = ({ now, ...state }: HostResourcesViewProps): ReactElement => {
  const [morePreviews, setMorePreviews] = useState(false)
  const [moreMemory, setMoreMemory] = useState(false)
  const { label, status } = resourceFreshness(state, now)
  const snapshot = state.snapshot
  const old = status._tag !== "Live"
  const lastTime = snapshot === null ? null : resourceTime(snapshot.sampledAt)
  const titleId = useId()
  const header = (
    <header className="hr-heading" data-region="header">
      <h1 id={titleId}>Host resources</h1>
      <p>
        <b>{snapshot?.host ?? state.host}</b>
        {label !== "" ? (
          <>
            {", "}
            {status._tag === "Stale" ? (
              <span className="hr-fresh">
                <StateLabel label={label} tone="caution" size="compact" />
              </span>
            ) : (
              label
            )}
          </>
        ) : null}
      </p>
      {/* Announce freshness changes with a fixed sample time; the visible age ticks silently. */}
      <span className="hr-sr" role="status" aria-live="polite" aria-atomic="true">
        {snapshot === null
          ? ""
          : status._tag === "Stale"
            ? `Stale, last sample ${lastTime}.`
            : status._tag === "Live"
              ? "Live"
              : "Host offline"}
      </span>
    </header>
  )
  if (snapshot === null)
    return (
      <div className="host-resources" aria-labelledby={titleId}>
        {header}
        <div className="hr-grid">
          {state.loading ? (
            <>
              <p className="hr-sr" role="status">
                Loading host resources
              </p>
              {Object.entries(headings).map(([region, heading]) => (
                <section
                  key={region}
                  className="hr-panel hr-card"
                  aria-busy="true"
                  aria-label="Loading host resources"
                  data-region={region}
                >
                  <h2>{heading}</h2>
                  <div className="hr-skel">
                    <Skeleton width="8rem" />
                    <Skeleton variant="block" height={region === "trend" ? "200px" : "56px"} />
                  </div>
                </section>
              ))}
            </>
          ) : (
            <div className="hr-panel hr-notice hr-page-notice" role="status" data-region="notice">
              <StateLabel label={`No reading from ${state.host} yet.`} tone="caution" size="compact" />
            </div>
          )}
        </div>
      </div>
    )
  const memory = snapshot.memory
  const trend = snapshot.memoryTrend
  const cpu = snapshot.cpu
  const disks = snapshot.disks
  const tmp = snapshot.tmp
  const gate = snapshot.gate
  const jobs = snapshot.heavyJobs
  const previews = snapshot.previews
  const top = snapshot.topMemory
  const points = trend._tag === "Reading" ? trend.value : []
  const chartNow = status._tag === "Stale" ? now : snapshot.sampledAt
  const maximum = Math.max(
    16 * 1024 ** 3,
    Math.ceil(Math.max(...points.map((p) => p.availableBytes), 0) / heavyStartBytes) * heavyStartBytes
  )
  const paths = memoryPaths(points, chartNow, maximum)
  const min = Math.min(...points.map((p) => p.availableBytes))
  const max = Math.max(...points.map((p) => p.availableBytes))
  const historyNote =
    !old && points.length < 360 ? `${Math.max(0, Math.round(points.length / 6))} min of history` : "10 s samples"
  const names = top._tag === "Reading" ? top.value.groups.filter((group) => group.pid !== null) : []
  const others = top._tag === "Reading" ? top.value.groups.filter((group) => group.pid === null) : []
  const groups = [...(moreMemory ? names : names.slice(0, 8)), ...others]
  return (
    <div className="host-resources" aria-labelledby={titleId}>
      {header}
      <div className="hr-grid" data-old={old ? "" : undefined}>
        {status._tag === "HostOffline" ? (
          <div className="hr-panel hr-notice hr-page-notice" role="status" data-region="notice">
            <StateLabel label={`${snapshot.host} is offline. Last sample ${lastTime}.`} tone="caution" size="compact" />
          </div>
        ) : null}
        <Panel
          region="memory"
          old={old}
          lead={
            memory._tag === "Reading" && memory.value.availableBytes < heavyAbortBytes ? (
              <div className="hr-panel hr-notice hr-abort-notice" role="status">
                <div>
                  <StateLabel label="Below abort." tone="critical" size="compact" />
                  <span>Heavy jobs should stop.</span>
                </div>
              </div>
            ) : undefined
          }
        >
          {memory._tag === "Unavailable" ? (
            <p className="hr-empty">{unavailableCopy(memory)}</p>
          ) : (
            <>
              <p className="hr-big">
                <b>{resourceBytes(memory.value.availableBytes, true)}</b>
                <span>available of {resourceBytes(memory.value.totalBytes)}</span>
              </p>
              {memory.value.availableBytes < heavyAbortBytes ? null : (
                <span>
                  <MemoryStatus available={memory.value.availableBytes} />
                </span>
              )}
              <dl className="hr-kv">
                <div>
                  <dt>Swap used</dt>
                  <dd>
                    {resourceBytes(memory.value.swapUsedBytes, true)} of {resourceBytes(memory.value.swapTotalBytes)}
                  </dd>
                </div>
                <div>
                  <dt>Thresholds</dt>
                  <dd>heavy start at 8 GiB, abort at 3 GiB</dd>
                </div>
              </dl>
            </>
          )}
        </Panel>
        <Panel region="trend" old={old} note={historyNote}>
          {trend._tag === "Unavailable" ? (
            <p className="hr-empty">{unavailableCopy(trend)}</p>
          ) : points.length === 0 ? (
            <p className="hr-empty">No history yet</p>
          ) : (
            <>
              <div className="hr-chart">
                <svg
                  viewBox="0 0 1000 200"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`Memory available over the last hour, 10 s samples, ranging ${resourceBytes(min, true)} to ${resourceBytes(max, true)}${memory._tag === "Reading" ? `; now ${resourceBytes(memory.value.availableBytes, true)}` : ""}. ${old ? "Last values, not current." : ""}`}
                >
                  {paths.map((path) => (
                    <path key={path.line} className="hr-area" d={path.area} />
                  ))}
                  <line className="hr-base" x1="0" x2="1000" y1="200" y2="200" />
                  {[heavyStartBytes, heavyAbortBytes].map((bytes) => (
                    <line
                      key={bytes}
                      className="hr-rule"
                      x1="0"
                      x2="1000"
                      y1={(1 - bytes / maximum) * 200}
                      y2={(1 - bytes / maximum) * 200}
                    />
                  ))}
                  {paths.map((path) => (
                    <path key={path.line} className="hr-line" d={path.line} />
                  ))}
                </svg>
                <span className="hr-ymax" aria-hidden="true">
                  {resourceBytes(maximum)}
                </span>
                {[heavyStartBytes, heavyAbortBytes].map((bytes) => (
                  <span
                    key={bytes}
                    className="hr-chart-tag"
                    style={{ insetBlockStart: `${(1 - bytes / maximum) * 100}%` }}
                  >
                    {bytes === heavyStartBytes ? "Heavy start" : "Abort"} at {resourceBytes(bytes)}
                  </span>
                ))}
              </div>
              <div className="hr-axis" aria-hidden="true">
                <span>−60 min</span>
                <span>−30 min</span>
                <span>{status._tag === "HostOffline" ? lastTime : "now"}</span>
              </div>
            </>
          )}
        </Panel>
        <Panel region="cpu" old={old} note={cpu._tag === "Reading" ? `against ${cpu.value.cores} cores` : undefined}>
          {cpu._tag === "Unavailable" ? (
            <p className="hr-empty">{unavailableCopy(cpu)}</p>
          ) : (
            <>
              <dl className="hr-loads">
                {cpu.value.load.map((load, i) => (
                  <div key={i}>
                    <dt>{["Load 1 min", "5 min", "15 min"][i]}</dt>
                    <dd>{load.toFixed(1)}</dd>
                  </div>
                ))}
              </dl>
              <div className="hr-cpu-now">
                <span>
                  CPU now <b>{Math.round(cpu.value.percent)}%</b>
                </span>
                <svg
                  className="hr-spark"
                  viewBox="0 0 160 36"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`CPU over the last hour${old ? ", last values, not current" : ""}`}
                >
                  <path
                    d={cpu.value.history
                      .filter((point) => point.sampledAt >= snapshot.sampledAt - 3_590_000)
                      .map(
                        (point, i) =>
                          `${i > 0 ? "L" : "M"}${Math.max(0, Math.min(160, ((point.sampledAt - snapshot.sampledAt + 3_590_000) / 3_590_000) * 160)).toFixed(1)} ${(36 - (point.percent / 100) * 36).toFixed(1)}`
                      )
                      .join("")}
                  />
                </svg>
              </div>
            </>
          )}
        </Panel>
        <Panel region="disk" old={old}>
          <div className="hr-fs">
            {disks._tag === "Unavailable" ? (
              <p className="hr-empty">{unavailableCopy(disks)}</p>
            ) : (
              disks.value.map((disk) => (
                <div key={disk.mount}>
                  <b>{disk.mount}</b>
                  <span className="hr-num">{resourceBytes(disk.usedBytes)} used</span>
                  <small>
                    {resourceBytes(disk.totalBytes - disk.usedBytes, false, disk.totalBytes)} free of{" "}
                    {resourceBytes(disk.totalBytes)}
                  </small>
                </div>
              ))
            )}
            {tmp._tag === "Unavailable" ? (
              <p className="hr-empty">{unavailableCopy(tmp)}</p>
            ) : (
              <div>
                <b>/tmp (memory)</b>
                <span className="hr-num">
                  {resourceBytes(tmp.value.usedBytes)} of {resourceBytes(tmp.value.totalBytes)} quota
                </span>
                <span
                  className="hr-meter"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={tmp.value.totalBytes}
                  aria-valuenow={tmp.value.usedBytes}
                  aria-label={`/tmp, ${old ? "last values, not current, " : ""}${Math.round(tmp.value.totalBytes === 0 ? 0 : (tmp.value.usedBytes / tmp.value.totalBytes) * 100)}% of quota used`}
                >
                  <i
                    style={{
                      inlineSize: `${tmp.value.totalBytes === 0 ? 0 : Math.min(100, (tmp.value.usedBytes / tmp.value.totalBytes) * 100)}%`
                    }}
                  />
                </span>
                <small>
                  {Math.round(tmp.value.totalBytes === 0 ? 0 : (tmp.value.usedBytes / tmp.value.totalBytes) * 100)}% of
                  quota used
                </small>
              </div>
            )}
          </div>
        </Panel>
        <Panel region="gate" old={old} note={status._tag === "HostOffline" ? `Last known, ${lastTime}` : undefined}>
          {gate._tag === "Unavailable" ? (
            <p className="hr-empty">{unavailableCopy(gate)}</p>
          ) : (
            <>
              <div className="hr-slots">
                {gate.value.slots.map((slot) => (
                  <div className="hr-slot" key={slot.slot}>
                    <div className="hr-slot-head">
                      <b>Slot {slot.slot}</b>
                      {slot.heldTooLong === null ? (
                        <span className="hr-word">{slot.holder === null ? "Free" : "Held"}</span>
                      ) : (
                        <StateLabel
                          label={`Held past its ${slot.heldTooLong.minutes}m ${slot.heldTooLong.kind}`}
                          tone="caution"
                          size="compact"
                        />
                      )}
                    </div>
                    {slot.holder === null ? null : (
                      <>
                        <p className="hr-job">{slot.holder.command}</p>
                        <dl className="hr-kv">
                          <div>
                            <dt>Lane</dt>
                            <dd>{slot.holder.lane ?? `pid ${slot.holder.pid}`}</dd>
                          </div>
                          <div>
                            <dt>Grant</dt>
                            <dd className="hr-mono">{slot.holder.grant ?? "none"}</dd>
                          </div>
                          <div>
                            <dt>Age</dt>
                            <dd>{resourceAge(snapshot.sampledAt - slot.holder.startedAt)}</dd>
                          </div>
                          <div>
                            <dt>Limit</dt>
                            <dd>
                              {slot.limit.kind} {slot.limit.minutes}m
                            </dd>
                          </div>
                        </dl>
                      </>
                    )}
                  </div>
                ))}
              </div>
              {gate.value.fullGateWaiting ? <p className="hr-wait">Full gate waiting for slot 2</p> : null}
            </>
          )}
        </Panel>
        <Panel
          region="jobs"
          old={old}
          note={
            status._tag === "HostOffline"
              ? `Last known, ${lastTime}`
              : jobs._tag === "Reading" && jobs.value.length > 0
                ? `${jobs.value.length} running`
                : undefined
          }
        >
          {jobs._tag === "Unavailable" ? (
            <p className="hr-empty">{unavailableCopy(jobs)}</p>
          ) : jobs.value.length === 0 ? (
            <p className="hr-empty">No heavy job running</p>
          ) : (
            <div className="hr-rows">
              {jobs.value.map((job) => (
                <div className="hr-jrow" key={job.pid}>
                  <span className="hr-lane">{job.lane ?? `pid ${job.pid}`}</span>
                  <span className="hr-job">{job.command}</span>
                  <span className="hr-rss">{resourceBytes(job.rssBytes, true)}</span>
                  <span className="hr-sub">
                    <span className="hr-mono">{grantLabel(job.grant)}</span>
                    <span>started {resourceTime(job.startedAt)}</span>
                  </span>
                  <ProcessList job={job} />
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel
          region="previews"
          old={old}
          note={previews._tag === "Reading" ? `${previews.value.length} listening` : undefined}
        >
          {previews._tag === "Unavailable" ? (
            <p className="hr-empty">{unavailableCopy(previews)}</p>
          ) : (
            <>
              <div className="hr-rows">
                {(morePreviews ? previews.value : previews.value.slice(0, 6)).map((preview) => (
                  <div className="hr-prow" key={preview.port}>
                    <span>{preview.label}</span>
                    <span className="hr-port">:{preview.port}</span>
                    {preview.open._tag === "Unavailable" ? (
                      <span
                        className="hr-meta"
                        title={
                          preview.open._tag === "Unavailable" ? preview.open.reason.replaceAll("_", " ") : undefined
                        }
                      >
                        Open unavailable<small>{previewReasons[preview.open.reason]}</small>
                      </span>
                    ) : (
                      <a
                        href={preview.open.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${preview.label}, port ${preview.port}, opens in a new tab`}
                      >
                        Open
                      </a>
                    )}
                  </div>
                ))}
              </div>
              {previews.value.length > 6 ? (
                <button
                  type="button"
                  className="hr-more"
                  aria-expanded={morePreviews}
                  onClick={() => setMorePreviews((previous) => !previous)}
                >
                  {morePreviews ? "Show less" : `Show ${previews.value.length - 6} more`}
                </button>
              ) : previews.value.length === 0 ? (
                <p className="hr-empty">No preview listening</p>
              ) : null}
            </>
          )}
        </Panel>
        <Panel region="top" old={old}>
          {top._tag === "Unavailable" ? (
            <p className="hr-empty">{unavailableCopy(top)}</p>
          ) : (
            <>
              {top.value.namesAvailable ? null : (
                <div className="hr-panel hr-notice" role="status">
                  <StateLabel label="Agent names unavailable: herdr is not answering." tone="caution" size="compact" />
                </div>
              )}
              <table className="hr-top">
                <thead>
                  <tr>
                    <th scope="col">{top.value.namesAvailable ? "Agent" : "Process"}</th>
                    <th scope="col">Pane</th>
                    <th scope="col">RSS</th>
                    <th scope="col" className="hr-pc">
                      Processes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <Fragment key={group.pane ?? group.pid ?? "other"}>
                      {group.pid === null && names.length > 8 ? (
                        <tr className="hr-more-row">
                          <td colSpan={4}>
                            <button
                              type="button"
                              className="hr-more"
                              aria-expanded={moreMemory}
                              onClick={() => setMoreMemory((previous) => !previous)}
                            >
                              {moreMemory ? "Show less" : `Show ${names.length - 8} more`}
                            </button>
                          </td>
                        </tr>
                      ) : null}
                      <tr data-other={group.pid === null ? "" : undefined}>
                        <th scope="row">
                          {group.pid === null ? "Other (system, browsers)" : (group.lane ?? `pid ${group.pid}`)}
                        </th>
                        <td className="hr-pane">{group.pane ?? (group.pid === null ? "" : "—")}</td>
                        <td className="hr-rss">{resourceBytes(group.rssBytes, true)}</td>
                        <td className="hr-pc">
                          {group.processes} {group.processes === 1 ? "process" : "processes"}
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {names.length > 8 && others.length === 0 ? (
                <button
                  type="button"
                  className="hr-more"
                  aria-expanded={moreMemory}
                  onClick={() => setMoreMemory((previous) => !previous)}
                >
                  {moreMemory ? "Show less" : `Show ${names.length - 8} more`}
                </button>
              ) : null}
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}

const ResourcesPage = ({
  host,
  mount,
  read
}: {
  readonly read: Effect.Effect<HostResources, ResourcesReadFailed>
  readonly host: string
  readonly mount: ModulePageMount
}): ReactElement => {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible")
  const [state, setState] = useState<ResourcesViewState>({ host, snapshot: null, loading: true, reachable: true })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", changed)
    return () => document.removeEventListener("visibilitychange", changed)
  }, [])
  useEffect(() => {
    if (!mount.active || !visible) return
    const update = Effect.gen(function* () {
      const result = yield* Effect.exit(read)
      yield* Effect.sync(() =>
        setState((previous) =>
          Exit.isSuccess(result)
            ? { host: result.value.host, snapshot: result.value, loading: false, reachable: true }
            : { ...previous, loading: false, reachable: false }
        )
      )
    }).pipe(Effect.repeat(Schedule.spaced("10 seconds")))
    const clock = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => setNow(at))
    }).pipe(Effect.repeat(Schedule.spaced("1 second")))
    const polling = Effect.runFork(update)
    const ticking = Effect.runFork(clock)
    return () => {
      Effect.runFork(Fiber.interrupt(polling))
      Effect.runFork(Fiber.interrupt(ticking))
    }
  }, [read, mount.active, visible])
  return <HostResourcesView {...state} host={state.snapshot?.host ?? host} now={now} />
}

/** Polling belongs to the active visible page; closing it interrupts the in-flight request. */
export const makeResourcesModuleViews = (content: {
  readonly host: string
  readonly read: Effect.Effect<HostResources, ResourcesReadFailed>
}): ModuleViews<typeof resourcesModule> => ({
  descriptor: resourcesModule,
  navigationIcon: <ShellIcon name="resources" />,
  pages: { overview: (_search, mount) => <ResourcesPage {...content} mount={mount} /> }
})
