import { Creature } from "@knpkv/herdr-connect/surface"
import type { ReactElement, ReactNode } from "react"
import { jobKindTitle } from "./activity-history.js"
import {
  fleetModule,
  usageModule,
  moduleHref,
  type NeedsYouDestination,
  type NeedsYouItem,
  type NeedsYouResult,
  type NeedsYouSource
} from "./modules.js"

export interface TodayReadState {
  readonly reading: { readonly result: NeedsYouResult; readonly checkedAt: number } | null
  readonly failed: boolean
}

export interface TodayViewProps {
  readonly state: TodayReadState
  /** Hub time from the existing dashboard owner, shared with Fleet's countdowns. */
  readonly now: number
  readonly agents: ReactNode
  readonly history: ReactNode
  /** Retarget Room to work only when the shell has installed Usage details. */
  readonly usageDetails?: boolean
}

/** Each wire selector maps to the owning module's exact page; keys remain opaque. */
const destinationHref = (destination: NeedsYouDestination): string => {
  switch (destination._tag) {
    case "FleetApproval":
      return moduleHref(
        fleetModule,
        "approvals",
        new URLSearchParams({
          approvalHost: destination.host,
          approvalJob: destination.jobId
        })
      )
    case "ModulePage": {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(destination.query)) params.set(key, value)
      params.delete("tab")
      const encoded = params.toString()
      return `?${encoded}#${destination.module}/${destination.page}`
    }
  }
}

const rowTitle = (kind: NeedsYouItem["kind"]): string => {
  switch (kind) {
    case "sandbox-quarantined":
      return "Quarantined sandbox"
    case "sandbox-budget-hold":
      return "Sandbox budget hold"
    default:
      return jobKindTitle(kind)
  }
}

const expiryLabel = (expiresAt: number | null, now: number): string => {
  if (expiresAt === null) return "No expiry"
  if (expiresAt <= now) return "Expired"
  const seconds = Math.ceil((expiresAt - now) / 1_000)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes === 0 ? `${seconds}s left` : `${minutes}m${remainder === 0 ? "" : ` ${remainder}s`} left`
}

const sourceCopy = (source: NeedsYouSource): string => {
  const provider = source.provider === "fleet" ? "Fleet" : source.provider
  switch (source.issue.state) {
    case "truncated":
      return `More ${provider} approvals may be waiting. Open Fleet to read the rest.`
    case "failed":
      return `Couldn't finish ${provider} discovery. Checking again while Today is open.`
    case "hosts":
      return source.issue.hosts
        .map(({ host, reason }) => {
          const words = {
            offline: "is offline",
            unavailable: "has no approval listener",
            timeout: "didn't answer in time",
            request_failed: "couldn't be read",
            invalid_response: "returned invalid data",
            internal: "couldn't be read"
          } satisfies Record<typeof reason, string>
          return `${host} ${words[reason]}.`
        })
        .join(" ")
  }
}

const RequestRow = ({ item, now }: { readonly item: NeedsYouItem; readonly now: number }): ReactElement => {
  if (item.destination._tag === "ModulePage") {
    return (
      <li>
        <a className="today-request" href={destinationHref(item.destination)}>
          <span className="today-request-copy">
            <small>{item.destination.module}</small>
            <strong>{rowTitle(item.kind)}</strong>
          </span>
        </a>
      </li>
    )
  }
  const expired = item.expiresAt !== null && item.expiresAt <= now
  const urgent = item.expiresAt !== null && item.expiresAt > now && item.expiresAt - now <= 300_000
  return (
    <li>
      <a className="today-request" data-urgent={urgent} data-expired={expired} href={destinationHref(item.destination)}>
        <Creature host={item.destination.host} id={item.actor} size="row" state={expired ? "done" : "waiting"} />
        <span className="today-request-copy">
          <small>Fleet / Approvals</small>
          <strong>{rowTitle(item.kind)}</strong>
          <span>
            {item.actor} asks on {item.destination.host}
          </span>
          <span className="connect-visually-hidden">Approval {item.destination.jobId}</span>
        </span>
        <span className="today-request-expiry">{expiryLabel(item.expiresAt, now)}</span>
        <span aria-hidden="true" className="today-chevron">
          ›
        </span>
      </a>
    </li>
  )
}

