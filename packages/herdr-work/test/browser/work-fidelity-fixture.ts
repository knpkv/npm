import type { WorkGoal, WorkGoalObservedEntry, WorkRequest, WorkSnapshot, WorkSnapshots } from "../../src/model.js"
import { encodeWorkBoardNavigationGoal } from "../../src/navigation.js"
import type { WorkRequestDecisions } from "../../src/request-decision.js"

export const workFidelityStates = [
  "3a",
  "3b",
  "3c",
  "3d",
  "3e",
  "3f",
  "3g",
  "3h",
  "3h-v2",
  "3l",
  "3n",
  "3o"
] satisfies ReadonlyArray<string>
export type WorkFidelityState = typeof workFidelityStates[number]

const NOW = Date.parse("2026-10-10T14:02:31Z")
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const request = (id: string, summary: string, age: number, state: WorkRequest["state"] = "open"): WorkRequest => ({
  id,
  summary,
  state,
  requestedAt: NOW - age,
  approvalTarget: {
    host: "atlas",
    jobId: id,
    url: `https://relay.example/?tab=approvals&approvalHost=atlas&approvalJob=${id}`
  }
})

const seeds: ReadonlyArray<{
  readonly id: string
  readonly title: string
  readonly owner: string
  readonly host: string | null
  readonly state: WorkGoal["state"]
  readonly delivery: WorkGoal["delivery"]
  readonly age?: number
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
    owner: "rev-usage",
    host: "birch",
    state: "review",
    delivery: "pull_request"
  },
  { id: "cache", title: "Rotate birch cache key", owner: "sec-cc", host: "atlas", state: "blocked", delivery: "local" },
  {
    id: "connect",
    title: "Connect characters polish",
    owner: "ds-rly",
    host: "atlas",
    state: "working",
    delivery: "local"
  },
  {
    id: "countdown",
    title: "Approvals countdown copy",
    owner: "sec-cc",
    host: "atlas",
    state: "working",
    delivery: "review"
  },
  {
    id: "push",
    title: "Hub push retries",
    owner: "pair-codex",
    host: "atlas",
    state: "review",
    delivery: "pull_request"
  },
  {
    id: "security",
    title: "Security fixes F1/F4/F5/F6",
    owner: "Unassigned",
    host: null,
    state: "planned",
    delivery: "local"
  },
  { id: "csv", title: "Usage export as CSV", owner: "Unassigned", host: null, state: "planned", delivery: "local" },
  {
    id: "logo",
    title: "Relay logo",
    owner: "ds-rly",
    host: null,
    state: "completed",
    delivery: "merged",
    age: 3 * HOUR
  },
  {
    id: "copy",
    title: "Approvals copy pass",
    owner: "sec-cc",
    host: null,
    state: "completed",
    delivery: "local",
    age: 6 * HOUR
  },
  {
    id: "migration",
    title: "Old lane migration",
    owner: "skills",
    host: null,
    state: "abandoned",
    delivery: "local",
    age: 3 * DAY
  },
  {
    id: "deploy",
    title: "Deploy hub 0.19 to atlas",
    owner: "ds-rly",
    host: null,
    state: "deployed",
    delivery: "merged",
    age: 2 * DAY
  }
]

const goals: ReadonlyArray<WorkGoal> = seeds.map((seed) => ({
  blocker: seed.state === "blocked"
    ? { since: NOW - 18 * MINUTE, summary: seed.id === "cache" ? "Waiting on cedar (offline)" : "Approve reassign" }
    : null,
  connectTarget: seed.host === null
    ? null
    : { agentId: `agent-${seed.owner}`, host: seed.host, url: `/connect/?agent=agent-${seed.owner}&host=${seed.host}` },
  createdAt: NOW - 10 * DAY,
  delivery: seed.delivery,
  detail: seed.title,
  id: seed.id,
  owner: { id: seed.owner, name: seed.owner },
  repository: {
    branch: seed.id === "usage" ? "rev-usage/usage-tab-reviewer" : `feat/${seed.id}`,
    repository: "knpkv/example"
  },
  requests: seed.id === "backup" ?
    [request("reassign", "Approve reassign to pair-codex", 18 * MINUTE)]
    : seed.id === "usage" ?
    [
      request("merge", "Approve PR #712 for merge", 6 * MINUTE),
      request("fixtures", "Run usage fixtures on birch", HOUR, "fulfilled"),
      request("skip", "Skip snapshot tests", 2 * HOUR, "rejected"),
      request("draft", "Open a draft pull request", 3 * HOUR, "approved")
    ] :
    seed.id === "push"
    ? [request("retry", "Retry push to birch with backoff", 5 * HOUR, "approved")]
    : [],
  activity: seed.id === "usage" ?
    [
      {
        id: "request",
        kind: "request",
        occurredAt: NOW - MINUTE,
        summary: "rev-usage asked: Approve PR #712 for merge"
      },
      { id: "checks", kind: "review", occurredAt: NOW - 10 * MINUTE, summary: "Checks passed on PR #712" },
      { id: "agent", kind: "status", occurredAt: NOW - 21 * MINUTE, summary: "rev-usage blocked, waiting for review" },
      { id: "delegated", kind: "note", occurredAt: NOW - 92 * MINUTE, summary: "Goal delegated to rev-usage by coord" }
    ] :
    [],
  spend: null,
  state: seed.state,
  summary: seed.title,
  title: seed.title,
  updatedAt: NOW - (seed.age ?? MINUTE)
}))

