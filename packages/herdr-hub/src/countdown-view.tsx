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
import {
  DecisionBar,
  Hero,
  HeroWord,
  type RlyDecisionBarOutcome,
  type RlyDecisionBarState,
  Region
} from "@knpkv/rly/patterns"
import { Button, LimitTrack, Notice, TrackKey } from "@knpkv/rly/primitives"
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
  REVALIDATE_RETRY_MS,
  urgencyOf,
  windowUsed
} from "./countdown-model.js"
import type { DashboardSnapshot, PendingApprovalFailure } from "./dashboard-model.js"
import { type ApprovalDecision, approvalShortcutFor } from "./approval-decision.js"
import { useHubNow } from "./hub-clock.js"

/** The hub's answer to the last decision sent from this page, for the job it decided. */
export interface DecisionStatus {
  readonly jobId: string
  /**
   * The hub accepted or refused it: the bar stays off for this request until a newer snapshot than
   * `observedAt` shows its state. A newer read that still lists it as decidable lets it be retried.
   */
  readonly settles: boolean
  /** `observedAt` of the snapshot on screen when the answer arrived. */
  readonly observedAt: number
  readonly text: string
  /** How the hub answered, in the Work board's words. */
  readonly outcome: "accepted" | "refused" | "uncertain"
  /** The decided request's expiry when the decision was sent, so a new request on the same job is told apart. */
  readonly expiresAt: number | null | undefined
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
        // Which hosts couldn't be checked is said once, in the notice under the hero.
        caption={
          last === undefined ? (
            "No requests yet."
          ) : (
            <>
              Last: {factsLabel(last.record.payload.kind, snapshot.host)}, {last.outcome.toLowerCase()}{" "}
              <span className="countdown-nowrap">{agoText(last.at, now)}</span>.
            </>
          )
        }
        fact={
          unchecked > 0
            ? `Nothing to approve on reachable hosts; ${plural(unchecked, "host", "hosts")} unchecked`
            : snapshot.pendingApprovals.nextCursors.length > 0
              ? "Nothing on the first page; more requests aren't loaded yet"
              : "Nothing to approve"
        }
        label="Approval summary"
      />
    )
  }
  const clock = clockText(soonest.expiresAt, now)
  const urgency = soonest.expiresAt === null ? "calm" : urgencyOf(soonest.expiresAt - now)
  const more = waiting - 1
  // Pages come newest first, so a request on a page not loaded yet may expire sooner than this one.
  const partial = snapshot.pendingApprovals.nextCursors.length > 0
  return (
    <Hero
      caption={`${factsLabel(soonest.kind, soonest.host)}.${more > 0 ? ` ${plural(more, "more", "more")} waiting.` : ""}${
        unchecked > 0 ? ` ${plural(unchecked, "host", "hosts")} unchecked.` : ""
      }${partial ? " More requests aren't loaded yet; one of them may expire sooner." : ""}`}
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
            ) : urgency === "imminent" ? (
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
  sending,
  settled
}: {
  readonly approvalsEnabled: boolean
  readonly gone: Departure | null
  readonly item: PendingItem
  readonly sending: ApprovalDecision | null
  readonly settled: boolean
}): RlyDecisionBarState => {
  if (gone !== null) return { _tag: "off", reason: gone.word }
  if (item._tag === "Remote") return { _tag: "off", reason: `Decided on ${item.host}.` }
  if (sending !== null && sending.jobId === item.record.id) return { _tag: "sending", action: sending.decision }
  if (settled) return { _tag: "off", reason: "The hub has answered this decision; the list shows its current state." }
  if (sending !== null) return { _tag: "off", reason: "Another decision is waiting for the hub." }
  if (!approvalsEnabled) return { _tag: "off", reason: "Approvals are turned off on this host." }
  if (!item.record.approvalAvailable) return { _tag: "off", reason: "This request can't be decided from here." }
  return { _tag: "ready" }
}

