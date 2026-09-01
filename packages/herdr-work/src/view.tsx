import { Button, Divider, StateLabel, Surface, Text, type RlyStateTone } from "@knpkv/rly/primitives"
import { StageRail, type RlyStage } from "@knpkv/rly/patterns"
import { useState, type ReactElement } from "react"
import type {
  DeliveryStage,
  WorkActivity,
  WorkApprovalTarget,
  WorkGoal,
  WorkRequest,
  WorkReview,
  WorkSnapshot,
  WorkSnapshots,
  WorkSnapshotWindow,
  WorkBlocker
} from "./model.js"

const windows: ReadonlyArray<WorkSnapshotWindow> = ["now", "day", "week", "month"]
const stageOrder: ReadonlyArray<DeliveryStage> = ["local", "review", "pull_request", "merged", "deployed"]

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

export const WorkBoard = ({ snapshots }: { readonly snapshots: WorkSnapshots }): ReactElement => {
  const [window, setWindow] = useState<WorkSnapshotWindow>("now")
  const snapshot = snapshotFor(snapshots, window)
  const [selectedId, setSelectedId] = useState<string | null>(snapshot.goals[0]?.id ?? null)
  const selected = snapshot.goals.find(({ id }) => id === selectedId) ?? null
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
          {windows.map((option) => (
            <Button
              aria-pressed={window === option}
              key={option}
              onClick={() => setWindow(option)}
              variant={window === option ? "primary" : "secondary"}
            >
              {windowLabel[option]}
            </Button>
          ))}
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
            {snapshot.goals.map((goal) => (
              <button
                aria-pressed={selected?.id === goal.id}
                className="work-board-row"
                key={goal.id}
                onClick={() => setSelectedId(goal.id)}
                type="button"
              >
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
              </button>
            ))}
          </Surface>
          {selected === null ? null : (
            <Surface as="aside" className="work-inspector" padding="spacious">
              <StateLabel
                label={statePresentation[selected.state].label}
                tone={statePresentation[selected.state].tone}
              />
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
                  {selected.review?.url === null || selected.review?.url === undefined
                    ? null
                    : reviewLink(selected.review.url)}
                </div>
                {selected.review?.summary === null || selected.review?.summary === undefined ? null : (
                  <Text tone="secondary">{selected.review.summary}</Text>
                )}
              </div>
              {selected.connectTarget === null ? (
                <Text tone="secondary">No exact Connect target recorded.</Text>
              ) : (
                <a className="work-connect-link" href={selected.connectTarget.url}>
                  Open exact agent in Connect →
                </a>
              )}
              {selected.approvalTarget === undefined || selected.approvalTarget === null ? (
                <Text tone="secondary">No exact approval target recorded.</Text>
              ) : (
                exactLink(selected.approvalTarget, `Open ${selected.approvalTarget.host} approval`)
              )}
            </Surface>
          )}
        </div>
      )}
      {selected === null ? null : (
        <Surface className="work-delivery-evidence" padding="spacious">
          <StageRail heading={`Shipment path · ${selected.title}`} stages={stagesFor(selected)} />
        </Surface>
      )}
    </section>
  )
}
