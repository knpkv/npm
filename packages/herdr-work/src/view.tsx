import { Button, StateLabel, Text, type RlyStateTone } from "@knpkv/rly/primitives"
import {
  DecisionBar,
  Hero,
  Region,
  StageRail,
  TimelineRow,
  type RlyDecisionBarState,
  type RlyStage
} from "@knpkv/rly/patterns"
import { useEffect, useRef, useState, type ReactElement } from "react"
import type {
  DeliveryStage,
  WorkActivity,
  WorkApprovalTarget,
  WorkGoal,
  WorkGoalFamilyGroup,
  WorkRequest,
  WorkReview,
  WorkSnapshot,
  WorkSnapshots,
  WorkSnapshotWindow,
  WorkBlocker
} from "./model.js"
import { decodeWorkBoardNavigationGoal, encodeWorkBoardNavigationGoal } from "./navigation.js"
import { workRequestClockText, workRequestDecidability, type WorkRequestDecisions } from "./request-decision.js"
import {
  type WorkTriageSummary,
  workTriage,
  workTriageGroups,
  workTriageGroupTitle,
  workTriageSentence,
  type WorkTriageTense
} from "./work-triage.js"

export type { WorkRequestAnswer, WorkRequestDecision, WorkRequestDecisions } from "./request-decision.js"
/** The request clock's wording ("52s", "4m 12s", "11m", "expiring"), shared with hosts that show the same clocks. */
export { workRequestClockText } from "./request-decision.js"

const windows: ReadonlyArray<WorkSnapshotWindow> = ["now", "day", "week", "month"]
const stageOrder: ReadonlyArray<DeliveryStage> = ["local", "review", "pull_request", "merged", "deployed"]
const initialVisibleGoalCount = 10
const selectedGoalFragment = "work-selected-goal"
const goalStates: ReadonlyArray<WorkGoal["state"]> = [
  "planned",
  "working",
  "blocked",
  "review",
  "deployed",
  "completed",
  "abandoned"
]
const statusFilters: ReadonlyArray<"all" | WorkGoal["state"]> = ["all", ...goalStates]

const windowLabel = {
  now: "Now",
  day: "24 hours ago",
  week: "7 days ago",
  month: "30 days ago"
} satisfies Readonly<Record<WorkSnapshotWindow, string>>

const statePresentation = {
  planned: { label: "Planned", tone: "neutral" },
  working: { label: "Working", tone: "progress" },
  blocked: { label: "Blocked", tone: "critical" },
  review: { label: "In review", tone: "caution" },
  deployed: { label: "Deployed", tone: "positive" },
  completed: { label: "Completed", tone: "positive" },
  abandoned: { label: "Abandoned", tone: "neutral" }
} satisfies Readonly<Record<WorkGoal["state"], { readonly label: string; readonly tone: RlyStateTone }>>

const deliveryLabel = {
  local: "Local",
  review: "Review",
  pull_request: "Pull request",
  merged: "Merged",
  deployed: "Deployed"
} satisfies Readonly<Record<DeliveryStage, string>>

const reviewPresentation = {
  not_requested: { label: "Not requested", tone: "neutral" },
  requested: { label: "Requested", tone: "caution" },
  changes_requested: { label: "Changes requested", tone: "critical" },
  approved: { label: "Approved", tone: "positive" }
} satisfies Readonly<Record<NonNullable<WorkReview>["state"], { readonly label: string; readonly tone: RlyStateTone }>>

const requestPresentation = {
  open: { label: "Open", tone: "caution" },
  approved: { label: "Approved", tone: "positive" },
  rejected: { label: "Rejected", tone: "critical" },
  fulfilled: { label: "Fulfilled", tone: "positive" }
} satisfies Readonly<Record<WorkRequest["state"], { readonly label: string; readonly tone: RlyStateTone }>>

const formatTimestamp = (timestamp: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp)