/**
 * Why a request the reader was looking at is no longer listed, or `null` when its absence proves
 * nothing: a local request still pending, or one on a page not loaded yet, and a remote request
 * on a host that could not be checked. Only local history is consulted, and only for local requests.
 */
/** What a request the hub expired says, wherever it is shown. */
const EXPIRED_TEXT = "Expired just now. Nothing was applied."

/** A request the hub decided: its outcome as a toned word, and who decided it, when. */
interface Decided {
  readonly badge: RlyDecisionBarOutcome
  readonly by: string | null
  readonly at: number
}

/**
 * How a request left the queue: a short word for the bar's reason, and the full sentence. A decided
 * request also carries its outcome, which the bar shows as a badge with who and when beside it.
 */
interface Departure {
  readonly word: string
  readonly text: string
  readonly decided?: Decided
}

/** Expired is neutral: nothing happened, so nothing to celebrate or alarm about. */
const outcomeBadge = (outcome: "Approved" | "Rejected" | "Expired"): RlyDecisionBarOutcome => {
  switch (outcome) {
    case "Approved":
      return { icon: "check", label: "Approved", tone: "positive" }
    case "Rejected":
      return { icon: "close", label: "Rejected", tone: "critical" }
    case "Expired":
      return { icon: "clock", label: "Expired", tone: "neutral" }
  }
}

/**
 * The quiet line beside a decided request's badge. An expiry says what it means rather than when:
 * a record without its own expiry time falls back to its last update, which would mislead.
 */
const decidedLine = ({ at, badge, by }: Decided, now: number): string =>
  badge.label === "Expired" ? "Nothing was applied." : by === null ? agoText(at, now) : `by ${by}, ${agoText(at, now)}`

/**
 * Why a request the reader was looking at is no longer listed, or `null` when its absence proves
 * nothing: a local request still pending, or one on a page not loaded yet, and a remote request
 * on a host that could not be checked or has more pages. Only local history is consulted, and only
 * for local requests.
 */
const departureOf = (snapshot: DashboardSnapshot, item: PendingItem): Departure | null => {
  if (item._tag === "Remote") {
    const sameHost = (host: string) => host.toLowerCase() === item.host.toLowerCase()
    const unproven =
      snapshot.pendingApprovals.failures.some(({ host }) => sameHost(host)) ||
      snapshot.pendingApprovals.nextCursors.some(({ host }) => sameHost(host))
    return unproven ? null : { text: `This request left ${item.host}'s queue.`, word: "Left the queue." }
  }
  const record = snapshot.records.find((candidate) => candidate.id === item.record.id)
  if (record !== undefined && record.status === "pending_approval") return null
  const decided = record === undefined ? null : decidedOf(record)
  if (decided !== null) {
    const outcome = { at: decided.at, badge: outcomeBadge(decided.outcome), by: decided.by }
    return decided.outcome === "Expired"
      ? { decided: outcome, text: EXPIRED_TEXT, word: "Expired." }
      : {
          decided: outcome,
          text: `${decided.outcome}${decided.by === null ? "" : ` by ${decided.by}`}.`,
          word: `${decided.outcome}.`
        }
  }
  // Only another page of this host's queue can still hold it; a remote host's pages cannot.
  return snapshot.pendingApprovals.nextCursors.some(({ host }) => host.toLowerCase() === snapshot.host.toLowerCase())
    ? null
    : { text: "This request left the queue.", word: "Left the queue." }
}

