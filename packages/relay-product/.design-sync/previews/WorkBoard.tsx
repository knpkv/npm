// Fixtures from packages/herdr-work/test/control-app.test.ts, packages/herdr-work/test/work-request-decision.test.tsx.
import { WorkBoard } from "@knpkv/relay-app-design-system"
import type { WorkGoal, WorkSnapshot, WorkSnapshots } from "@knpkv/herdr-work/model"
import type { WorkRequestDecisions } from "@knpkv/herdr-work/react"

const noop = () => undefined
const goal: WorkGoal = {
  blocker: null,
  connectTarget: {
    agentId: "agent-work-owner",
    host: "SER8",
    url: "/connect/?agent=agent-work-owner&host=SER8"
  },
  agentHierarchy: {
    agent: {
      agentId: "agent-work-owner",
      host: "SER8",
      name: "Work owner",
      paneId: "w1:p2",
      relationship: { parentAgentId: "agent-coordinator", relation: "delegated" }
    }
  },
  activity: [
    { id: "activity-started", kind: "status", occurredAt: 2_000, summary: "Agent started the implementation" },
    { id: "activity-shipped", kind: "shipment", occurredAt: 3_000, summary: "Pull request opened" }
  ],
  blockers: [],
  createdAt: 1_000,
  delivery: "pull_request",
  detail: "Keep the daily fleet handoff visible in one place",
  goalFamily: { canonicalGoalId: "goal-work-control-app", role: "canonical" },
  id: "goal-work-control-app",
  owner: { id: "owner-coordinator", name: "Coordinator" },
  repository: { branch: "feat/herdr-work-control-app", repository: "npm" },
  requests: [
    {
      approvalTarget: {
        host: "SER8",
        jobId: "approval-job-42",
        url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
      },
      id: "request-review",
      requestedAt: 3_000,
      state: "open",
      summary: "Approve the package shipment"
    }
  ],
  review: {
    state: "requested",
    summary: "Waiting for the fresh package review",
    updatedAt: 3_000,
    url: "https://github.com/knpkv/npm/pull/400"
  },
  spend: null,
  state: "working",
  summary: "Track agent work through shipment",
  title: "Daily fleet Work",
  updatedAt: 3_000,
  approvalTarget: {
    host: "SER8",
    jobId: "approval-job-42",
    url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
  }
}

const snapshotsOf = (goals: ReadonlyArray<WorkGoal>): WorkSnapshots => {
  const snapshot = (window: WorkSnapshot["window"]): WorkSnapshot => ({
    asOf: 3_000,
    goals,
    observedAt: 3_000,
    window
  })
  return {
    day: snapshot("day"),
    month: snapshot("month"),
    now: snapshot("now"),
    observedAt: 3_000,
    week: snapshot("week")
  }
}
const snapshots = snapshotsOf([goal])
const crowded = snapshotsOf(
  Array.from({ length: 47 }, (_, index): WorkGoal => ({
    ...goal,
    id: `goal-${String(index + 1).padStart(2, "0")}`,
    state: index % 3 === 0 ? "blocked" : "working",
    blocker: index % 3 === 0 ? { since: 2_000, summary: "Waiting for review" } : null,
    title: `Goal ${String(index + 1).padStart(2, "0")}`
  }))
)
const decisions: WorkRequestDecisions = {
  answer: null,
  expiresAt: (jobId) => (jobId === "approval-job-42" ? 1_000_000 + 4 * 60_000 + 12_000 : undefined),
  now: 1_000_000,
  onDecision: noop,
  sending: null
}

export const Default = () => <WorkBoard snapshots={snapshots} />
export const GoalDetails = () => <WorkBoard initialGoalId={goal.id} snapshots={snapshots} />
export const PendingApproval = () => <WorkBoard decisions={decisions} initialGoalId={goal.id} snapshots={snapshots} />
export const ManyGoals = () => <WorkBoard snapshots={crowded} />
export const Empty = () => <WorkBoard snapshots={snapshotsOf([])} />