/** Read-only, bounded discovery. A partial or old reading never claims the fleet is clear. */
export const TodayView = ({ agents, history, now, state, usageDetails = false }: TodayViewProps): ReactElement => {
  const result = state.reading?.result
  const items = result?.items ?? []
  const waiting = items.filter((item) => item.expiresAt === null || item.expiresAt > now)
  const expired = items.filter((item) => item.expiresAt !== null && item.expiresAt <= now)
  const orderedItems = [...waiting, ...expired]
  const partial = result?._tag === "Partial"
  const clear = result?._tag === "Complete" && items.length === 0 && !state.failed
  const freshness =
    state.reading === null
      ? "Checking"
      : `${state.failed ? "Previous reading" : "Checked"} ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(state.reading.checkedAt)}`
  const heading =
    result === undefined
      ? state.failed
        ? "Couldn't read your fleet."
        : "Checking your fleet."
      : state.failed
        ? `Previous reading: ${partial ? "at least " : ""}${items.length} ${items.length === 1 ? "approval" : "approvals"}.`
        : clear
          ? "You're clear."
          : items.length === 0
            ? "Discovery is incomplete."
            : `${waiting.length === 0 ? (partial ? "No waiting approvals were read." : "No approvals are waiting.") : `${partial ? "At least " : ""}${waiting.length} ${waiting.length === 1 ? "thing needs" : "things need"} you.`}${expired.length === 0 ? "" : ` ${expired.length} expired.`}`
  return (
    <div className="today-page" data-clear={clear}>
      <header className="today-intro">
        <p className="today-date">
          {new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(now)}
        </p>
        <div className="today-hero">
          <div>
            <h1>{heading}</h1>
            <p>
              {clear
                ? "No Fleet approvals are waiting. Your agents can keep moving."
                : "Fleet approvals, ordered by expiry. Each opens its owning page."}
            </p>
          </div>
          {clear ? null : (
            <span className="today-hero-character" aria-hidden="true">
              <Creature host="relay" id="assistant" size="cast" state="waiting" />
            </span>
          )}
        </div>
      </header>
      <div className="today-columns">
        <section
          className="today-needs-you"
          aria-labelledby={clear ? "today-clear-heading" : "today-needs-you-heading"}
        >
          {clear ? null : (
            <div className="today-section-heading">
              <h2 id="today-needs-you-heading">Needs you</h2>
              <span>{freshness}</span>
            </div>
          )}
          {state.failed ? (
            <p className="today-read-notice" role="status">
              Couldn't refresh. {state.reading === null ? "No reading is available yet." : "Previous reading shown."}{" "}
              Checking again while Today is open.
            </p>
          ) : null}
          {result?._tag === "Partial" ? (
            <ul className="today-source-issues" aria-label="Discovery incomplete">
              {result.sources.map((source, index) => (
                <li key={`${source.provider}:${index}`}>{sourceCopy(source)}</li>
              ))}
            </ul>
          ) : null}
          {items.length > 0 ? (
            <ul className="today-request-list">
              {orderedItems.map((item) => (
                <RequestRow item={item} now={now} key={item.key} />
              ))}
            </ul>
          ) : clear ? (
            <div className="today-empty">
              <Creature host="relay" id="assistant" size="cast" state="idle" />
              <h2 id="today-clear-heading">A quiet day for your fleet</h2>
              <p>{freshness}</p>
              <p>Nothing needs an approval in the current Fleet reading.</p>
              <a className="today-link" href={moduleHref(fleetModule, "connect")}>
                See your bots <span aria-hidden="true">›</span>
              </a>
            </div>
          ) : result !== undefined && items.length === 0 ? (
            <p className="today-empty-copy">No approvals were read. Some sources are unchecked.</p>
          ) : null}
          {clear ? null : (
            <p className="today-list-note">
              Fleet discovery only. Opening an approval lets Fleet read and verify the full request.
            </p>
          )}
        </section>
        <aside className="today-right-rail" aria-label="Fleet activity">
          {agents}
          {history}
          <section className="today-rail-section">
            <h2>Room to work</h2>
            <p>
              {usageDetails
                ? "Read reported usage and limits in Usage details."
                : "Read your current local usage and limits in Fleet."}
            </p>
            <a
              className="today-link"
              href={usageDetails ? moduleHref(usageModule, "limits") : moduleHref(fleetModule, "usage")}
            >
              {usageDetails ? "Check limits" : "Check local limits"} <span aria-hidden="true">›</span>
            </a>
          </section>
        </aside>
      </div>
    </div>
  )
}