const formatSpend = (goal: WorkGoal): string =>
  goal.spend === null
    ? "Not recorded"
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: goal.spend.currency
      }).format(goal.spend.minorUnits / 100)

const blockersFor = (goal: WorkGoal): ReadonlyArray<WorkBlocker> => {
  if (goal.blockers !== undefined) return goal.blockers
  return goal.blocker === null ? [] : [goal.blocker]
}

const activityFor = (goal: WorkGoal): ReadonlyArray<WorkActivity> => goal.activity ?? []

const requestsFor = (goal: WorkGoal): ReadonlyArray<WorkRequest> => goal.requests ?? []

const hierarchyLabel = (goal: WorkGoal): string => {
  const hierarchy = goal.agentHierarchy
  if (hierarchy === undefined || hierarchy === null) return "No agent hierarchy recorded"
  return `${hierarchy.agent.host} / ${hierarchy.agent.name}`
}

/** Renders the persisted approval deep link after its origin is bound at ingress. */
const exactLink = (target: WorkApprovalTarget, label: string): ReactElement => (
  <a className="work-exact-link" href={target.url}>
    {label}
  </a>
)

/** Renders the persisted review destination without rewriting its credential-free URL. */
const reviewLink = (url: string): ReactElement => (
  <a className="work-exact-link" href={url}>
    Open review
  </a>
)

const reviewLabel = (review: WorkReview | null | undefined): ReactElement => {
  if (review === undefined || review === null) {
    return <Text tone="secondary">No review recorded.</Text>
  }
  return (
    <StateLabel
      label={reviewPresentation[review.state].label}
      size="compact"
      tone={reviewPresentation[review.state].tone}
    />
  )
}

/** Delivery as words: past stages are done, the current one is "now" in the goal's state ink. */
const stagesFor = (goal: WorkGoal): ReadonlyArray<RlyStage> => {
  const current = stageOrder.indexOf(goal.delivery)
  return stageOrder.map((stage, index) => ({
    id: `${goal.id}-${stage}`,
    name: deliveryLabel[stage],
    state: index < current ? "done" : index === current ? "now" : "not yet",
    tone: index === current ? statePresentation[goal.state].tone : "neutral"
  }))
}

/** A row's caption: the one fact that explains its group, and whether that fact blocks. */
/** The one line under a goal row; `blocking` gives it the blocked ink. */
interface WorkRowCaption {
  readonly text: string
  readonly blocking: boolean
}

const rowCaption = (goal: WorkGoal, decisions: WorkRequestDecisions | undefined): WorkRowCaption => {
  const open = requestsFor(goal).filter(({ state }) => state === "open")
  if (open.length > 0) {
    // The soonest clock among requests this page can decide, beside the request it belongs to.
    const soonest = open
      .map((request) => ({ decidability: workRequestDecidability(request, decisions), request }))
      .flatMap(({ decidability, request }) =>
        decidability._tag === "Here" && decidability.expiresAt !== null
          ? [{ expiresAt: decidability.expiresAt, request }]
          : []
      )
      .toSorted((left, right) => left.expiresAt - right.expiresAt)[0]
    const clock =
      soonest === undefined || decisions === undefined
        ? ""
        : `, ${workRequestClockText(soonest.expiresAt, decisions.now)}${soonest.expiresAt > decisions.now ? " left" : ""}`
    return {
      blocking: false,
      text:
        open.length === 1
          ? `Needs approval: ${open[0]?.summary ?? ""}${clock}`
          : `${open.length} requests need approval${clock}`
    }
  }
  const blockers = blockersFor(goal)
  if (blockers.length > 0) return { blocking: true, text: blockers[0]?.summary ?? "Blocked" }
  const latest = activityFor(goal).toSorted((a, b) => b.occurredAt - a.occurredAt)[0]
  if (latest !== undefined) return { blocking: false, text: `${latest.summary}, ${formatTimestamp(latest.occurredAt)}` }
  return { blocking: false, text: `${goal.owner.name}, ${deliveryLabel[goal.delivery].toLowerCase()}` }
}

