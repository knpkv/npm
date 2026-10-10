// Fixtures from packages/herdr-hub/test/countdown-view.test.tsx.
import { ApprovalsCountdown } from "@knpkv/relay-app-design-system"
import type { ApprovalsCountdown as CountdownComponent, DashboardViewProps } from "@knpkv/herdr-hub/views"
import type { ComponentProps } from "react"

const OBSERVED_AT = 1_800_000_000_000
type Snapshot = DashboardViewProps["snapshot"]
type Record = Snapshot["records"][number]

const pending: Record = {
  actor: "submitter@example.com",
  approvalExpiresAt: OBSERVED_AT + 4 * 60_000,
  approvedAt: null,
  approvedBy: null,
  createdAt: OBSERVED_AT - 60_000,
  expiredAt: null,
  id: "job-1",
  payload: { kind: "nix.apply", ref: "main" },
  approvalAvailable: true,
  rejectedAt: null,
  rejectedBy: null,
  status: "pending_approval",
  updatedAt: OBSERVED_AT
}

const snapshot: Snapshot = {
  approvalApp: {
    canonical: true,
    canonicalUrl: "https://hub.example.test/",
    pushEnabled: false,
    workEnabled: false
  },
  approvalsEnabled: true,
  work: null,
  directory: null,
  host: "ALPHA",
  historyNextCursor: null,
  observedAt: OBSERVED_AT,
  pendingApprovals: { failures: [], local: [pending], nextCursors: [], remote: [] },
  records: [],
  status: {
    applyConfigured: true,
    branch: "main",
    dirty: false,
    herdr: { agents: [], available: true, error: null },
    host: "ALPHA",
    repository: "/repo",
    revision: "abc"
  }
}

const noop = () => undefined
const props = {
  decisionStatus: null,
  historyLoading: false,
  onDecision: noop,
  onLoadHistory: noop,
  onLoadPending: noop,
  onRevalidate: noop,
  pendingLoading: false,
  sending: null
} satisfies Omit<ComponentProps<typeof CountdownComponent>, "snapshot">

const empty: Snapshot = {
  ...snapshot,
  pendingApprovals: { failures: [], local: [], nextCursors: [], remote: [] }
}

export const Pending = () => <ApprovalsCountdown {...props} snapshot={snapshot} />
export const Sending = () => (
  <ApprovalsCountdown {...props} sending={{ decision: "approve", jobId: "job-1" }} snapshot={snapshot} />
)
export const Refused = () => (
  <ApprovalsCountdown
    {...props}
    decisionStatus={{
      jobId: "job-1",
      observedAt: OBSERVED_AT,
      settles: true,
      text: "The hub refused: this request already changed.",
      outcome: "refused",
      expiresAt: undefined
    }}
    snapshot={snapshot}
  />
)
export const Empty = () => <ApprovalsCountdown {...props} snapshot={empty} />
export const HostUnchecked = () => (
  <ApprovalsCountdown
    {...props}
    snapshot={{
      ...empty,
      pendingApprovals: {
        ...empty.pendingApprovals,
        failures: [{ host: "BETA", reason: "offline" }]
      }
    }}
  />
)

