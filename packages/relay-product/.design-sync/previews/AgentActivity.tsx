// Fixtures from packages/herdr-hub/test/dashboard-view.test.tsx.
import { AgentActivity } from "@knpkv/relay-app-design-system"
import type { DashboardViewProps } from "@knpkv/herdr-hub/views"

type Snapshot = DashboardViewProps["snapshot"]
type Herdr = Snapshot["status"]["herdr"]

const agents: Herdr["agents"] = [
  {
    activityRevision: 2,
    agentId: "agent-working",
    kind: "codex",
    name: "worker",
    paneId: "w1:p1",
    parentAgentId: null,
    relation: null,
    status: "working",
    work: "package migration"
  },
  {
    activityRevision: 1,
    agentId: "agent-done",
    kind: "codex",
    name: "reviewer",
    paneId: "w1:p2",
    parentAgentId: null,
    relation: null,
    status: "done",
    work: "UI review"
  }
]

const snapshot = (herdr: Herdr): Snapshot => ({
  approvalApp: {
    canonical: false,
    canonicalUrl: "https://ser8.example.test/",
    pushEnabled: false,
    workEnabled: false
  },
  approvalsEnabled: true,
  directory: null,
  historyNextCursor: null,
  host: "ALPHA",
  observedAt: 1_000,
  pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] },
  records: [],
  status: {
    applyConfigured: true,
    branch: "main",
    dirty: false,
    herdr,
    host: "ALPHA",
    repository: "/repo",
    revision: "abc123"
  },
  work: null
})

export const Default = () => <AgentActivity snapshot={snapshot({ agents, available: true, error: null })} />
export const Empty = () => <AgentActivity snapshot={snapshot({ agents: [], available: true, error: null })} />
export const Unavailable = () => (
  <AgentActivity snapshot={snapshot({ agents: [], available: false, error: "socket missing" })} />
)
