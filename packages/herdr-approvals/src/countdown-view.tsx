/**
 * The Approvals tab as a countdown: the soonest expiry leads the page, pending requests drain
 * toward zero soonest first, and one decision bar sits on the selected request.
 *
 * One DecisionBar only (each mounts its own status region), kept mounted when its request
 * leaves the queue so the hub's answer, or the expiry, is announced there. Ticking clocks are never
 * live; one polite line announces a request entering its last minute. Keyboard shortcuts act on
 * the selected request and obey the same state as the bar, so an off or sending decision cannot
 * be taken by keyboard either.
 *
 * @module
 */
import { DecisionBar, Hero, HeroWord, type RlyDecisionBarState, Region } from "@knpkv/rly/patterns"
import { Button, LimitTrack, Notice } from "@knpkv/rly/primitives"
import { Predicate } from "effect"
import { type KeyboardEvent, type ReactElement, type ReactNode, useEffect, useRef, useState } from "react"
import { jobTitle } from "./activity-history.js"
import { ApprovalRequestDisclosure } from "./approval-request-view.js"
import {
  agoText,
  clockText,
  crossedIntoLastMinute,
  decidedOf,
  factsOf,
  itemKey,
  type PendingFacts,
  type PendingItem,
  pendingItems,
  tickInterval,
  urgencyOf,
  windowUsed
} from "./countdown-model.js"
import type { DashboardSnapshot, PendingApprovalFailure } from "./dashboard-model.js"
import { type ApprovalDecision, approvalShortcutFor } from "./approval-decision.js"

/** The hub's answer to the last decision sent from this page, for the job it decided. */
export interface DecisionStatus {
  readonly jobId: string
  readonly text: string
}

/**
 * Wall-clock milliseconds, re-read after `delayFor(now)` while the page is visible and again
 * when it becomes visible. The clock is a framework boundary, so it reads the browser's time directly.
 */
const useNow = (delayFor: (now: number) => number): number => {
  const [now, setNow] = useState(() => Date.now())
  const delay = delayFor(now)
  useEffect(() => {
    // No ticks while the page is hidden; becoming visible again re-reads the clock and resumes.
    const timer = document.visibilityState === "hidden" ? undefined : window.setTimeout(() => setNow(Date.now()), delay)
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now())
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [delay, now])
  return now
}

const failureText = (failure: PendingApprovalFailure): string => {
  switch (failure.reason) {
    case "offline":
      return `${failure.host} (offline)`
    case "unavailable":
      return `${failure.host} (unavailable)`
    case "timeout":
      return `${failure.host} (timed out)`
    case "request_failed":
      return `${failure.host} (request failed)`
    case "invalid_response":
      return `${failure.host} (invalid answer)`
  }
}

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`

const ApprovalHero = ({
  now,
  snapshot,
  soonest,
  waiting
}: {
  readonly now: number
  readonly snapshot: DashboardSnapshot
  readonly soonest: PendingFacts | undefined
  readonly waiting: number
}) => {
  const unchecked = snapshot.pendingApprovals.failures.length
  if (soonest === undefined) {
    const last = snapshot.records
      .flatMap((record) => {
        const decided = decidedOf(record)
        return decided === null ? [] : [decided]
      })
      .sort((left, right) => right.at - left.at)[0]
    return (
      <Hero
        caption={
          unchecked > 0
            ? `Couldn't check ${snapshot.pendingApprovals.failures.map(failureText).join(", ")}.`
            : last === undefined
              ? "No requests yet."
              : `Last: ${factsLabel(last.record.payload.kind, snapshot.host)}, ${last.outcome.toLowerCase()} ${agoText(
                  last.at,
                  now
                )}.`
        }
        fact={
          unchecked > 0
            ? `Nothing to approve on reachable hosts; ${plural(unchecked, "host", "hosts")} unchecked`
            : "Nothing to approve"
        }
        label="Approval summary"
      />
    )
  }
  const clock = clockText(soonest.expiresAt, now)
  const urgency = soonest.expiresAt === null ? "calm" : urgencyOf(soonest.expiresAt - now)
  const more = waiting - 1
  return (
    <Hero
      caption={`${factsLabel(soonest.kind, soonest.host)}.${more > 0 ? ` ${plural(more, "more", "more")} waiting.` : ""}${
        unchecked > 0 ? ` ${plural(unchecked, "host", "hosts")} unchecked.` : ""
      }`}
      fact={
        clock === null ? (
          <>{soonest.title} is waiting for you</>
        ) : (
          <>
            {clock === "expiring" ? (
              <>{soonest.title} is expiring</>
            ) : (
              <>
                {clock} left on {soonest.title}
              </>
            )}
            {urgency === "soon" ? (
              <>
                , <HeroWord tone="held">expires soon</HeroWord>
              </>
            ) : urgency === "imminent" || urgency === "due" ? (
              <>
                , <HeroWord tone="blocked">about to expire</HeroWord>
              </>
            ) : null}
          </>
        )
      }
      label="Approval summary"
    />
  )
}

