import { Button, Skeleton, StateLabel, Text } from "@knpkv/rly/primitives"
import { DateTime, Option, Schema } from "effect"
import { useId, type ReactElement } from "react"
import type { PlanSource, PlanState, PublishedPlan } from "../plan.js"

export interface PlanViewProps {
  readonly state: PlanState
  /** Re-read CI only. The mounting application never starts a plan through this callback. */
  readonly onReadAgain: () => void
}

const RunLink = ({ href }: { readonly href: string }): ReactElement => (
  <a
    className="ac-detail-link ac-plan-run"
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    aria-label="View run on GitHub, opens in a new tab"
  >
    View run on GitHub <span aria-hidden="true">↗</span>
  </a>
)
const publishedLabel = (source: PlanSource, expired: boolean): string => {
  if (expired) return `${source.ageDays} days ago`
  const parsed = Option.getOrNull(Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)(source.publishedAt))
  if (parsed === null) return "Unknown"
  const time = DateTime.format(parsed, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    locale: "en-GB"
  })
  return source.ageDays === 0
    ? `${time} today`
    : `${DateTime.format(parsed, { day: "numeric", month: "short", timeZone: "UTC", locale: "en-GB" })} · ${time}`
}
const SourceLine = ({
  expired = false,
  showBase = true,
  source
}: {
  readonly source: PlanSource
  readonly expired?: boolean
  readonly showBase?: boolean
}): ReactElement => (
  <p className="ac-plan-source">
    {source.pr === null ? null : <span>PR #{source.pr}</span>}
    <span>· head {source.head}</span>
    {showBase && source.base !== null ? <span>· base {source.base}</span> : null}
    {showBase || expired ? <span>· published {publishedLabel(source, expired)}</span> : null}
  </p>
)
const MobileLabel = ({ children }: { readonly children: string }): ReactElement => (
  <small className="ac-plan-mobile-label" aria-hidden="true">
    {children}
  </small>
)

const Published = ({ plan, title }: { readonly plan: PublishedPlan; readonly title: string }): ReactElement => {
  const heading = useId()
  const updates = plan.rows.filter((row) => row.action === "update").length
  const unchanged = plan.rows.length - updates
  return (
    <>
      <div className="ac-plan-heading">
        <Text as="h2" id={heading} className="ac-plan-title">
          {title}
        </Text>
        <div className="ac-plan-source-row">
          <SourceLine source={plan.source} />
          <RunLink href={plan.source.runHref} />
        </div>
        <small className="ac-plan-assurance">
          Published by CI. Plan data was produced by the pull request’s code; this console doesn’t run it.
        </small>
      </div>
      {plan.stale === null ? null : (
        <div className="ac-plan-notice" role="note">
          <b>This plan may be out of date</b>
          <span className="ac-plan-reason">
            {plan.stale === "base"
              ? "Its base doesn’t match the latest main commit CI has seen."
              : plan.stale === "failed"
                ? "A newer plan run failed."
                : `Published ${plan.source.ageDays} ${plan.source.ageDays === 1 ? "day" : "days"} ago.`}
          </span>
        </div>
      )}
      <div className="ac-plan-summary">
        {updates === 0
          ? "No changes in this plan."
          : `${updates} ${updates === 1 ? "update" : "updates"} · ${unchanged} unchanged`}
      </div>
      <table role="table" className="ac-plan-table" aria-labelledby={heading}>
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col">
              Resource
            </th>
            <th role="columnheader" scope="col">
              Type
            </th>
            <th role="columnheader" scope="col">
              Change
            </th>
            <th role="columnheader" scope="col">
              Changed properties
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {plan.rows.map((row) => (
            <tr role="row" key={row.fqn}>
              <th role="rowheader" scope="row">
                <MobileLabel>Resource</MobileLabel>
                <b className="ac-plan-resource">{row.fqn}</b>
              </th>
              <td role="cell">
                <MobileLabel>Type</MobileLabel>
                <span className="ac-plan-type" title={row.resourceType}>
                  {row.resourceType}
                </span>
              </td>
              <td role="cell">
                <MobileLabel>Change</MobileLabel>
                <span>
                  <StateLabel
                    label={row.action === "update" ? "Update" : "No change"}
                    tone={row.action === "update" ? "caution" : "neutral"}
                    size="compact"
                  />
                </span>
              </td>
              <td role="cell">
                <MobileLabel>Changed properties</MobileLabel>
                {row.changedKeys.length === 0 ? (
                  <span className="ac-plan-muted" aria-label="None">
                    —
                  </span>
                ) : (
                  <span className="ac-plan-keys">
                    {row.changedKeys.map((key, index) => (
                      <code key={`${key}-${index}`}>{key}</code>
                    ))}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="ac-plan-footer">
        <span>CI publishes property names only; values aren’t shown.</span>
        <span className="ac-plan-digest">Digest {plan.digest}</span>
      </footer>
    </>
  )
}
const emptyCopy = {
  NotPublished: [
    "No CI plan for this stack yet.",
    "A plan appears here after CI plans a pull request that touches this stack."
  ],
  NotPublishing: [
    "CI isn’t publishing plans right now.",
    "Plans resume here once infrastructure CI publishes them again."
  ],
  NotConnected: [
    "CI plans aren’t connected for this stack.",
    "Plans can be shown for stacks that infrastructure CI plans. Set up CI plan reading to see them here."
  ],
  Expired: [
    "The latest CI plan has expired.",
    "CI keeps plans for 14 days. A new one appears after the next pull request plan."
  ],
  Unverified: ["This CI plan couldn’t be verified, so it isn’t shown.", "Its contents didn’t match what CI recorded."],
  Unreachable: ["Couldn’t reach CI to read plans.", "No plan is shown until CI can be read."],
  Refused: ["CI refused access to plans.", "Ask whoever manages this console’s CI access."]
} satisfies Record<Exclude<PlanState["_tag"], "Loading" | "Ready" | "Failed">, readonly [string, string]>

/** Controlled CI publication display. Invalid and unavailable states have no resource rows; Retry is a read callback only. */
export const PlanView = ({ onReadAgain, state }: PlanViewProps): ReactElement => {
  if (state._tag === "Ready")
    return (
      <section className="ac-plan" aria-label="Latest CI plan">
        <Published plan={state.plan} title="Latest CI plan" />
      </section>
    )
  if (state._tag === "Loading")
    return (
      <section className="ac-plan" aria-label="Latest CI plan" aria-busy="true">
        <div className="ac-plan-loading-heading">
          <Text as="h2" className="ac-plan-title">
            Latest CI plan
          </Text>
          <Skeleton variant="text" width="18rem" decorative />
          <Skeleton variant="text" width="10rem" decorative />
        </div>
        <p role="status" className="ac-plan-loading-copy">
          Reading the latest CI plan…
        </p>
        <div className="ac-plan-skeletons">
          {[1, 2, 3, 4].map((key) => (
            <Skeleton key={key} variant="block" height="3.5rem" decorative />
          ))}
        </div>
      </section>
    )
  if (state._tag === "Failed")
    return (
      <section className="ac-plan" aria-label="Latest CI plan">
        <Text as="h2" className="ac-plan-title">
          Latest CI plan
        </Text>
        <div className="ac-plan-notice ac-plan-failed" role="status">
          <StateLabel label="Failed" tone="critical" size="compact" />
          <b>The latest CI plan run failed.</b>
          <RunLink href={state.runHref} />
        </div>
        {state.lastPublished === null ? null : <Published plan={state.lastPublished} title="Last published plan" />}
      </section>
    )
  const [title, description] = emptyCopy[state._tag]
  const source = state._tag === "Expired" || state._tag === "Unverified" ? state.source : null
  return (
    <section className="ac-plan" aria-label="Latest CI plan">
      <Text as="h2" className="ac-plan-title">
        Latest CI plan
      </Text>
      <div className="ac-plan-empty" role="status">
        <h3>{title}</h3>
        <p>{description}</p>
        {source === null ? null : <SourceLine source={source} expired={state._tag === "Expired"} showBase={false} />}
        {state._tag === "Unverified" && source !== null ? <RunLink href={source.runHref} /> : null}
        {state._tag === "Unreachable" ? (
          <>
            <Button variant="secondary" onClick={onReadAgain}>
              Retry
            </Button>
            <small>Retry reads again. It never runs a plan.</small>
          </>
        ) : null}
      </div>
    </section>
  )
}
