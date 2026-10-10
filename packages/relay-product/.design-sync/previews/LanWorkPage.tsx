// Fixtures from packages/herdr-hub/test/lan-work.test.ts.
import { LanWorkPage } from "@knpkv/relay-app-design-system"
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

const snapshots = (goals: ReadonlyArray<WorkGoal>): WorkSnapshots => ({
  observedAt: 0,
  now: { asOf: 0, observedAt: 0, window: "now", goals },
  day: { asOf: 0, observedAt: 0, window: "day", goals },
  week: { asOf: 0, observedAt: 0, window: "week", goals },
  month: { asOf: 0, observedAt: 0, window: "month", goals }
})

const populated = snapshots([goal])
const empty = snapshots([])

export const Default = () => <LanWorkPage snapshots={populated} />
export const SelectedGoal = () => <LanWorkPage goalId="goal-lan" snapshots={populated} window="week" />
export const Empty = () => <LanWorkPage snapshots={empty} />
