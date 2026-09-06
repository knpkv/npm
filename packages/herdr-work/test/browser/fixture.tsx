import "@knpkv/rly/styles.css"
import "../../src/styles.css"
import { Schema } from "effect"
import { createRoot } from "react-dom/client"
import type { WorkGoal, WorkSnapshot, WorkSnapshots } from "../../src/model.js"
import { WorkBoard } from "../../src/view.js"

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

const snapshot = (window: WorkSnapshot["window"]): WorkSnapshot => ({
  asOf: 1_000,
  goals: Array.from({ length: 47 }, (_, index) => goal(index + 1)),
  observedAt: 1_000,
  window
})

const snapshots: WorkSnapshots = {
  day: snapshot("day"),
  month: snapshot("month"),
  now: snapshot("now"),
  observedAt: 1_000,
  week: snapshot("week")
}

const rootElement = document.querySelector<HTMLElement>("#root")
if (rootElement === null) throw new MissingWorkFixtureRootError({ selector: "#root" })

const selectedGoalId = new URL(window.location.href).searchParams.get("goal")
createRoot(rootElement).render(<WorkBoard initialGoalId={selectedGoalId} snapshots={snapshots} />)
