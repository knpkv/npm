import type { FleetLimits, Received } from "@knpkv/herdr-connect/usage"
import { Button, LimitTrack, Notice, Skeleton, StateLabel } from "@knpkv/rly/primitives"
import { Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import type { ReactElement } from "react"
import { type LimitsCard, limitsPage } from "./usage-limits-page.js"

const Card = ({ card }: { readonly card: LimitsCard }): ReactElement => (
  <section className="usage-limits-card" aria-label={`${card.name} limits`} data-tool={card.agent}>
    <div className="usage-limits-card-head">
      <h2>{card.name}</h2>
      <small>{card.read}</small>
    </div>
    <div className="usage-limits-figure">
      <b data-unknown={card.figure === null ? "true" : undefined}>
        {card.figure === null ? "Unknown" : `${String(card.figure)}%`}
      </b>
      <span>{card.measures}</span>
    </div>
    {card.state === null ? null : (
      <span>
        <StateLabel label={card.state.label} tone={card.state.tone} size="compact" />
      </span>
    )}
    {card.track === null ? null : (
      <div>
        <span className="usage-limits-sr">
          {card.track.label}: {card.track.valueText}
        </span>
        <LimitTrack value={card.track.value} stale={card.track.stale} />
      </div>
    )}
    <dl>
      {card.details.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd data-unknown={value === null ? "true" : undefined}>{value ?? "Unknown"}</dd>
        </div>
      ))}
    </dl>
    {card.note === null ? null : <p className="usage-limits-note">{card.note}</p>}
  </section>
)

/**
 * The Limits page body the 06 Usage design draws for the hub's own read: notices, the verdict, one card per tool.
 * Loading and a first failed read keep the reference's skeleton and retry line; a failed refresh keeps the last
 * reading and says so. `now` is this page's clock, compared only with when the page received the read.
 */
export const UsageLimitsReadings = ({
  host,
  limits,
  now,
  onRetry,
  timeZone
}: {
  readonly host: string
  readonly limits: AsyncResult.AsyncResult<Received<FleetLimits>, unknown>
  readonly now: number
  readonly onRetry: () => void
  readonly timeZone: string
}): ReactElement => {
  const last = Option.getOrNull(AsyncResult.value(limits))
  const failed = AsyncResult.isFailure(limits)
  if (last === null && failed) {
    return (
      <div className="usage-limits-unavailable">
        <div className="usage-limits-controls">
          <Button variant="secondary" size="dense" data-region="action" onClick={onRetry}>
            Retry
          </Button>
        </div>
        <p className="usage-limits-retry" role="status" data-region="notice">
          Couldn't load limits. Trying again every minute.
        </p>
      </div>
    )
  }
  if (last === null) {
    return (
      <div className="usage-limits-loading" aria-label="Loading limits" aria-busy="true" data-region="cards">
        <Skeleton variant="text" style={{ inlineSize: "9rem" }} />
        <Skeleton variant="block" style={{ blockSize: "76px" }} />
        <Skeleton variant="block" style={{ blockSize: "76px" }} />
        <Skeleton variant="block" style={{ blockSize: "76px" }} />
      </div>
    )
  }
  const page = limitsPage(last.fleet, host, now - last.receivedAt, timeZone)
  const notices = [
    ...(failed
      ? [{ title: "Couldn't refresh limits.", text: "This is the previous reading. Trying again every minute." }]
      : []),
    ...(page?.notices ?? [])
  ]
  return (
    <>
      {notices.length === 0 ? null : (
        <div className="usage-limits-notices" data-region="notice">
          {notices.map((notice) => (
            <Notice key={notice.title} tone="caution">
              <span>
                <b>{notice.title}</b> {notice.text}
              </span>
            </Notice>
          ))}
        </div>
      )}
      {page === null ? (
        <p className="usage-limits-retry" role="status">
          No limits reading from {host} yet.
        </p>
      ) : (
        <>
          <section className="usage-limits-summary" aria-label="Room to work" data-region="summary">
            <h2>{page.summary.verdict}</h2>
            <p>{page.summary.note}</p>
          </section>
          <div className="usage-limits-cards" data-region="cards">
            {page.cards.map((card) => (
              <Card key={card.agent} card={card} />
            ))}
          </div>
        </>
      )}
    </>
  )
}
