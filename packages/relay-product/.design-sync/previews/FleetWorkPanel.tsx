// Fixtures from packages/herdr-hub/test/iphone-fleet-shell.test.tsx, packages/herdr-hub/test/lan-work.test.ts.
import { FleetWorkPanel, WorkBoard } from "@knpkv/relay-app-design-system"
import type { WorkGoal, WorkSnapshots } from "@knpkv/herdr-work"

const goal = {
  blocker: null,
  connectTarget: null,
  createdAt: 0,
  delivery: "local",
  detail: "Inspect the read-only LAN projection",
  id: "goal-lan",
  owner: { id: "owner-lan", name: "LAN owner" },
  repository: { branch: "main", repository: "npm" },
  spend: null,
  state: "working",
  summary: "Review LAN Work",
  title: "LAN Work",
  updatedAt: 0
} satisfies WorkGoal

const snapshots = {
  observedAt: 0,
  now: { asOf: 0, observedAt: 0, window: "now", goals: [goal] },
  day: { asOf: 0, observedAt: 0, window: "day", goals: [goal] },
  week: { asOf: 0, observedAt: 0, window: "week", goals: [goal] },
  month: { asOf: 0, observedAt: 0, window: "month", goals: [goal] }
} satisfies WorkSnapshots

const board = <WorkBoard externalLinks="disabled" snapshots={snapshots} />

export const Ready = () => (
  <FleetWorkPanel state={{ _tag: "Ready", content: board }} />
)
export const Loading = () => <FleetWorkPanel state={{ _tag: "Loading" }} />
export const Unavailable = () => <FleetWorkPanel state={{ _tag: "Unavailable" }} />
export const Failure = () => (
  <FleetWorkPanel state={{ _tag: "Failure", content: null, detail: "Work request failed. Refresh to retry." }} />
)
export const Stale = () => (
  <FleetWorkPanel
    state={{
      _tag: "Failure",
      content: board,
      detail: "Work request failed. Refresh to retry."
    }}
  />
)