const factsLabel = (kind: string, host: string): string => `${kind} on ${host}`

/** The request key a row carries in `data-countdown-row`, for keyboard shortcuts on that row. */
const rowKeyOf = (target: { readonly dataset: unknown }): string | undefined => {
  const dataset = target.dataset
  if (!Predicate.hasProperty(dataset, "countdownRow")) return undefined
  return Predicate.isString(dataset.countdownRow) ? dataset.countdownRow : undefined
}

/**
 * What the bar can do for the selected request. Shared by the bar and the keyboard shortcuts, so
 * both refuse the same things.
 */
const decisionState = ({
  approvalsEnabled,
  gone,
  item,
  sending
}: {
  readonly approvalsEnabled: boolean
  readonly gone: boolean
  readonly item: PendingItem
  readonly sending: ApprovalDecision | null
}): RlyDecisionBarState => {
  if (gone) return { _tag: "off", reason: "This request has left the queue. Nothing was applied from here." }
  if (item._tag === "Remote") return { _tag: "off", reason: `Decided on ${item.host}.` }
  if (sending !== null && sending.jobId === item.record.id) return { _tag: "sending", action: sending.decision }
  if (sending !== null) return { _tag: "off", reason: "Another decision is waiting for the hub." }
  if (!approvalsEnabled) return { _tag: "off", reason: "Approvals are turned off on this host." }
  if (!item.record.approvalAvailable) return { _tag: "off", reason: "This request can't be decided from here." }
  return { _tag: "ready" }
}

/** Why a selected request left the queue, from the hub's own record when it has one. */
const goneStatus = (snapshot: DashboardSnapshot, id: string): string => {
  const record = snapshot.records.find((candidate) => candidate.id === id)
  const decided = record === undefined ? null : decidedOf(record)
  if (decided === null) return "This request left the queue."
  if (decided.outcome === "Expired") return "Expired just now. Nothing was applied."
  return `${decided.outcome}${decided.by === null ? "" : ` by ${decided.by}`}.`
}

const RequestDetail = ({
  answer,
  approvalsEnabled,
  gone,
  item,
  now,
  onDecision,
  sending,
  snapshot
}: {
  readonly answer: string | undefined
  readonly approvalsEnabled: boolean
  readonly gone: boolean
  readonly item: PendingItem
  readonly now: number
  readonly onDecision: ((item: PendingItem, decision: ApprovalDecision["decision"]) => void) | undefined
  readonly sending: ApprovalDecision | null
  readonly snapshot: DashboardSnapshot
}) => {
  const facts = factsOf(item, snapshot.host)
  const unavailable: RlyDecisionBarState = { _tag: "off", reason: "Decisions are unavailable here." }
  const state = onDecision === undefined ? unavailable : decisionState({ approvalsEnabled, gone, item, sending })
  const clock = gone ? null : clockText(facts.expiresAt, now)
  const decide = (decision: "approve" | "reject") => () => {
    if (state._tag === "ready" && onDecision !== undefined) onDecision(item, decision)
  }
  const payload = item._tag === "Local" ? item.record.payload : item.approval.payload
  return (
    <article aria-label={facts.title} className="countdown-detail">
      <p className="countdown-kicker">
        <code>{facts.id}</code>, {facts.host}
      </p>
      <h3 className="countdown-detail-title">{facts.title}</h3>
      <p className="countdown-requested">
        Requested by {facts.actor}, {agoText(facts.createdAt, now)}
      </p>
      <ApprovalRequestDisclosure id={facts.id} payload={payload} />
      {item._tag === "Local" && item.record.connectTarget !== undefined && item.record.worker !== undefined ? (
        <a
          className="worker-connect-link"
          href={new URL(item.record.connectTarget.url, snapshot.approvalApp.canonicalUrl).href}
        >
          Open {item.record.worker.name} in Connect
        </a>
      ) : null}
      <DecisionBar
        {...(clock === null ? {} : { clock: clock === "expiring" ? "expiring" : `${clock} left` })}
        note={
          item._tag === "Remote" ? (
            <a href={item.approvalUrl}>Review on {item.host}</a>
          ) : (
            "If it expires before your decision reaches the hub, you'll see the hub's refusal, not a success."
          )
        }
        onApprove={decide("approve")}
        onReject={decide("reject")}
        state={state}
        {...(answer === undefined ? {} : { status: answer })}
        target={`${facts.title} on ${facts.host}`}
      />
    </article>
  )
}