const emptyObservation = { agent: null, pullRequest: null, stale: false, unknown: null }
const observations: ReadonlyArray<WorkGoalObservedEntry> = [
  {
    ...emptyObservation,
    goalId: "usage",
    displayState: "review",
    agent: {
      confirmedAt: NOW,
      observedAt: NOW - 21 * MINUTE,
      fact: { _tag: "agent", agentId: "agent-rev-usage", host: "birch", status: "blocked" }
    },
    pullRequest: {
      confirmedAt: NOW,
      observedAt: NOW - 52 * MINUTE,
      fact: {
        _tag: "pull_request",
        branch: "rev-usage/usage-tab-reviewer",
        checks: "passing",
        closedAt: null,
        head: "a".repeat(40),
        pullRequest: 712,
        repository: "knpkv/example",
        review: "requested",
        state: "open"
      }
    }
  },
  {
    ...emptyObservation,
    goalId: "push",
    displayState: "review",
    pullRequest: {
      confirmedAt: NOW - 4 * MINUTE,
      observedAt: NOW - 322 * MINUTE,
      fact: {
        _tag: "pull_request",
        branch: "feat/push",
        checks: "pending",
        closedAt: null,
        head: "b".repeat(40),
        pullRequest: 708,
        repository: "knpkv/example",
        review: "not_requested",
        state: "open"
      }
    }
  }
]

interface WorkFidelitySelection {
  readonly goalId: string
  readonly window: WorkSnapshot["window"]
}

/** Reference state identity, including history and inspector selection. No invented snapshot paging. */
export const workFidelitySelection = (state: WorkFidelityState): WorkFidelitySelection => {
  const window = state === "3f" ? "month" : state === "3h" || state === "3h-v2" ? "week" : "now"
  return {
    window,
    goalId: encodeWorkBoardNavigationGoal({
      detailsOpen: state === "3b" || state === "3c" || state === "3l" || state === "3n" || state === "3o",
      goalId: state === "3c"
        ? "push"
        : state === "3o"
        ? "long"
        : state === "3b" || state === "3l" || state === "3n"
        ? "usage"
        : null,
      statusFilter: state === "3g" ? "deployed" : "all",
      visibleGoalCount: 12
    })
  }
}

export const workFidelityDecisions: WorkRequestDecisions = {
  answer: null,
  sending: null,
  now: NOW,
  expiresAt: (id) => id === "merge" || id === "long-request" ? NOW + 41 * MINUTE : undefined,
  onDecision: () => undefined
}

