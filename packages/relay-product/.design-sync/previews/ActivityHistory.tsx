// Fixtures from packages/herdr-hub/test/activity-history.test.tsx, packages/herdr-hub/test/dashboard-view.test.tsx.
import { ActivityHistory } from "@knpkv/relay-app-design-system"
import type { DashboardViewProps } from "@knpkv/herdr-hub/views"

type Record = DashboardViewProps["snapshot"]["records"][number]

const summarized: Record = {
  actor: "local",
  approvalAvailable: false,
  approvalExpiresAt: null,
  approvedAt: 3_000,
  approvedBy: "owner@example.com",
  createdAt: 1_000,
  expiredAt: null,
  id: "job-transition-summary",
  payload: {
    kind: "agent.delegate",
    mode: "transition_summary",
    prompt: "[redacted internal prompt]",
    repository: "/repo"
  },
  rejectedAt: null,
  rejectedBy: null,
  status: "succeeded",
  updatedAt: 4_000,
  workerTerminalObservedAt: null
}

const failed: Record = {
  actor: "submitter@example.com",
  approvalAvailable: false,
  approvalExpiresAt: null,
  approvedAt: 2_000,
  approvedBy: "owner@example.com",
  createdAt: 1_000,
  expiredAt: null,
  id: "job-1",
  payload: { kind: "nix.apply", ref: "main" },
  rejectedAt: null,
  rejectedBy: null,
  status: "failed",
  updatedAt: 3_000
}

const noop = () => undefined
const records = [summarized, failed]
const many = Array.from({ length: 30 }, (_, index): Record => ({
  ...summarized,
  id: `job-${String(index)}`,
  updatedAt: summarized.updatedAt + index
}))

export const Default = () => <ActivityHistory records={records} />
export const Empty = () => <ActivityHistory records={[]} />
export const ManyItems = () => <ActivityHistory records={many} />
export const LoadingEarlier = () => <ActivityHistory hasMore loading onLoadMore={noop} records={records} />