/** The Approvals tab's body. */
export const ApprovalsCountdown = ({
  decisionStatus,
  historyLoading,
  onDecision,
  onLoadHistory,
  onLoadPending,
  pendingLoading,
  sending,
  snapshot
}: {
  readonly decisionStatus: DecisionStatus | null
  readonly historyLoading: boolean
  readonly onDecision: ((decision: ApprovalDecision) => void) | undefined
  readonly onLoadHistory: (() => void) | undefined
  readonly onLoadPending: (() => void) | undefined
  readonly pendingLoading: boolean
  readonly sending: ApprovalDecision | null
  readonly snapshot: DashboardSnapshot
}): ReactElement => {
  const items = pendingItems(snapshot)
  const facts = items.map((item) => factsOf(item, snapshot.host))
  const now = useNow((at) =>
    tickInterval(
      facts.map(({ expiresAt }) => expiresAt),
      at
    )
  )

  // The selected request, remembered with its item so its detail and bar stay after it leaves
  // the queue; the soonest request is selected until the reader picks one.
  const [picked, setPicked] = useState<{ readonly key: string; readonly item: PendingItem } | null>(null)
  const pickedIndex = picked === null ? -1 : facts.findIndex((candidate) => itemKey(candidate) === picked.key)
  const selected = pickedIndex >= 0 ? items[pickedIndex] : picked !== null ? picked.item : items[0]
  const selectedKey = selected === undefined ? null : itemKey(factsOf(selected, snapshot.host))
  const gone = picked !== null && pickedIndex < 0

  // One polite line for threshold crossings; the ticking text itself is never announced. Runs
  // whenever the clock or the queue changes; the previous reading makes each crossing count once.
  const [announcement, setAnnouncement] = useState("")
  const previousNow = useRef(now)
  useEffect(() => {
    const crossed = crossedIntoLastMinute(facts, previousNow.current, now)
    previousNow.current = now
    if (crossed.length > 0) {
      setAnnouncement(crossed.map(({ host, title }) => `One minute left to decide ${title} on ${host}.`).join(" "))
    }
  }, [facts, now])

  // Your own decision keeps the hub's answer, also after the request leaves the queue; any other
  // departure says why from the hub's record.
  const selectedId = selected === undefined ? null : factsOf(selected, snapshot.host).id
  const answer =
    selected === undefined || selectedId === null
      ? undefined
      : selected._tag === "Local" && decisionStatus?.jobId === selectedId
        ? decisionStatus.text
        : gone
          ? goneStatus(snapshot, selectedId)
          : undefined

  // Deciding pins the decided request, so the bar and its status stay on it when it leaves the
  // queue instead of moving to the next request, which a second shortcut would then decide.
  const decideItem = (item: PendingItem, decision: ApprovalDecision["decision"]): void => {
    if (onDecision === undefined || item._tag !== "Local") return
    setPicked({ item, key: itemKey(factsOf(item, snapshot.host)) })
    onDecision({ decision, jobId: item.record.id })
  }

  // A shortcut on a row decides that row's request (and selects it); anywhere else in the page it
  // decides the selected request. Either way it obeys the same state as the bar.
  const onShortcut = (event: KeyboardEvent<HTMLElement>): void => {
    const decision = approvalShortcutFor({
      key: event.key,
      modified: event.ctrlKey || event.metaKey,
      shift: event.shiftKey
    })
    if (decision === null || onDecision === undefined) return
    const rowKey = Predicate.hasProperty(event.target, "dataset") ? rowKeyOf(event.target) : undefined
    const rowIndex = rowKey === undefined ? -1 : facts.findIndex((candidate) => itemKey(candidate) === rowKey)
    const target = rowIndex >= 0 ? items[rowIndex] : selected
    if (target === undefined) return
    event.preventDefault()
    const targetGone = target === selected && gone
    const state = decisionState({
      approvalsEnabled: snapshot.approvalsEnabled,
      gone: targetGone,
      item: target,
      sending
    })
    if (state._tag === "ready") decideItem(target, decision)
    else if (rowIndex >= 0) setPicked({ item: target, key: itemKey(factsOf(target, snapshot.host)) })
  }

  const moveRowFocus = (event: KeyboardEvent<HTMLUListElement>): void => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-countdown-row]")]
    const index = rows.findIndex((row) => row === event.target)
    if (index < 0) return
    const next =
      event.key === "ArrowDown" || event.key === "j"
        ? (index + 1) % rows.length
        : event.key === "ArrowUp" || event.key === "k"
          ? (index - 1 + rows.length) % rows.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    rows.at(next)?.focus()
  }

  const decided = snapshot.records
    .flatMap((record) => {
      const item = decidedOf(record)
      return item === null ? [] : [item]
    })
    .sort((left, right) => right.at - left.at)
    .slice(0, 10)
  const unchecked = snapshot.pendingApprovals.failures

  const regionNote = (children: ReactNode, tone: "caution" | "critical") => (
    <Notice className="countdown-note" tone={tone}>
      {children}
    </Notice>
  )

  return (
    <div className="countdown" onKeyDown={onShortcut}>
      <ApprovalHero now={now} snapshot={snapshot} soonest={facts[0]} waiting={items.length} />
      <p aria-atomic="true" aria-live="polite" className="countdown-announcer">
        {announcement}
      </p>
      {snapshot.approvalsEnabled
        ? null
        : regionNote("Approvals are turned off on this host, so Approve and Reject are off.", "caution")}
      {unchecked.length === 0
        ? null
        : regionNote(
            `Couldn't check ${unchecked.map(failureText).join(", ")}. Requests on reachable hosts are listed; local approvals still work.`,
            "critical"
          )}
      <div className="countdown-regions" data-has-selection={selected !== undefined}>
        <Region
          className="countdown-waiting"
          count={unchecked.length > 0 ? `${String(items.length)}+` : items.length}
          title="Waiting for you"
        >
          {items.length === 0 ? (
            <p className="countdown-empty">Nothing is waiting for your decision.</p>
          ) : (
            <ul className="countdown-rows" onKeyDown={moveRowFocus}>
              {items.map((item, index) => {
                const row = facts[index]
                if (row === undefined) return null
                const key = itemKey(row)
                const clock = clockText(row.expiresAt, now)
                const used = windowUsed(row.createdAt, row.expiresAt, now)
                return (
                  <li key={key}>
                    <button
                      aria-current={key === selectedKey ? "true" : undefined}
                      className="countdown-row"
                      data-countdown-row={key}
                      onClick={() => setPicked({ item, key })}
                      type="button"
                    >
                      <span className="countdown-row-meta">
                        <code>{row.kind}</code>, {row.host}
                      </span>
                      <span className="countdown-row-title">{row.title}</span>
                      {clock === null ? null : (
                        <span
                          className="countdown-row-clock"
                          data-urgency={row.expiresAt === null ? "calm" : urgencyOf(row.expiresAt - now)}
                        >
                          {clock}
                        </span>
                      )}
                      {used === null ? null : (
                        // Decorative: the clock beside it says the same in words.
                        <LimitTrack className="countdown-row-track" near={used.near} size="slim" value={used.value} />
                      )}
                      <small className="countdown-row-caption">
                        from {row.actor}
                        {item._tag === "Remote" ? `, decided on ${item.host}` : ""}
                      </small>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {snapshot.pendingApprovals.nextCursors.length === 0 ? null : (
            <div className="countdown-more">
              <Button loading={pendingLoading} onClick={onLoadPending} type="button" variant="quiet">
                Load more approvals
              </Button>
            </div>
          )}
        </Region>
        {selected === undefined ? null : (
          <Region className="countdown-selected" title="Selected request">
            <RequestDetail
              answer={answer}
              approvalsEnabled={snapshot.approvalsEnabled}
              gone={gone}
              item={selected}
              now={now}
              onDecision={onDecision === undefined ? undefined : decideItem}
              sending={sending}
              snapshot={snapshot}
            />
          </Region>
        )}
        <Region className="countdown-decided" count={decided.length} title="Recently decided">
          {decided.length === 0 ? (
            <p className="countdown-empty">No decisions yet.</p>
          ) : (
            <ul className="countdown-rows countdown-decided-rows">
              {decided.map(({ at, by, outcome, record }) => (
                <li className="countdown-decided-row" key={record.id}>
                  <span className="countdown-outcome" data-outcome={outcome}>
                    {outcome}
                  </span>
                  <span className="countdown-row-title">{jobTitle(record)}</span>
                  <small className="countdown-row-caption">
                    <code>{record.payload.kind}</code>
                    {by === null ? "" : `, by ${by}`}, {agoText(at, now)}
                  </small>
                  <ApprovalRequestDisclosure id={record.id} payload={record.payload} />
                </li>
              ))}
            </ul>
          )}
          {snapshot.historyNextCursor === null ? null : (
            <div className="countdown-more">
              <Button loading={historyLoading} onClick={onLoadHistory} type="button" variant="quiet">
                Load earlier decisions
              </Button>
            </div>
          )}
        </Region>
      </div>
    </div>
  )
}
