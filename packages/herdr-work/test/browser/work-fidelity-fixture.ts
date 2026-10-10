import type { WorkGoal, WorkGoalObservedEntry, WorkSnapshot, WorkSnapshots } from "../../src/model.js"

export const workFidelityStates = [
  "populated",
  "detail",
  "owner-gone",
  "clear",
  "empty",
  "historical",
  "missing-overlay",
  "trimmed",
  "read-only",
  "long"
] satisfies ReadonlyArray<string>

export type WorkFidelityState = typeof workFidelityStates[number]

const NOW = Date.parse("2026-10-10T14:02:31Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const seeds: ReadonlyArray<{
  readonly id: string
  readonly title: string
  readonly owner: string
  readonly host: string
  readonly state: WorkGoal["state"]
  readonly delivery: WorkGoal["delivery"]
}> = [
  {
    id: "backup",
    title: "Fix offline-backup flake",
    owner: "rev-usage",
    host: "birch",
    state: "blocked",
    delivery: "local"
  },
  {
    id: "usage",
    title: "Usage tab reviewer",
    owner: "pkgsrc",
    host: "birch",
    state: "review",
    delivery: "pull_request"
  },
  {
    id: "connect",
    title: "Connect characters polish",
    owner: "ds-rly",
    host: "atlas",
    state: "working",
    delivery: "local"
  },
  {
    id: "security",
    title: "Security fixes F1/F4/F5/F6",
    owner: "sec-cc",
    host: "atlas",
    state: "planned",
    delivery: "local"
  },
  { id: "logo", title: "Relay logo", owner: "skills", host: "atlas", state: "completed", delivery: "local" },
  {
    id: "migration",
    title: "Old lane migration",
    owner: "pair-codex",
    host: "atlas",
    state: "abandoned",
    delivery: "review"
  }
]

const goals: ReadonlyArray<WorkGoal> = seeds.map((seed) => ({
  blocker: seed.state === "blocked" ? { since: NOW - 18 * MINUTE, summary: "Approve reassign" } : null,
  connectTarget: { agentId: seed.owner, host: seed.host, url: `/connect/?agent=${seed.owner}&host=${seed.host}` },
  createdAt: NOW - 2 * DAY,
  delivery: seed.delivery,
  detail: seed.title,
  id: seed.id,
  owner: { id: seed.owner, name: seed.owner },
  repository: { branch: `feat/${seed.id}`, repository: "knpkv/npm" },
  requests: seed.id === "backup"
    ? [{
      approvalTarget: null,
      id: "reassign",
      requestedAt: NOW - 18 * MINUTE,
      state: "open",
      summary: "Approve reassign"
    }]
    : [],
  spend: null,
  state: seed.state,
  summary: seed.title,
  title: seed.title,
  updatedAt: seed.id === "logo" ? NOW - 3 * HOUR : seed.id === "migration" ? NOW - 2 * DAY : NOW - MINUTE
}))

const emptyObservation = { agent: null, pullRequest: null, stale: false, unknown: null }
const observations: ReadonlyArray<WorkGoalObservedEntry> = [{
  ...emptyObservation,
  displayState: "review",
  goalId: "usage",
  pullRequest: {
    confirmedAt: NOW - MINUTE,
    fact: {
      _tag: "pull_request",
      branch: "feat/usage",
      checks: "passing",
      closedAt: null,
      head: "a".repeat(40),
      pullRequest: 712,
      repository: "knpkv/npm",
      review: "requested",
      state: "open"
    },
    observedAt: NOW - 2 * MINUTE
  }
}]

/** Work's reference inventory. Variants change only the named state; the page and observations are the live view. */
export const workFidelitySnapshots = (state: WorkFidelityState): WorkSnapshots => {
  const entries = state === "empty" ? [] : state === "clear" ? goals.filter((goal) => goal.state !== "blocked") : goals
  const named = state === "long" ?
    entries.map((goal) =>
      goal.id === "connect" ?
        {
          ...goal,
          title: "Work checkpoint recovery and reconciliation for the fleet coordinator",
          repository: { ...goal.repository, branch: "feat/implementWorkCheckpointRecoveryAndReconciliation" }
        } :
        goal
    ) :
    entries
  const window = (name: WorkSnapshot["window"]): WorkSnapshot => ({
    asOf: name === "now" ? NOW : NOW - DAY,
    goals: named,
    observedAt: NOW,
    window: name
  })
  const observed = state === "owner-gone" ?
    [
      ...observations,
      {
        ...emptyObservation,
        agent: {
          confirmedAt: NOW,
          fact: { _tag: "agent", agentId: "ds-rly", host: "atlas", status: "gone" },
          observedAt: NOW - 5 * HOUR
        },
        displayState: "working",
        goalId: "connect",
        stale: true
      } satisfies WorkGoalObservedEntry
    ] :
    observations
  const live = window("now")
  const retained = state === "empty" ? live : { ...live, finishedOmitted: 47 }
  const overlaid = state === "missing-overlay" ? retained : { ...retained, observed }
  const now = state === "trimmed" ? { ...overlaid, goalsOmitted: 12, observedOmitted: 3 } : overlaid
  return {
    day: window("day"),
    month: window("month"),
    observedAt: NOW,
    week: window("week"),
    now
  }
}