const RequestDetail = ({
  answer,
  decided,
  gone,
  item,
  now,
  onDecision,
  snapshot,
  state
}: {
  readonly answer: string | undefined
  /** Set when the answer is the hub's record of how the request was decided. */
  readonly decided: Decided | undefined
  readonly gone: boolean
  readonly item: PendingItem
  readonly now: number
  readonly onDecision: (item: PendingItem, decision: ApprovalDecision["decision"]) => void
  readonly snapshot: DashboardSnapshot
  readonly state: RlyDecisionBarState
}) => {
  const facts = factsOf(item, snapshot.host)
  const clock = gone ? null : clockText(facts.expiresAt, now)
  const decide = (decision: "approve" | "reject") => () => {
    if (state._tag === "ready") onDecision(item, decision)
  }
  const payload = item._tag === "Local" ? item.record.payload : item.approval.payload
  return (
    <article aria-label={facts.title} className="countdown-detail">
      <p className="countdown-kicker">
        <code>{facts.id}</code>, {facts.host}
      </p>
      <h3 className="countdown-detail-title">{facts.title}</h3>
      <p className="countdown-requested">
        Requested by {facts.actor}, <span className="countdown-nowrap">{agoText(facts.createdAt, now)}</span>
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
      {item._tag === "Remote" ? (
        // Decided on its own host: the review link is the action here, not an inert bar.
        <div className="countdown-remote">
          <p className="countdown-remote-target">
            {facts.kind} on {facts.host}
            {clock === null ? null : (
              <>
                , <span className="countdown-nowrap">{clock === "expiring" ? "expiring" : `${clock} left`}</span>
              </>
            )}
          </p>
          <a className="countdown-review-link" href={item.approvalUrl}>
            Review on {facts.host}
          </a>
          <p className="countdown-remote-note">Approve or reject it on {facts.host}.</p>
          <p aria-atomic="true" className="countdown-remote-status" role="status">
            {answer ?? ""}
          </p>
        </div>
      ) : (
        <DecisionBar
          {...(clock !== null
            ? {
                clock: <span className="countdown-nowrap">{clock === "expiring" ? "expiring" : `${clock} left`}</span>
              }
            : gone || facts.expiresAt !== null
              ? {}
              : { clock: <span className="countdown-nowrap">No expiry</span> })}
          {...(state._tag === "ready" || state._tag === "sending"
            ? {
                note: "If it expires before your decision reaches the hub, you'll see the hub's refusal, not a success."
              }
            : {})}
          onApprove={decide("approve")}
          onReject={decide("reject")}
          state={state}
          {...(decided !== undefined
            ? { outcome: decided.badge, status: decidedLine(decided, now) }
            : answer === undefined
              ? {}
              : { status: answer })}
          target={`${facts.kind} on ${facts.host}`}
        />
      )}
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
  onRevalidate,
  pendingLoading,
  sending,
  snapshot
}: {
  readonly decisionStatus: DecisionStatus | null
  readonly historyLoading: boolean
  readonly onDecision: ((decision: ApprovalDecision) => void) | undefined
  readonly onLoadHistory: (() => void) | undefined
  readonly onLoadPending: (() => void) | undefined
  /** Re-reads the hub; called once per request when its deadline passes, so the hub decides expiry. */
  readonly onRevalidate: (() => void) | undefined
  readonly pendingLoading: boolean
  readonly sending: ApprovalDecision | null
  readonly snapshot: DashboardSnapshot
}): ReactElement => {
  const items = pendingItems(snapshot)
  const facts = items.map((item) => factsOf(item, snapshot.host))

  // The selected request, remembered with its item. The soonest is pinned on first sight, so the
  // decision target changes only when the reader selects (or focuses) another row, never because the
  // queue moved under a focused button.
  const [picked, setPicked] = useState<{ readonly key: string; readonly item: PendingItem } | null>(null)
  const pick = (item: PendingItem): void => setPicked({ item, key: itemKey(factsOf(item, snapshot.host)) })
  const first = items[0]
  useEffect(() => {
    if (picked === null && first !== undefined) setPicked({ item: first, key: itemKey(factsOf(first, snapshot.host)) })
  }, [first, picked, snapshot.host])
  const shown = picked ?? (first === undefined ? null : { item: first, key: itemKey(factsOf(first, snapshot.host)) })
  const shownIndex = shown === null ? -1 : facts.findIndex((candidate) => itemKey(candidate) === shown.key)
  const selected = shown === null ? undefined : shownIndex >= 0 ? items[shownIndex] : shown.item
  const selectedKey = shown?.key ?? null
  // Absent from the list is "gone" only when the hub's own record or a complete read proves it.
  const departure = selected === undefined || shownIndex >= 0 ? null : departureOf(snapshot, selected)

  // A pinned request that left the loaded pages without proof it is gone keeps its clock and its
  // deadline read, like a listed one.
  const tracked =
    selected !== undefined && shownIndex < 0 && departure === null
      ? [...facts, factsOf(selected, snapshot.host)]
      : facts

  // Expiries are hub times, so the clock is the hub's (see hub-clock.ts).
  const now = useHubNow(
    snapshot.observedAt,
    tracked.map(({ expiresAt }) => expiresAt)
  )

  const stateOf = (item: PendingItem, itemGone: Departure | null): RlyDecisionBarState => {
    if (onDecision === undefined) return { _tag: "off", reason: "Decisions are unavailable here." }
    const id = factsOf(item, snapshot.host).id
    return decisionState({
      approvalsEnabled: snapshot.approvalsEnabled,
      gone: itemGone,
      item,
      sending,
      settled:
        item._tag === "Local" &&
        decisionStatus?.jobId === id &&
        decisionStatus.settles &&
        snapshot.observedAt <= decisionStatus.observedAt
    })
  }

  // One polite line for what the reader is not looking at: a request entering its last minute,
  // one the hub reports expired, and the hub's answer for a request no longer selected. The
  // selected request's own answer and expiry are announced by its DecisionBar.
  const [announcement, setAnnouncement] = useState("")
  const previousNow = useRef(now)
  useEffect(() => {
    const crossed = crossedIntoLastMinute(facts, previousNow.current, now)
    previousNow.current = now
    if (crossed.length > 0) {
      setAnnouncement(
        crossed.map(({ host, id, title }) => `One minute left to decide ${title} (${id}) on ${host}.`).join(" ")
      )
    }
  }, [facts, now])
  const previousFacts = useRef(new Map<string, PendingFacts>())
  useEffect(() => {
    const listed = new Set(facts.map(itemKey))
    const expired = [...previousFacts.current.entries()].flatMap(([key, entry]) => {
      if (listed.has(key) || key === selectedKey || entry.host !== snapshot.host) return []
      const record = snapshot.records.find((candidate) => candidate.id === entry.id)
      return record?.status === "expired" ? [entry] : []
    })
    previousFacts.current = new Map(facts.map((entry) => [itemKey(entry), entry]))
    if (expired.length > 0) {
      setAnnouncement(
        expired.map(({ host, id, title }) => `${title} (${id}) on ${host} expired. Nothing was applied.`).join(" ")
      )
    }
  }, [snapshot])
  const selectedId = selected === undefined ? null : factsOf(selected, snapshot.host).id
  useEffect(() => {
    // The selected DecisionBar announces only its own local request's answer; every other answer,
    // including one for a local job that shares its id with a selected remote request, goes here.
    const ownBar = selected?._tag === "Local" && selected.record.id === decisionStatus?.jobId
    if (decisionStatus !== null && !ownBar) setAnnouncement(decisionStatus.text)
  }, [decisionStatus])

  // When a request's deadline passes on the clock, ask the hub once; its record, not the clock,
  // turns the request into "expired". Also runs when a hidden page becomes visible again.
  // A read can fail; while the request is still listed past its deadline, ask again every 15s.
  const revalidatedAt = useRef(new Map<string, number>())
  useEffect(() => {
    if (onRevalidate === undefined) return
    const due = tracked.filter((entry) => {
      const askedAt = revalidatedAt.current.get(itemKey(entry))
      return (
        entry.expiresAt !== null &&
        entry.expiresAt <= now &&
        (askedAt === undefined || now - askedAt >= REVALIDATE_RETRY_MS)
      )
    })
    if (due.length === 0) return
    for (const entry of due) revalidatedAt.current.set(itemKey(entry), now)
    onRevalidate()
  }, [tracked, now, onRevalidate])

  // Your own decision keeps the hub's answer, also after the request leaves the queue, unless the
  // answer was uncertain and a later read proves what happened; any other departure says why.
  const answerFrom =
    selected === undefined || selectedId === null
      ? undefined
      : selected._tag === "Local" && decisionStatus?.jobId === selectedId
        ? // A later read that proves the outcome beats an uncertain answer, and a confirmed expiry
          // beats an earlier refusal (a decision that reached the hub after its deadline).
          departure !== null && (!decisionStatus.settles || departure.text === EXPIRED_TEXT)
          ? departure
          : decisionStatus
        : (departure ?? undefined)
  const answer = answerFrom?.text
  const answerDecided = answerFrom !== undefined && answerFrom === departure ? departure.decided : undefined

  // Deciding pins the decided request, so the bar and its status stay on it when it leaves the queue.
  const decideItem = (item: PendingItem, decision: ApprovalDecision["decision"]): void => {
    if (onDecision === undefined || item._tag !== "Local") return
    pick(item)
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
    const state = stateOf(target, rowIndex < 0 ? departure : null)
    if (state._tag === "ready") decideItem(target, decision)
    else if (rowIndex >= 0) pick(target)
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
      <h1 className="countdown-title">Approvals</h1>
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
          // The count is what's listed. Unchecked hosts and pages not loaded yet are said in words above,
          // so an unexplained "+" isn't needed.
          {...(items.length === 0 && unchecked.length > 0 ? {} : { count: items.length })}
          title="Waiting for you"
        >
          {items.length === 0 ? (
            <p className="countdown-empty">
              {unchecked.length > 0
                ? "Nothing is waiting on the hosts that answered."
                : snapshot.pendingApprovals.nextCursors.length > 0
                  ? "Nothing on the first page. Load more to see the rest."
                  : "Nothing is waiting for your decision."}
            </p>
          ) : (
            <ul className="countdown-rows" onKeyDown={moveRowFocus} role="list">
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
                      data-agenda-item=""
                      data-approval-host={row.host}
                      data-approval-job={row.id}
                      onClick={() => pick(item)}
                      onFocus={() => pick(item)}
                      type="button"
                    >
                      <span className="countdown-row-meta">
                        <code>{row.kind}</code>, {row.host}
                      </span>
                      <span className="countdown-row-title">{row.title}</span>
                      {/* A request without an expiry says so, instead of leaving the clock's place empty. */}
                      <span
                        className="countdown-row-clock"
                        data-urgency={row.expiresAt === null ? "calm" : urgencyOf(row.expiresAt - now)}
                      >
                        {clock ?? "No expiry"}
                      </span>
                      {used === null ? null : (
                        <span className="countdown-visually-hidden">
                          , {String(Math.round(used.value))}% of its approval window used
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
          {facts.some(({ createdAt, expiresAt }) => windowUsed(createdAt, expiresAt, now) !== null) ? (
            // Once per list: the near tick every row's track draws.
            <TrackKey
              className="countdown-track-key"
              items={[{ label: "5 minutes left", mark: "near" }]}
              label="What the track marks mean"
            />
          ) : null}
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
              decided={answerDecided}
              gone={departure !== null}
              item={selected}
              now={now}
              onDecision={decideItem}
              snapshot={snapshot}
              state={stateOf(selected, departure)}
            />
          </Region>
        )}
        <Region className="countdown-decided" count={decided.length} title="Recently decided">
          {decided.length === 0 ? (
            <p className="countdown-empty">No decisions yet.</p>
          ) : (
            <ul className="countdown-rows countdown-decided-rows" role="list">
              {decided.map(({ at, by, outcome, record }) => (
                <li className="countdown-decided-row" key={record.id}>
                  <span className="countdown-outcome" data-outcome={outcome}>
                    {outcome}
                  </span>
                  <span className="countdown-row-title">{jobTitle(record)}</span>
                  <small className="countdown-row-caption">
                    <code>{record.payload.kind}</code>
                    {by === null ? "" : `, by ${by}`}, <span className="countdown-nowrap">{agoText(at, now)}</span>
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
