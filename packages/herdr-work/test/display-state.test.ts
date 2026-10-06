import { describe, expect, it } from "@effect/vitest"
import { displayStateOf, observedFor } from "../src/display-state.js"
import type { WorkGoal, WorkGoalObservedEntry, WorkSnapshot } from "../src/model.js"

const goal = (id: string): WorkGoal => ({
  blocker: null,
  connectTarget: null,
  createdAt: 0,
  delivery: "pull_request",
  detail: "Durable review checkpoint",
  id,
  owner: { id: "owner", name: "Owner" },
  repository: { branch: "feat/x", repository: "knpkv/npm" },
  spend: null,
  state: "review",
  summary: "Ship x",
  title: "Ship x",
  updatedAt: 10
})

const entry = (goalId: string): WorkGoalObservedEntry => ({
  agent: null,
  displayState: "completed",
  goalId,
  pullRequest: null,
  stale: false,
  unknown: null
})

const snapshot = (observed: ReadonlyArray<WorkGoalObservedEntry>): Pick<WorkSnapshot, "observed"> => ({ observed })
const withoutOverlay: Pick<WorkSnapshot, "observed"> = {}

describe("display state", () => {
  it("reads the overlay's display state for an observed goal", () => {
    const now = snapshot([entry("a")])
    expect(observedFor(now, "a")?.displayState).toBe("completed")
    expect(displayStateOf(now, goal("a"))).toBe("completed")
  })

  it("falls back to the goal's own state when the goal is unobserved or the overlay is absent", () => {
    expect(observedFor(snapshot([entry("a")]), "b")).toBeNull()
    expect(displayStateOf(snapshot([entry("a")]), goal("b"))).toBe("review")
    expect(displayStateOf(withoutOverlay, goal("a"))).toBe("review")
  })
})