/** The caption under the hero: the request waiting longest, or the latest change. */
const summaryCaption = (summary: WorkTriageSummary, tense: WorkTriageTense): string | undefined => {
  switch (summary._tag) {
    case "Attention":
      return summary.oldestRequest === null
        ? undefined
        : `${tense === "present" ? "Waiting longest" : "Waiting longest then"}: ${summary.oldestRequest.request.summary} on ${summary.oldestRequest.goal.title}, requested ${formatTimestamp(summary.oldestRequest.request.requestedAt)}.`
    case "Clear":
      return summary.latest === null
        ? undefined
        : `${summary.moving} moving. Last change: ${summary.latest.title}, ${formatTimestamp(summary.latest.updatedAt)}.`
    case "Empty":
      return "A goal appears once an agent's work is admitted."
  }
}

/**
 * The DecisionBar for a request this page can decide, or `null` to keep its hub link. The bar stays
 * mounted once this page sent a decision for it, so the hub's answer is announced there even after
 * the request leaves the queue; the hub decides expiry, never this page's clock.
 */
const decisionBarFor = (request: WorkRequest, decisions: WorkRequestDecisions | undefined): ReactElement | null => {
  const decidability = workRequestDecidability(request, decisions)
  if (decidability._tag === "Elsewhere" || decisions === undefined) return null
  const { expiresAt, jobId } = decidability
  const pending = decisions.expiresAt(jobId) !== undefined && request.state === "open"
  // Once the request has left the hub's queue, the snapshot's outcome is the proven one.
  const proven = request.state !== "open"
  const outcome = proven ? `${requestPresentation[request.state].label}.` : "Left the hub's queue."
  const answer = decisions.answer?.jobId === jobId ? decisions.answer : null
  const state: RlyDecisionBarState =
    decisions.sending?.jobId === jobId
      ? { _tag: "sending", action: decisions.sending.decision }
      : decisions.sending !== null
        ? { _tag: "off", reason: "Another decision is waiting for the hub." }
        : // The hub took a decision; the host's pending list has not caught up yet, so nothing else may be sent.
          answer?.outcome === "accepted" && pending
          ? { _tag: "off", reason: "Waiting for the hub's queue to update." }
          : pending
            ? { _tag: "ready" }
            : { _tag: "off", reason: outcome }
  // An uncertain answer stands only until the snapshot proves what happened; the proof is then the
  // off reason, so the status says nothing more.
  const status =
    answer === null || (answer.outcome === "uncertain" && proven && !pending)
      ? undefined
      : answer.outcome !== "uncertain" || pending
        ? answer.text
        : `${outcome} ${answer.text}`
  const decide = (decision: "approve" | "reject") => () => {
    if (state._tag === "ready") decisions.onDecision({ decision, jobId })
  }
  return (
    <DecisionBar
      {...(expiresAt === null || !pending
        ? {}
        : {
            clock: `${workRequestClockText(expiresAt, decisions.now)}${expiresAt > decisions.now ? " left" : ""}`
          })}
      onApprove={decide("approve")}
      onReject={decide("reject")}
      state={state}
      {...(status === undefined ? {} : { status })}
      target={request.summary}
    />
  )
}

