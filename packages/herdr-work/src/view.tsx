import { Button, Divider, StateLabel, Surface, Text, type RlyStateTone } from "@knpkv/rly/primitives"
import { StageRail, type RlyStage } from "@knpkv/rly/patterns"
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
  "completed"
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
  completed: { label: "Completed", tone: "positive" }
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
    {label} →
  </a>
)

/** Renders the persisted review destination without rewriting its credential-free URL. */
const reviewLink = (url: string): ReactElement => (
  <a className="work-exact-link" href={url}>
    Open review →
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

const stagesFor = (goal: WorkGoal): ReadonlyArray<RlyStage> => {
  const current = stageOrder.indexOf(goal.delivery)
  return stageOrder.map((stage, index) => {
    const presentation = {
      id: `${goal.id}-${stage}`,
      name: deliveryLabel[stage],
      state: index < current ? "Complete" : index === current ? deliveryLabel[stage] : "Not started",
      tone: index < current ? "positive" : index === current ? statePresentation[goal.state].tone : "neutral"
    } satisfies RlyStage
    return index === current ? { ...presentation, reason: goal.detail } : presentation
  })
}

const SummaryCell = ({ label, value }: { readonly label: string; readonly value: string }): ReactElement => (
  <Surface className="work-summary-cell" padding="compact" tone="secondary">
    <Text tone="secondary" variant="meta">
      {label}
    </Text>
    <Text as="span" variant="card-title">
      {value}
    </Text>
  </Surface>
)

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
  externalLinks = "enabled",
  initialGoalId,
  initialWindow = "now",
  navigation,
  snapshots
}: {
  readonly snapshots: WorkSnapshots
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
  const filteredGoals =
    statusFilter === "all" ? snapshot.goals : snapshot.goals.filter(({ state }) => state === statusFilter)
  const selectedFilteredGoalIndex = filteredGoals.findIndex(({ id }) => id === selectedId)
  const selected = filteredGoals.find(({ id }) => id === selectedId) ?? null
  const visibleGoalStart =
    selectedFilteredGoalIndex < visibleGoalCount ? 0 : selectedFilteredGoalIndex - visibleGoalCount + 1
  const visibleGoals = filteredGoals.slice(visibleGoalStart, visibleGoalStart + visibleGoalCount)
  const counts = {
    blocked: snapshot.goals.filter(({ state }) => state === "blocked").length,
    deployed: snapshot.goals.filter(({ state }) => state === "deployed").length,
    openRequests: snapshot.goals.reduce(
      (count, goal) => count + requestsFor(goal).filter(({ state }) => state === "open").length,
      0
    ),
    review: snapshot.goals.filter(({ state }) => state === "review").length,
    working: snapshot.goals.filter(({ state }) => state === "working").length
  }
  useEffect(() => {
    if (detailsOpen) detailsRef.current?.focus()
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
  return (
    <section className="work-page" aria-labelledby="work-board-title">
      <header className="work-page-intro">
        <div>
          <Text as="h1" id="work-board-title" variant="page-title">
            Daily fleet Work
          </Text>
          <Text tone="secondary" variant="body-large">
            One durable view of who owns the work, what is blocked, and what ships next.
          </Text>
        </div>
        <div className="work-snapshot-stamp">
          <Text tone="secondary" variant="meta">
            Durable snapshot
          </Text>
          <Text variant="code">{formatTimestamp(snapshot.asOf)}</Text>
        </div>
      </header>
      <Surface className="work-time-travel" padding="compact" tone="secondary">
        <div className="work-time-heading">
          <div>
            <Text as="h2" variant="card-title">
              Time travel
            </Text>
            <Text tone="secondary" variant="meta">
              Checkpoint events only. Missing history stays absent.
            </Text>
          </div>
          <StateLabel
            label={window === "now" ? "Live" : "Historical"}
            tone={window === "now" ? "positive" : "neutral"}
          />
        </div>
        <div aria-label="Choose work snapshot" className="work-time-controls" role="group">
          {windows.map((option) => {
            if (navigation === undefined) {
              return (
                <Button
                  aria-pressed={window === option}
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
                  variant={window === option ? "primary" : "secondary"}
                >
                  {windowLabel[option]}
                </Button>
              )
            }
            const selectedAtOption = snapshotFor(snapshots, option).goals.find(({ id }) => id === selectedId)
            const hasBoardState =
              selectedId !== null || statusFilter !== "all" || visibleGoalCount !== initialVisibleGoalCount
            return (
              <a
                aria-current={window === option ? "page" : undefined}
                className="work-time-link"
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
      </Surface>
      <div className="work-summary-grid" aria-label="Work summary">
        <SummaryCell label="Goals" value={String(snapshot.goals.length)} />
        <SummaryCell label="Working" value={String(counts.working)} />
        <SummaryCell label="Blocked" value={String(counts.blocked)} />
        <SummaryCell label="Open requests" value={String(counts.openRequests)} />
        <SummaryCell label="In review" value={String(counts.review)} />
        <SummaryCell label="Deployed" value={String(counts.deployed)} />
      </div>
      {snapshot.goals.length === 0 ? (
        <Surface padding="spacious" tone="secondary">
          <Text as="h2" variant="card-title">
            No goals at this checkpoint
          </Text>
          <Text tone="secondary">Record a WorkGoalCheckpoint to add durable work state.</Text>
        </Surface>
      ) : (
        <div className="work-board-layout">
          <div className="work-board-list">
            <div className="work-board-toolbar">
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
              <Text aria-live="polite" tone="secondary" variant="meta">
                Showing {visibleGoals.length} of {filteredGoals.length} goals
              </Text>
            </div>
            <Surface className="work-departure-board" padding="none" tone="secondary">
              <div className="work-board-head" aria-hidden="true">
                <span>Status</span>
                <span>Work</span>
                <span>Owner</span>
                <span>Agent / host</span>
                <span>Repository</span>
                <span>Shipment</span>
                <span>Spend</span>
              </div>
              {filteredGoals.length === 0 ? (
                <div className="work-empty-filter">
                  <Text tone="secondary">No goals match this status.</Text>
                </div>
              ) : null}
              {visibleGoals.map((goal) => {
                const row = (
                  <>
                    <StateLabel
                      label={statePresentation[goal.state].label}
                      size="compact"
                      tone={statePresentation[goal.state].tone}
                    />
                    <span className="work-board-copy">
                      <Text as="strong" variant="label">
                        {goal.title}
                      </Text>
                      <Text tone="secondary" variant="meta">
                        {goal.summary}
                      </Text>
                      {familyLabelForGoal(snapshot, goal) === null ? null : (
                        <Text tone="secondary" variant="meta">
                          {familyLabelForGoal(snapshot, goal)}
                        </Text>
                      )}
                    </span>
                    <Text data-label="Owner">{goal.owner.name}</Text>
                    <span className="work-board-copy" data-label="Agent / host">
                      <Text>{hierarchyLabel(goal)}</Text>
                      {goal.agentHierarchy?.agent.relationship === undefined ? null : (
                        <Text tone="secondary" variant="meta">
                          {goal.agentHierarchy.agent.relationship.relation} ·{" "}
                          {goal.agentHierarchy.agent.relationship.parentAgentId}
                        </Text>
                      )}
                    </span>
                    <span className="work-board-copy" data-label="Repository">
                      <Text variant="code">{goal.repository.repository}</Text>
                      <Text tone="secondary" variant="meta">
                        {goal.repository.branch}
                      </Text>
                    </span>
                    <Text data-label="Shipment">{deliveryLabel[goal.delivery]}</Text>
                    <Text data-label="Spend" variant="code">
                      {formatSpend(goal)}
                    </Text>
                  </>
                )
                return navigation === undefined ? (
                  <button
                    aria-controls={detailsOpen && selected?.id === goal.id ? "work-goal-details" : undefined}
                    aria-expanded={detailsOpen && selected?.id === goal.id}
                    aria-pressed={selected?.id === goal.id}
                    className="work-board-row"
                    id={selected?.id === goal.id ? selectedGoalFragment : undefined}
                    key={goal.id}
                    onClick={() => {
                      setDetailsOpen(true)
                      setSelectedId(goal.id)
                    }}
                    ref={selected?.id === goal.id ? selectedRowRef : undefined}
                    type="button"
                  >
                    {row}
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
                    key={goal.id}
                    id={selected?.id === goal.id ? selectedGoalFragment : undefined}
                    ref={selected?.id === goal.id ? selectedLinkRowRef : undefined}
                  >
                    {row}
                  </a>
                )
              })}
            </Surface>
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
          </div>
          {selected === null || !detailsOpen ? null : (
            <Surface
              aria-label="Goal details"
              as="aside"
              className="work-inspector"
              id="work-goal-details"
              padding="spacious"
              ref={detailsRef}
              tabIndex={-1}
            >
              <div className="work-inspector-heading">
                <StateLabel
                  label={statePresentation[selected.state].label}
                  tone={statePresentation[selected.state].tone}
                />
                {navigation === undefined ? (
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
                )}
              </div>
              <Text as="h2" variant="section-title">
                {selected.title}
              </Text>
              <Text tone="secondary">{selected.detail}</Text>
              <div className="work-inspector-section">
                <Text as="h3" variant="label">
                  Agent hierarchy
                </Text>
                {selected.agentHierarchy === undefined || selected.agentHierarchy === null ? (
                  <Text tone="secondary">No authoritative agent assignment recorded.</Text>
                ) : (
                  <>
                    <Text>
                      {selected.agentHierarchy.agent.host} / {selected.agentHierarchy.agent.name}
                    </Text>
                    <Text tone="secondary" variant="code">
                      {selected.agentHierarchy.agent.agentId}
                    </Text>
                    {selected.agentHierarchy.agent.relationship === undefined ? (
                      <Text tone="secondary" variant="meta">
                        Fleet root agent
                      </Text>
                    ) : (
                      <Text tone="secondary" variant="meta">
                        {selected.agentHierarchy.agent.relationship.relation} from{" "}
                        {selected.agentHierarchy.agent.relationship.parentAgentId}
                      </Text>
                    )}
                  </>
                )}
              </div>
              <Divider />
              <dl className="work-facts">
                <div>
                  <dt>Owner</dt>
                  <dd>{selected.owner.name}</dd>
                </div>
                <div>
                  <dt>Repository</dt>
                  <dd>{selected.repository.repository}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{selected.repository.branch}</dd>
                </div>
                <div>
                  <dt>Shipment stage</dt>
                  <dd>{deliveryLabel[selected.delivery]}</dd>
                </div>
                <div>
                  <dt>Spend</dt>
                  <dd>{formatSpend(selected)}</dd>
                </div>
              </dl>
              <div className="work-inspector-section">
                <Text as="h3" variant="label">
                  Blockers
                </Text>
                {blockersFor(selected).length === 0 ? (
                  <Text tone="secondary">No blockers recorded.</Text>
                ) : (
                  blockersFor(selected).map((blocker) => (
                    <Surface key={`${blocker.since}-${blocker.summary}`} padding="compact" tone="secondary">
                      <Text variant="meta" tone="secondary">
                        Since {formatTimestamp(blocker.since)}
                      </Text>
                      <Text>{blocker.summary}</Text>
                    </Surface>
                  ))
                )}
              </div>
              <div className="work-inspector-section">
                <Text as="h3" variant="label">
                  Activity
                </Text>
                {selected.activity === undefined ? (
                  <Text tone="secondary">No activity recorded.</Text>
                ) : activityFor(selected).length === 0 ? (
                  <Text tone="secondary">Activity is clear.</Text>
                ) : (
                  <ul className="work-detail-list">
                    {activityFor(selected).map((entry) => (
                      <li key={entry.id}>
                        <Text variant="meta" tone="secondary">
                          {entry.kind} · {formatTimestamp(entry.occurredAt)}
                        </Text>
                        <Text>{entry.summary}</Text>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="work-inspector-section">
                <Text as="h3" variant="label">
                  Requests
                </Text>
                {selected.requests === undefined ? (
                  <Text tone="secondary">No requests recorded.</Text>
                ) : requestsFor(selected).length === 0 ? (
                  <Text tone="secondary">No outstanding requests.</Text>
                ) : (
                  <ul className="work-detail-list">
                    {requestsFor(selected).map((request) => (
                      <li key={request.id}>
                        <div className="work-request-heading">
                          <Text>{request.summary}</Text>
                          <StateLabel
                            label={requestPresentation[request.state].label}
                            size="compact"
                            tone={requestPresentation[request.state].tone}
                          />
                        </div>
                        {request.approvalTarget === null ? (
                          <Text tone="secondary" variant="meta">
                            No approval link recorded.
                          </Text>
                        ) : externalLinks === "disabled" ? (
                          <Text tone="secondary" variant="meta">
                            Approval target recorded.
                          </Text>
                        ) : (
                          exactLink(request.approvalTarget, `Open ${request.approvalTarget.host} approval`)
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="work-inspector-section">
                <Text as="h3" variant="label">
                  Review
                </Text>
                <div className="work-review-heading">
                  {reviewLabel(selected.review)}
                  {selected.review?.url === null || selected.review?.url === undefined ? null : externalLinks ===
                    "disabled" ? (
                    <Text tone="secondary" variant="meta">
                      Review target recorded.
                    </Text>
                  ) : (
                    reviewLink(selected.review.url)
                  )}
                </div>
                {selected.review?.summary === null || selected.review?.summary === undefined ? null : (
                  <Text tone="secondary">{selected.review.summary}</Text>
                )}
              </div>
              {(() => {
                const group = familyForGoal(snapshot, selected.id)
                if (group === null) return null
                return (
                  <div className="work-inspector-section">
                    <Text as="h3" variant="label">
                      Superseded history
                    </Text>
                    <Text tone="secondary" variant="meta">
                      Canonical {group.canonicalGoalId} · {group.superseded.length} superseded preserved
                    </Text>
                    <details className="work-family-history">
                      <summary>Show {group.superseded.length} superseded</summary>
                      <ul className="work-detail-list">
                        {group.superseded.map((entry) => (
                          <li key={entry.id}>
                            <div className="work-request-heading">
                              <Text>{entry.title}</Text>
                              <StateLabel
                                label={statePresentation[entry.state].label}
                                size="compact"
                                tone={statePresentation[entry.state].tone}
                              />
                            </div>
                            <Text tone="secondary" variant="meta">
                              {entry.summary} · {formatTimestamp(entry.updatedAt)}
                            </Text>
                            {blockersFor(entry).length === 0 ? null : (
                              <ul className="work-detail-list">
                                {blockersFor(entry).map((blocker) => (
                                  <li key={`${blocker.since}-${blocker.summary}`}>
                                    <Text tone="secondary" variant="meta">
                                      Blocker: {blocker.summary} · {formatTimestamp(blocker.since)}
                                    </Text>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {entry.review === undefined || entry.review === null ? null : (
                              <Text tone="secondary" variant="meta">
                                Review {reviewPresentation[entry.review.state].label}
                                {entry.review.summary === null ? "" : ` · ${entry.review.summary}`}
                              </Text>
                            )}
                            {entry.activity === undefined || entry.activity.length === 0 ? null : (
                              <Text tone="secondary" variant="meta">
                                Activity {entry.activity.length} checkpoint
                                {entry.activity.length === 1 ? "" : "s"}
                              </Text>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                )
              })()}
              {selected.connectTarget === null ? (
                <Text tone="secondary">No exact Connect target recorded.</Text>
              ) : externalLinks === "disabled" ? (
                <Text tone="secondary" variant="meta">
                  Connect target recorded.
                </Text>
              ) : (
                <a className="work-connect-link" href={selected.connectTarget.url}>
                  Open exact agent in Connect →
                </a>
              )}
              {selected.approvalTarget === undefined || selected.approvalTarget === null ? (
                <Text tone="secondary">No exact approval target recorded.</Text>
              ) : externalLinks === "disabled" ? (
                <Text tone="secondary" variant="meta">
                  Approval target recorded.
                </Text>
              ) : (
                exactLink(selected.approvalTarget, `Open ${selected.approvalTarget.host} approval`)
              )}
            </Surface>
          )}
        </div>
      )}
      {selected === null || !detailsOpen ? null : (
        <Surface className="work-delivery-evidence" padding="spacious">
          <StageRail heading={`Shipment path · ${selected.title}`} stages={stagesFor(selected)} />
        </Surface>
      )}
    </section>
  )
}
