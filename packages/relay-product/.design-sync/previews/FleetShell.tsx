// Fixtures from packages/herdr-hub/test/shell-view.test.tsx, packages/herdr-hub/test/dashboard-view.test.tsx, packages/herdr-hub/test/refresh-status.test.tsx.
import { DashboardView, FleetShell, RefreshStatus } from "@knpkv/relay-app-design-system"
import type { DashboardViewProps } from "@knpkv/herdr-hub/views"

type Snapshot = DashboardViewProps["snapshot"]
type Record = Snapshot["records"][number]

const pending: Record = {
  actor: "submitter@example.com",
  approvalExpiresAt: 61_000,
  approvedAt: null,
  approvedBy: null,
  createdAt: 1_000,
  expiredAt: null,
  id: "job-1",
  payload: { kind: "nix.apply", ref: "main" },
  approvalAvailable: true,
  rejectedAt: null,
  rejectedBy: null,
  status: "pending_approval",
  updatedAt: 1_000
}

const snapshot: Snapshot = {
  approvalApp: {
    canonical: false,
    canonicalUrl: "https://ser8.example.test/",
    pushEnabled: false,
    workEnabled: false
  },
  approvalsEnabled: true,
  work: null,
  directory: null,
  host: "ALPHA",
  historyNextCursor: null,
  observedAt: 1_000,
  pendingApprovals: { failures: [], local: [pending], nextCursors: [], remote: [] },
  records: [pending],
  status: {
    applyConfigured: true,
    branch: "main",
    dirty: false,
    herdr: { agents: [], available: true, error: null },
    host: "ALPHA",
    repository: "/repo",
    revision: "abc123"
  }
}

const noop = () => undefined
const approvals = (
  <DashboardView
    approvalOnly
    busyJobId={null}
    notificationState="disabled"
    onDecision={noop}
    onDisableNotifications={noop}
    onEnableNotifications={noop}
    onRefresh={noop}
    pull={{ distance: 0, ready: false, refreshing: false }}
    showHeader={false}
    snapshot={snapshot}
  />
)
const panels = { approvals, connect: null, usage: null, work: null }

export const Default = () => <FleetShell {...panels} hostCount={3} />
export const SingleHost = () => <FleetShell {...panels} hostCount={1} />
export const FailedRefresh = () => (
  <FleetShell
    {...panels}
    hostCount={1}
    notice={<RefreshStatus failed observedAt={1_000} onRetry={noop} />}
  />
)