/** Everything about one goal, in reading order: what it is, where it is, what blocks it, what happened. */
const GoalDetail = ({
  decisions,
  externalLinks,
  goal,
  snapshot
}: {
  readonly decisions: WorkRequestDecisions | undefined
  readonly externalLinks: "disabled" | "enabled"
  readonly goal: WorkGoal
  readonly snapshot: WorkSnapshot
}): ReactElement => {
  const family = familyForGoal(snapshot, goal.id)
  const activity = activityFor(goal).toSorted((a, b) => b.occurredAt - a.occurredAt)
  // A goal-level approval target (older checkpoints carry one without requests); skipped when a
  // request already links the same approval.
  const goalApproval =
    goal.approvalTarget === undefined ||
    goal.approvalTarget === null ||
    requestsFor(goal).some(({ approvalTarget }) => approvalTarget?.url === goal.approvalTarget?.url)
      ? null
      : goal.approvalTarget
  return (
    <div className="work-detail">
      <Text tone="secondary">{goal.detail}</Text>
      <StageRail heading={`Delivery of ${goal.title}`} size="words" stages={stagesFor(goal)} />
      <dl className="work-facts">
        <div>
          <dt>State</dt>
          <dd>{statePresentation[goal.state].label}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{goal.owner.name}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>
            {hierarchyLabel(goal)}
            {goal.agentHierarchy?.agent.relationship === undefined || goal.agentHierarchy === null
              ? null
              : `, ${goal.agentHierarchy.agent.relationship.relation} from ${goal.agentHierarchy.agent.relationship.parentAgentId}`}
          </dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd>
            {goal.repository.repository}, <code>{goal.repository.branch}</code>
          </dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>
            {reviewLabel(goal.review)}
            {goal.review?.url === null || goal.review?.url === undefined ? null : externalLinks ===
              "disabled" ? null : (
              <> {reviewLink(goal.review.url)}</>
            )}
            {goal.review?.summary === null || goal.review?.summary === undefined ? null : (
              <Text tone="secondary" variant="meta">
                {goal.review.summary}
              </Text>
            )}
          </dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd>{formatSpend(goal)}</dd>
        </div>
      </dl>
      {blockersFor(goal).map((blocker) => (
        <p className="work-note" data-tone="blocked" key={`${blocker.since}-${blocker.summary}`}>
          <b>Blocked</b> since {formatTimestamp(blocker.since)}: {blocker.summary}
        </p>
      ))}
      <section aria-labelledby="work-requests-title" className="work-detail-section">
        <h3 className="work-group-title" id="work-requests-title">
          Requests
        </h3>
        {requestsFor(goal).length === 0 ? (
          <Text tone="secondary">
            {goal.requests === undefined ? "No requests recorded." : "No outstanding requests."}
          </Text>
        ) : (
          <ul className="work-detail-list">
            {requestsFor(goal).map((request) => (
              <li key={request.id}>
                <span className="work-request-heading">
                  <Text>{request.summary}</Text>
                  <span className="work-row-state" data-tone={requestPresentation[request.state].tone}>
                    {requestPresentation[request.state].label}
                  </span>
                </span>
                {decisionBarFor(request, externalLinks === "enabled" ? decisions : undefined) ??
                  (request.state !== "open" ? null : request.approvalTarget === null ? (
                    <Text tone="secondary" variant="meta">
                      No approval link recorded.
                    </Text>
                  ) : externalLinks === "disabled" ? (
                    <Text tone="secondary" variant="meta">
                      Approve this on the hub ({request.approvalTarget.host}).
                    </Text>
                  ) : (
                    exactLink(request.approvalTarget, `Approve on ${request.approvalTarget.host}`)
                  ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="work-activity-title" className="work-detail-section">
        <h3 className="work-group-title" id="work-activity-title">
          Activity
        </h3>
        {activity.length === 0 ? (
          <Text tone="secondary">{goal.activity === undefined ? "No activity recorded." : "Activity is clear."}</Text>
        ) : (
          <ol aria-label={`Activity on ${goal.title}`} className="work-activity">
            {activity.map((entry, index) => (
              <TimelineRow
                continued={index < activity.length - 1}
                event={{
                  actorKind: "system",
                  dateTime: new Date(entry.occurredAt).toISOString(),
                  detail: activityKindLabel[entry.kind],
                  id: entry.id,
                  time: formatTimestamp(entry.occurredAt),
                  title: entry.summary
                }}
                key={entry.id}
              />
            ))}
          </ol>
        )}
      </section>
      {family === null ? null : (
        <section aria-labelledby="work-family-title" className="work-detail-section">
          <h3 className="work-group-title" id="work-family-title">
            Superseded history
          </h3>
          <details className="work-family-history">
            <summary>Show {family.superseded.length} superseded</summary>
            <ul className="work-detail-list">
              {family.superseded.map((entry) => (
                <li key={entry.id}>
                  <span className="work-request-heading">
                    <Text>{entry.title}</Text>
                    <span className="work-row-state" data-tone={statePresentation[entry.state].tone}>
                      {statePresentation[entry.state].label}
                    </span>
                  </span>
                  <Text tone="secondary" variant="meta">
                    {entry.summary}, {formatTimestamp(entry.updatedAt)}
                  </Text>
                  {blockersFor(entry).map((blocker) => (
                    <Text key={`${blocker.since}-${blocker.summary}`} tone="secondary" variant="meta">
                      Blocked since {formatTimestamp(blocker.since)}: {blocker.summary}
                    </Text>
                  ))}
                  {entry.review === undefined || entry.review === null ? null : (
                    <Text tone="secondary" variant="meta">
                      Review {reviewPresentation[entry.review.state].label.toLowerCase()}
                      {entry.review.summary === null ? "" : `: ${entry.review.summary}`}
                    </Text>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      <div className="work-links">
        {goal.connectTarget === null ? (
          <Text tone="secondary">No exact Connect target recorded.</Text>
        ) : externalLinks === "disabled" ? (
          <Text tone="secondary" variant="meta">
            Connect target recorded.
          </Text>
        ) : (
          <a className="work-connect-link" href={goal.connectTarget.url}>
            Open the agent in Connect
          </a>
        )}
        {goalApproval === null ? null : externalLinks === "disabled" ? (
          <Text tone="secondary" variant="meta">
            Approval target recorded on {goalApproval.host}.
          </Text>
        ) : (
          exactLink(goalApproval, `Open ${goalApproval.host} approval`)
        )}
      </div>
    </div>
  )
}

const activityKindLabel = {
  note: "Note",
  status: "Status",
  blocker: "Blocker",
  request: "Request",
  review: "Review",
  shipment: "Shipment"
} satisfies Readonly<Record<WorkActivity["kind"], string>>

const snapshotFor = (snapshots: WorkSnapshots, window: WorkSnapshotWindow): WorkSnapshot => snapshots[window]

const familyForGoal = (snapshot: WorkSnapshot, goalId: string): WorkGoalFamilyGroup | null =>
  (snapshot.families ?? []).find((group) => group.canonicalGoalId === goalId) ?? null

const familyLabelForGoal = (snapshot: WorkSnapshot, goal: WorkGoal): string | null => {
  const group = familyForGoal(snapshot, goal.id)
  if (group === null) return null
  const count = group.superseded.length
  return `${count} superseded`
}

const withFragment = (href: string, fragment: string): string => {
  const fragmentIndex = href.indexOf("#")
  return `${fragmentIndex === -1 ? href : href.slice(0, fragmentIndex)}#${fragment}`
}

export const WorkBoard = ({
  decisions,
  externalLinks = "enabled",
  initialGoalId,
  initialWindow = "now",
  navigation,
  snapshots
}: {
  readonly snapshots: WorkSnapshots
  /**
   * Lets the reader decide approval requests in place, with their clock. Omit it (the LAN view, a
   * host that is not the hub) and every request links to the hub instead.
   */
  readonly decisions?: WorkRequestDecisions
  readonly externalLinks?: "disabled" | "enabled"
  readonly initialGoalId?: string | null
  readonly initialWindow?: WorkSnapshotWindow
  readonly navigation?: (selection: { readonly goalId: string | null; readonly window: WorkSnapshotWindow }) => string
}): ReactElement => {
  const [window, setWindow] = useState<WorkSnapshotWindow>(initialWindow)
  const snapshot = snapshotFor(snapshots, window)
  const directInitialGoal = snapshot.goals.find(({ id }) => id === initialGoalId)
  const boardNavigation = directInitialGoal === undefined ? decodeWorkBoardNavigationGoal(initialGoalId ?? null) : null
  const requestedInitialSelectedId = boardNavigation === null ? (initialGoalId ?? null) : boardNavigation.goalId
  const initialStatusFilter = boardNavigation?.statusFilter ?? "all"
  const requestedInitialSelectedGoal = snapshot.goals.find(({ id }) => id === requestedInitialSelectedId)
  const initialSelectedGoal =
    requestedInitialSelectedGoal !== undefined &&
    (initialStatusFilter === "all" || requestedInitialSelectedGoal.state === initialStatusFilter)
      ? requestedInitialSelectedGoal
      : undefined
  const initialSelectedId = initialSelectedGoal?.id ?? null
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const [detailsOpen, setDetailsOpen] = useState(
    initialSelectedGoal !== undefined &&
      (initialStatusFilter === "all" || initialSelectedGoal.state === initialStatusFilter) &&
      (boardNavigation?.detailsOpen ?? (initialGoalId !== undefined && initialGoalId !== null))
  )
  const [statusFilter, setStatusFilter] = useState<"all" | WorkGoal["state"]>(initialStatusFilter)
  const [visibleGoalCount, setVisibleGoalCount] = useState(boardNavigation?.visibleGoalCount ?? initialVisibleGoalCount)
  const detailsRef = useRef<HTMLElement | null>(null)
  const selectedLinkRowRef = useRef<HTMLAnchorElement | null>(null)
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)
  const triage = workTriage(snapshot)
  // A historical window is the state as of its time; say so, never in the present tense.
  const tense: WorkTriageTense = window === "now" ? "present" : "past"
  const sentence = workTriageSentence(triage.summary, tense)
  const heroFact =
    tense === "present"
      ? sentence
      : `As of ${formatTimestamp(snapshot.asOf)}, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`
  const groupById = new Map(triage.rows.map((row) => [row.goal.id, row.group]))
  const ordered = triage.rows.map((row) => row.goal)
  const filteredGoals = statusFilter === "all" ? ordered : ordered.filter(({ state }) => state === statusFilter)
  const selectedFilteredGoalIndex = filteredGoals.findIndex(({ id }) => id === selectedId)
  const selected = filteredGoals.find(({ id }) => id === selectedId) ?? null
  const visibleGoalStart =
    selectedFilteredGoalIndex < visibleGoalCount ? 0 : selectedFilteredGoalIndex - visibleGoalCount + 1
  const visibleGoals = filteredGoals.slice(visibleGoalStart, visibleGoalStart + visibleGoalCount)
  const visibleGroups = workTriageGroups
    .map((group) => ({ group, goals: visibleGoals.filter(({ id }) => groupById.get(id) === group) }))
    .filter(({ goals }) => goals.length > 0)
  // Opening a goal moves focus to its heading, so the detail is announced by name.
  useEffect(() => {
    if (detailsOpen) detailsRef.current?.querySelector<HTMLElement>("h2")?.focus()
  }, [detailsOpen, selectedId])
  useEffect(() => {
    if (
      navigation !== undefined &&
      !detailsOpen &&
      selectedId !== null &&
      document.location.hash === `#${selectedGoalFragment}`
    ) {
      selectedLinkRowRef.current?.focus()
    }
  }, [detailsOpen, navigation, selectedId])
  useEffect(() => {
    if (selectedId === null || selectedFilteredGoalIndex !== -1) return
    setDetailsOpen(false)
    setSelectedId(null)
    setVisibleGoalCount(initialVisibleGoalCount)
  }, [selectedFilteredGoalIndex, selectedId])

  const goalRow = (goal: WorkGoal): ReactElement => {
    const caption = rowCaption(goal, externalLinks === "enabled" ? decisions : undefined)
    const content = (
      <>
        <span className="work-row-title">
          <span className="work-row-meta">
            {goal.repository.repository}, <code>{goal.repository.branch}</code>
          </span>
          {goal.title}
        </span>
        <span className="work-row-state" data-tone={statePresentation[goal.state].tone}>
          {statePresentation[goal.state].label}
        </span>
        <span className="work-row-caption" data-blocking={caption.blocking}>
          {caption.text}
          {familyLabelForGoal(snapshot, goal) === null ? null : `, ${familyLabelForGoal(snapshot, goal)}`}
        </span>
      </>
    )
    return navigation === undefined ? (
      <button
        aria-controls={detailsOpen && selected?.id === goal.id ? "work-goal-details" : undefined}
        aria-expanded={detailsOpen && selected?.id === goal.id}
        aria-pressed={selected?.id === goal.id}
        className="work-board-row"
        id={selected?.id === goal.id ? selectedGoalFragment : undefined}
        onClick={() => {
          setDetailsOpen(true)
          setSelectedId(goal.id)
        }}
        ref={selected?.id === goal.id ? selectedRowRef : undefined}
        type="button"
      >
        {content}
      </button>
    ) : (
      <a
        aria-current={selected?.id === goal.id ? "true" : undefined}
        className="work-board-row"
        href={navigation({
          goalId:
            statusFilter === "all" && visibleGoalCount === initialVisibleGoalCount
              ? goal.id
              : encodeWorkBoardNavigationGoal({
                  detailsOpen: true,
                  goalId: goal.id,
                  statusFilter,
                  visibleGoalCount
                }),
          window
        })}
        id={selected?.id === goal.id ? selectedGoalFragment : undefined}
        ref={selected?.id === goal.id ? selectedLinkRowRef : undefined}
      >
        {content}
      </a>
    )
  }

  const timeTravel = (
    <div aria-label="Choose work snapshot" className="work-time-controls" role="group">
      {windows.map((option) => {
        if (navigation === undefined) {
          return (
            <button
              aria-pressed={window === option}
              className="work-time-option"
              key={option}
              onClick={() => {
                const selectedAtOption = snapshotFor(snapshots, option).goals.find(({ id }) => id === selectedId)
                if (
                  selectedAtOption === undefined ||
                  (statusFilter !== "all" && selectedAtOption.state !== statusFilter)
                ) {
                  setDetailsOpen(false)
                }
                setVisibleGoalCount(initialVisibleGoalCount)
                setWindow(option)
              }}
              type="button"
            >
              {windowLabel[option]}
            </button>
          )
        }
        const selectedAtOption = snapshotFor(snapshots, option).goals.find(({ id }) => id === selectedId)
        const hasBoardState =
          selectedId !== null || statusFilter !== "all" || visibleGoalCount !== initialVisibleGoalCount
        return (
          <a
            aria-current={window === option ? "page" : undefined}
            className="work-time-option"
            href={navigation({
              goalId: hasBoardState
                ? encodeWorkBoardNavigationGoal({
                    detailsOpen:
                      detailsOpen &&
                      selectedAtOption !== undefined &&
                      (statusFilter === "all" || selectedAtOption.state === statusFilter),
                    goalId: selectedId,
                    statusFilter,
                    visibleGoalCount: initialVisibleGoalCount
                  })
                : null,
              window: option
            })}
            key={option}
          >
            {windowLabel[option]}
          </a>
        )
      })}
    </div>
  )

  const statusFilterControls = (
    <div aria-label="Filter goals by status" className="work-status-filters" role="group">
      {statusFilters.map((state) => {
        const label = state === "all" ? "All" : statePresentation[state].label
        return navigation === undefined ? (
          <button
            aria-pressed={statusFilter === state}
            className="work-status-filter"
            key={state}
            onClick={() => {
              setDetailsOpen(false)
              setSelectedId(null)
              setStatusFilter(state)
              setVisibleGoalCount(initialVisibleGoalCount)
            }}
            type="button"
          >
            {label}
          </button>
        ) : (
          <a
            aria-current={statusFilter === state ? "page" : undefined}
            className="work-status-filter"
            href={navigation({
              goalId: encodeWorkBoardNavigationGoal({
                detailsOpen: false,
                goalId: null,
                statusFilter: state,
                visibleGoalCount: initialVisibleGoalCount
              }),
              window
            })}
            key={state}
          >
            {label}
          </a>
        )
      })}
    </div>
  )

  return (
    <section className="work-page" aria-labelledby="work-board-title">
      <header className="work-page-intro">
        <Text as="h1" id="work-board-title" variant="card-title">
          Work
        </Text>
        <Text tone="secondary" variant="meta">
          {window === "now" ? "Live" : windowLabel[window]}, as of {formatTimestamp(snapshot.asOf)}
        </Text>
      </header>
      <Hero caption={summaryCaption(triage.summary, tense)} fact={heroFact} label="Work summary" />
      {timeTravel}
      {snapshot.goals.length === 0 ? (
        <Region title="Goals">
          <Text tone="secondary">No goals at this checkpoint. A goal appears once an agent's work is admitted.</Text>
        </Region>
      ) : (
        <div className="work-board-layout" data-has-detail={selected !== null && detailsOpen}>
          <Region actions={statusFilterControls} className="work-board-list" count={filteredGoals.length} title="Goals">
            <Text aria-live="polite" tone="secondary" variant="meta">
              Showing {visibleGoals.length} of {filteredGoals.length} goals
            </Text>
            {filteredGoals.length === 0 ? <Text tone="secondary">No goals match this status.</Text> : null}
            {visibleGroups.map(({ goals, group }) => (
              <section aria-labelledby={`work-group-${group}`} className="work-group" key={group}>
                <h3 className="work-group-title" id={`work-group-${group}`}>
                  {workTriageGroupTitle[group]} <span className="work-group-count">({goals.length})</span>
                </h3>
                <ul className="work-rows">
                  {goals.map((goal) => (
                    <li key={goal.id}>{goalRow(goal)}</li>
                  ))}
                </ul>
              </section>
            ))}
            {visibleGoals.length < filteredGoals.length ? (
              navigation === undefined ? (
                <Button
                  onClick={() =>
                    setVisibleGoalCount((count) => Math.min(count + initialVisibleGoalCount, filteredGoals.length))
                  }
                >
                  Load 10 more
                </Button>
              ) : (
                <a
                  className="work-load-more-link"
                  href={navigation({
                    goalId: encodeWorkBoardNavigationGoal({
                      detailsOpen,
                      goalId: selectedId,
                      statusFilter,
                      visibleGoalCount: Math.min(visibleGoalCount + initialVisibleGoalCount, filteredGoals.length)
                    }),
                    window
                  })}
                >
                  Load 10 more
                </a>
              )
            ) : null}
          </Region>
          {selected === null || !detailsOpen ? null : (
            <Region
              actions={
                navigation === undefined ? (
                  <Button
                    onClick={() => {
                      setDetailsOpen(false)
                      const selectedRow = selectedRowRef.current ?? selectedLinkRowRef.current
                      selectedRow?.focus()
                    }}
                    variant="secondary"
                  >
                    Close details
                  </Button>
                ) : (
                  <a
                    className="work-exact-link"
                    href={withFragment(
                      navigation({
                        goalId: encodeWorkBoardNavigationGoal({
                          detailsOpen: false,
                          goalId: selectedId,
                          statusFilter,
                          visibleGoalCount
                        }),
                        window
                      }),
                      selectedGoalFragment
                    )}
                  >
                    Close details
                  </a>
                )
              }
              aria-label="Goal details"
              className="work-inspector"
              headingId="work-goal-details-title"
              id="work-goal-details"
              ref={detailsRef}
              title={selected.title}
            >
              <GoalDetail decisions={decisions} externalLinks={externalLinks} goal={selected} snapshot={snapshot} />
            </Region>
          )}
        </div>
      )}
    </section>
  )
}
