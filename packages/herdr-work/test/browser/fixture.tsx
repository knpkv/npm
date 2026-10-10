/// <reference types="vite/client" />
import "@knpkv/rly/styles.css"
import "../../src/styles.css"
import { Schema } from "effect"
import { createRoot } from "react-dom/client"
import type { WorkGoal, WorkGoalObservedEntry, WorkPullRequestObservation, WorkSnapshot } from "../../src/model.js"
import { WorkSnapshots } from "../../src/model.js"
import { WorkBoard } from "../../src/view.js"
import { workFidelitySnapshots, workFidelityStates } from "./work-fidelity-fixture.js"

class MissingWorkFixtureRootError extends Schema.TaggedError<MissingWorkFixtureRootError>()(
  "MissingWorkFixtureRootError",
  { selector: Schema.String }
) {}

const goal = (index: number): WorkGoal => {
  const blocked = index % 2 === 0
  return {
    blocker: blocked ? { since: 1_000, summary: "Waiting for review" } : null,
    connectTarget: null,
    createdAt: 1_000,
    delivery: "local",
    detail: `Goal ${index} has one focused detail view instead of expanding the full board.`,
    id: `goal-${index}`,
    owner: { id: "owner-coordinator", name: "Coordinator" },
    repository: { branch: `fix/goal-${index}`, repository: "npm" },
    spend: null,
    state: blocked ? "blocked" : "working",
    summary: `Mobile regression fixture ${index}`,
    title: `Goal ${index}`,
    updatedAt: 1_000
  }
}

const searchParams = new URL(window.location.href).searchParams
const fidelityState = workFidelityStates.find((state) => state === searchParams.get("fidelity"))

// `?long` gives the first listed goal (goal-2, blocked) an unbroken branch and a long title, to prove they wrap inside the page.
const longNames = new URL(window.location.href).searchParams.has("long")
const named = (entry: WorkGoal): WorkGoal =>
  longNames && entry.id === "goal-2"
    ? {
        ...entry,
        repository: { branch: "feat/implementWorkCheckpointRecoveryAndReconciliation", repository: "npm" },
        title: "Work checkpoint recovery and reconciliation for the fleet coordinator"
      }
    : entry

const snapshot = (window: WorkSnapshot["window"]): WorkSnapshot => ({
  asOf: 1_000,
  goals: Array.from({ length: 47 }, (_, index) => named(goal(index + 1))),
  observedAt: 1_000,
  window
})

// `?observed` adds the reconciler's overlay to the live window: a merged and a closed pull request, a
// gone owner, an unreadable source, and some entries left out for the response budget.
const nothingObserved = { agent: null, pullRequest: null, stale: false, unknown: null }
const pullRequestFact = (state: "merged" | "closed", pullRequest: number): WorkPullRequestObservation => ({
  _tag: "pull_request",
  branch: `fix/goal-${pullRequest}`,
  checks: "passing",
  closedAt: 900,
  head: "a".repeat(40),
  pullRequest,
  repository: "knpkv/npm",
  review: "approved",
  state
})
const observedEntries: ReadonlyArray<WorkGoalObservedEntry> = [
  {
    ...nothingObserved,
    displayState: "completed",
    goalId: "goal-1",
    pullRequest: { confirmedAt: 950, fact: pullRequestFact("merged", 1), observedAt: 900 }
  },
  {
    ...nothingObserved,
    displayState: "abandoned",
    goalId: "goal-3",
    pullRequest: { confirmedAt: 950, fact: pullRequestFact("closed", 3), observedAt: 900 }
  },
  {
    ...nothingObserved,
    agent: {
      confirmedAt: 950,
      fact: { _tag: "agent", agentId: "agent-5", host: "SER8", status: "gone" },
      observedAt: 100
    },
    displayState: "working",
    goalId: "goal-5",
    stale: true
  },
  {
    ...nothingObserved,
    displayState: "working",
    goalId: "goal-7",
    unknown: { lastGoodAt: 600, reason: "GitHub rate limit", since: 800, source: "github" }
  }
]
const overlay = searchParams.has("observed") ? { observed: observedEntries, observedOmitted: 2 } : {}

const snapshots: typeof WorkSnapshots.Type = {
  day: snapshot("day"),
  month: snapshot("month"),
  now: { ...snapshot("now"), ...overlay },
  observedAt: 1_000,
  week: snapshot("week")
}

const rootElement = document.querySelector<HTMLElement>("#root")
if (rootElement === null) throw new MissingWorkFixtureRootError({ selector: "#root" })

const selectedGoalId = searchParams.get("goal")
const requestedWindow = searchParams.get("window")
const initialWindow: WorkSnapshot["window"] =
  fidelityState === "historical"
    ? "day"
    : requestedWindow === "day" || requestedWindow === "week" || requestedWindow === "month"
      ? requestedWindow
      : "now"
const navigation =
  searchParams.has("navigation") || fidelityState === "read-only"
    ? ({
        goalId,
        window: snapshotWindow
      }: {
        readonly goalId: string | null
        readonly window: WorkSnapshot["window"]
      }) => {
        const target = new URLSearchParams({ navigation: "", window: snapshotWindow })
        if (fidelityState !== undefined) target.set("fidelity", fidelityState)
        if (goalId !== null) target.set("goal", goalId)
        return `?${target.toString()}`
      }
    : undefined

const render = (boardSnapshots: typeof WorkSnapshots.Type) =>
  createRoot(rootElement).render(
    <WorkBoard
      externalLinks={fidelityState === "read-only" ? "disabled" : "enabled"}
      initialGoalId={selectedGoalId ?? (fidelityState === "detail" ? "usage" : null)}
      initialWindow={initialWindow}
      {...(navigation === undefined ? {} : { navigation })}
      snapshots={boardSnapshots}
    />
  )

// `?live` renders a real hub's snapshots (`fleetctl work snapshot`, saved locally as
// zz-live-work.json and never committed), decoded as the board's own input would be. Without the
// file the glob is empty and the fixture data renders.
const liveFiles = import.meta.glob<unknown>("./zz-live-work.json", { eager: true, import: "default" })
const live = Object.values(liveFiles)[0]
render(
  fidelityState === undefined
    ? searchParams.has("live") && live !== undefined
      ? Schema.decodeUnknownSync(WorkSnapshots)(live)
      : snapshots
    : workFidelitySnapshots(fidelityState)
)