/** Twelve named reference goals; counts for response and finished-retention cuts stay distinct. */
export const workFidelitySnapshots = (state: WorkFidelityState): WorkSnapshots => {
  let entries = goals
  if (state === "3e" || state === "3f") entries = []
  if (state === "3d") entries = goals.filter((goal) => !["backup", "usage", "cache"].includes(goal.id))
  if (state === "3g") entries = goals.filter((goal) => goal.state !== "deployed")
  if (state === "3h" || state === "3h-v2") {
    entries = goals.filter((goal) =>
      (state === "3h-v2"
        ? ["connect", "push", "security"]
        : ["backup", "usage", "countdown", "connect", "push", "security"]).includes(goal.id)
    )
      .map((goal) => ({
        ...goal,
        createdAt: NOW - 20 * DAY,
        updatedAt: NOW - 7 * DAY - MINUTE,
        state: goal.id === "countdown" && state === "3h" ? "blocked" : goal.state,
        blocker: goal.id === "countdown" && state === "3h"
          ? { since: NOW - 7 * DAY - MINUTE, summary: "Approval was open then" }
          : goal.blocker === null
          ? null
          : { ...goal.blocker, since: goal.blocker.since - 7 * DAY },
        delivery: goal.id === "countdown" && state === "3h" ? "local" : goal.delivery,
        activity: (goal.activity ?? []).map((entry) => ({ ...entry, occurredAt: entry.occurredAt - 7 * DAY })),
        requests: state === "3h-v2"
          ? []
          : goal.id === "countdown"
          ? [request("past-copy", "Approve countdown copy", 7 * DAY + 5 * MINUTE)]
          : (goal.requests ?? []).map((entry) => ({ ...entry, requestedAt: entry.requestedAt - 7 * DAY }))
      }))
  }
  if (state === "3l") {
    entries = goals.map((goal) =>
      goal.id === "usage"
        ? {
          ...goal,
          review: { state: "requested", summary: null, updatedAt: NOW - MINUTE, url: null },
          activity: [...(goal.activity ?? []), {
            id: "opened",
            kind: "note",
            occurredAt: NOW - 52 * MINUTE,
            summary: "PR #712 opened on knpkv/example"
          }]
        }
        : goal
    )
  }
  if (state === "3o") {
    const first = goals[0]
    if (first !== undefined) {
      entries = [{
        ...first,
        id: "long",
        state: "working",
        delivery: "local",
        blocker: null,
        title:
          "Reconcile the nightly dependency refresh across every workspace package, rebase the release branch, and publish derivations to birch",
        detail:
          "Reconcile the nightly dependency refresh across every workspace package, rebase the release branch, and publish derivations to birch",
        owner: {
          id: "coordinator-for-monster-banana-builder-review",
          name: "coordinator-for-monster-banana-builder-review"
        },
        repository: {
          repository: "knpkv/relay-infrastructure-monorepo-with-nix-flakes-and-hub-services",
          branch: "coordinator-for-monster-banana-builder-review/nightly-dependency-refresh-and-lockfile-reconciliation"
        },
        connectTarget: {
          agentId: "agent-coordinator-for-monster-banana-builder-review",
          host: "monster-banana-builder",
          url: "/connect/?agent=agent-coordinator-for-monster-banana-builder-review&host=monster-banana-builder"
        },
        requests: [
          request(
            "long-request",
            "Approve rebasing release/2026.10-freeze-candidate onto main@4f2c1e0 and force-pushing the result",
            4 * MINUTE
          )
        ],
        activity: [{
          id: "delegated",
          kind: "note",
          occurredAt: NOW - 42 * MINUTE,
          summary: "Goal delegated to coordinator-for-monster-banana-builder-review by coord"
        }]
      }, ...goals.filter((goal) => goal.id === "backup" || goal.id === "connect")]
    }
  }
  const observed = state === "3c" ?
    observations.map((entry) =>
      entry.goalId === "push" ?
        {
          ...entry,
          stale: true,
          agent: {
            confirmedAt: NOW,
            observedAt: Date.parse("2026-10-10T09:14:00Z"),
            fact: { _tag: "agent", agentId: "agent-pair-codex", host: "atlas", status: "gone" }
          }
        } satisfies WorkGoalObservedEntry :
        entry
    ) :
    observations.filter((entry) => entries.some((goal) => goal.id === entry.goalId))
  const window = (name: WorkSnapshot["window"]): WorkSnapshot => {
    let snapshot: WorkSnapshot = {
      window: name,
      observedAt: NOW,
      asOf: NOW - (name === "now" ? 0 : name === "day" ? DAY : name === "week" ? 7 * DAY : 30 * DAY),
      goals: entries
    }
    if (entries.length > 0 && state !== "3h-v2") {
      snapshot = {
        ...snapshot,
        goalsOmitted: state === "3d" ? 9 : state === "3h" ? 3 : state === "3g" ? 3 : state === "3o" ? 19 : 10
      }
    }
    if (entries.length > 0 && state !== "3h" && state !== "3h-v2" && state !== "3o") {
      snapshot = { ...snapshot, finishedOmitted: 9 }
    }
    if (state !== "3l" && name === "now") snapshot = { ...snapshot, observed }
    return snapshot
  }
  return { now: window("now"), day: window("day"), week: window("week"), month: window("month"), observedAt: NOW }
}
