import { describe, expect, it } from "vitest"
import type { WorkGoal, WorkRequest } from "../src/model.js"
import {
  workTriage,
  workTriageDoneWindowMs,
  workTriageGroupTitle,
  workTriageSentence,
  workTriageSentenceParts,
  workTriageStuckAfterMs,
  type WorkTriageSummary
} from "../src/work-triage.js"

const AS_OF = 10 * 86_400_000

const goal = (id: string, overrides: Partial<WorkGoal> = {}): WorkGoal => ({
  blocker: null,
  connectTarget: null,
  createdAt: AS_OF - 86_400_000,
  delivery: "local",
  detail: `${id} detail`,
  id,
  owner: { id: "owner-1", name: "ui2-a" },
  repository: { branch: `fix/${id}`, repository: "knpkv/npm" },
  spend: null,
  state: "working",
  summary: `${id} summary`,
  title: `Goal ${id}`,
  updatedAt: AS_OF - 3_600_000,
  ...overrides
})

const request = (id: string, requestedAt: number, state: WorkRequest["state"] = "open"): WorkRequest => ({
  approvalTarget: null,
  id,
  requestedAt,
  state,
  summary: `Request ${id}`
})

const blocked = (id: string, updatedAt = AS_OF - 3_600_000) =>
  goal(id, { blocker: { since: updatedAt, summary: "Port 41751 busy" }, state: "blocked", updatedAt })

const groupsOf = (goals: ReadonlyArray<WorkGoal>) =>
  workTriage({ asOf: AS_OF, goals }).rows.map((row) => [row.goal.id, row.group])

describe("workTriage", () => {
  it("puts goals with an open request first, oldest request first, whatever their state", () => {
    const rows = groupsOf([
      goal("moving"),
      goal("late", { requests: [request("r2", AS_OF - 60_000)], updatedAt: AS_OF - 60_000 }),
      blocked("stuck"),
      goal("early", { requests: [request("r1", AS_OF - 600_000)], state: "review", updatedAt: AS_OF - 600_000 })
    ])
    expect(rows).toEqual([["early", "needs-you"], ["late", "needs-you"], ["stuck", "blocked"], ["moving", "moving"]])
  })

  it("does not count decided requests as needing the viewer", () => {
    const rows = groupsOf([
      goal("approved", { requests: [request("r1", AS_OF - 600_000, "approved")] }),
      goal("rejected", { requests: [request("r2", AS_OF - 600_000, "rejected")] })
    ])
    expect(rows.map(([, group]) => group)).toEqual(["moving", "moving"])
  })

  it("keeps finished goals only for 24 hours after their last update, inclusive", () => {
    const rows = groupsOf([
      goal("edge", { delivery: "merged", state: "completed", updatedAt: AS_OF - workTriageDoneWindowMs }),
      goal("old", { delivery: "merged", state: "completed", updatedAt: AS_OF - workTriageDoneWindowMs - 1 }),
      goal("shipped", { delivery: "deployed", state: "deployed", updatedAt: AS_OF - 60_000 })
    ])
    expect(rows).toEqual([["shipped", "done"], ["edge", "done"], ["old", "earlier"]])
  })

  it("lists planned goals as not started, after moving work, and never counts them as moving", () => {
    const triage = workTriage({ asOf: AS_OF, goals: [goal("idea", { state: "planned" }), goal("active")] })
    expect(triage.rows.map(({ goal: { id }, group }) => [id, group])).toEqual([["active", "moving"], [
      "idea",
      "planned"
    ]])
    expect(triage.summary).toMatchObject({ _tag: "Clear", moving: 1 })
    expect(workTriageGroupTitle.planned).toBe("Not started")
  })

  it("treats an abandoned goal as finished", () => {
    const rows = groupsOf([
      goal("dropped", { state: "abandoned", updatedAt: AS_OF - 60_000 }),
      goal("dropped-long-ago", { state: "abandoned", updatedAt: AS_OF - workTriageDoneWindowMs - 1 })
    ])
    expect(rows).toEqual([["dropped", "done"], ["dropped-long-ago", "earlier"]])
  })

  it("orders within a group by most recent update, then keeps the snapshot's order", () => {
    const rows = groupsOf([
      goal("goal-2", { updatedAt: AS_OF - 1_000 }),
      goal("goal-10", { updatedAt: AS_OF - 1_000 }),
      goal("newest", { updatedAt: AS_OF - 10 })
    ])
    expect(rows.map(([id]) => id)).toEqual(["newest", "goal-2", "goal-10"])
  })
})

/**
 * A goal waiting in review or blocked with no update for three days is stuck: nobody is moving it,
 * so it leads the tab instead of hiding among moving work. 36 review goals sat 8 to 10 days in the
 * fleet's own data while the tab said nothing needed attention.
 */
describe("workTriage stuck", () => {
  const STUCK = workTriageStuckAfterMs

  it("counts review and blocked goals as stuck from exactly three days without an update", () => {
    const rows = groupsOf([
      goal("review-edge", { state: "review", updatedAt: AS_OF - STUCK }),
      goal("review-fresh", { state: "review", updatedAt: AS_OF - STUCK + 1 }),
      blocked("blocked-edge", AS_OF - STUCK),
      blocked("blocked-fresh", AS_OF - STUCK + 1),
      goal("working-old", { state: "working", updatedAt: AS_OF - STUCK - 1 }),
      goal("planned-old", { state: "planned", updatedAt: AS_OF - STUCK - 1 })
    ])
    expect(rows).toEqual([
      ["review-edge", "stuck"],
      ["blocked-edge", "stuck"],
      ["blocked-fresh", "blocked"],
      ["review-fresh", "moving"],
      ["working-old", "moving"],
      ["planned-old", "planned"]
    ])
  })

  it("lists stuck goals after the ones that need the viewer, oldest update first", () => {
    const rows = groupsOf([
      goal("newer", { state: "review", updatedAt: AS_OF - STUCK - 1_000 }),
      goal("asks", { requests: [request("r1", AS_OF - 60_000)], state: "review", updatedAt: AS_OF - 9 * STUCK }),
      goal("oldest", { state: "review", updatedAt: AS_OF - 3 * STUCK })
    ])
    expect(rows).toEqual([["asks", "needs-you"], ["oldest", "stuck"], ["newer", "stuck"]])
  })

  it("follows the displayed state, so a merged pull request is never stuck", () => {
    const old = goal("merged", { state: "review", updatedAt: AS_OF - 2 * STUCK })
    const triage = workTriage({
      asOf: AS_OF,
      goals: [old],
      observed: [{
        agent: null,
        displayState: "completed",
        goalId: "merged",
        pullRequest: null,
        stale: false,
        unknown: null
      }]
    })
    expect(triage.rows.map((row) => row.group)).toEqual(["earlier"])
  })

  it("names stuck goals in the summary sentence", () => {
    const triage = workTriage({
      asOf: AS_OF,
      goals: [goal("a", { state: "review", updatedAt: AS_OF - STUCK }), goal("b", { state: "review", updatedAt: 0 })]
    })
    expect(triage.summary).toMatchObject({ _tag: "Attention", blocked: 0, needsYou: 0, stuck: 2 })
    expect(workTriageSentence(triage.summary)).toBe("Nothing needs you, 2 stuck")
    expect(workTriageSentence({ _tag: "Attention", blocked: 1, needsYou: 2, oldestRequest: null, stuck: 1 })).toBe(
      "2 goals need you, 1 blocked, 1 stuck"
    )
    expect(workTriageGroupTitle.stuck).toBe("Stuck")
  })
})

describe("workTriage summary", () => {
  it("states needs-you and blocked counts and names the request waiting longest", () => {
    const early = goal("early", { requests: [request("r1", AS_OF - 600_000), request("r0", AS_OF - 900_000)] })
    const triage = workTriage({ asOf: AS_OF, goals: [early, blocked("stuck"), blocked("stuck-2"), goal("moving")] })
    expect(triage.summary).toEqual({
      _tag: "Attention",
      blocked: 2,
      needsYou: 1,
      oldestRequest: { goal: early, request: request("r0", AS_OF - 900_000) },
      stuck: 0
    })
    expect(workTriageSentence(triage.summary)).toBe("1 goal needs you, 2 blocked")
  })

  it("still leads with blocked goals when nothing needs the viewer", () => {
    const triage = workTriage({ asOf: AS_OF, goals: [blocked("stuck")] })
    expect(triage.summary).toMatchObject({ _tag: "Attention", needsYou: 0, oldestRequest: null })
    expect(workTriageSentence(triage.summary)).toBe("Nothing needs you, 1 blocked")
  })

  it("is clear, naming the latest update, when nothing needs the viewer and nothing is blocked", () => {
    const latest = goal("latest", { updatedAt: AS_OF - 10 })
    const triage = workTriage({ asOf: AS_OF, goals: [goal("older"), latest] })
    expect(triage.summary).toEqual({ _tag: "Clear", latest, moving: 2 })
    expect(workTriageSentence(triage.summary)).toBe("Nothing needs you")
  })

  it("is empty only when there are no goals; old finished goals still count as clear", () => {
    const old = goal("old", { state: "completed", updatedAt: AS_OF - 3 * workTriageDoneWindowMs })
    expect(workTriage({ asOf: AS_OF, goals: [] }).summary).toEqual({ _tag: "Empty" })
    expect(workTriage({ asOf: AS_OF, goals: [old] }).summary).toEqual({ _tag: "Clear", latest: old, moving: 0 })
    expect(workTriageSentence({ _tag: "Empty" })).toBe("No goals yet")
  })

  it("labels the finished group honestly as the last 24 hours, not as done", () => {
    expect(workTriageGroupTitle.done).toBe("Finished in the last 24 hours")
  })

  it("speaks of a historical window in the past tense", () => {
    expect(workTriageSentence({ _tag: "Attention", blocked: 2, needsYou: 3, oldestRequest: null, stuck: 0 }, "past"))
      .toBe(
        "3 goals needed you, 2 blocked"
      )
    expect(workTriageSentence({ _tag: "Attention", blocked: 1, needsYou: 0, oldestRequest: null, stuck: 0 }, "past"))
      .toBe(
        "Nothing needed you, 1 blocked"
      )
    expect(workTriageSentence({ _tag: "Clear", latest: null, moving: 0 }, "past")).toBe("Nothing needed you")
    expect(workTriageSentence({ _tag: "Empty" }, "past")).toBe("No goals")
  })

  it("leaves the blocked count out when nothing is blocked", () => {
    expect(workTriageSentence({ _tag: "Attention", blocked: 0, needsYou: 2, oldestRequest: null, stuck: 0 })).toBe(
      "2 goals need you"
    )
  })
})

describe("workTriageSentenceParts", () => {
  it("gives the lead and each named count with its ink, and joins to the sentence", () => {
    const summary: WorkTriageSummary = { _tag: "Attention", blocked: 1, needsYou: 0, oldestRequest: null, stuck: 2 }
    expect(workTriageSentenceParts(summary)).toEqual({
      counts: [{ tone: "blocked", word: "1 blocked" }, { tone: "held", word: "2 stuck" }],
      lead: "Nothing needs you"
    })
    expect(workTriageSentence(summary)).toBe("Nothing needs you, 1 blocked, 2 stuck")
    expect(workTriageSentenceParts({ _tag: "Empty" }, "past")).toEqual({ counts: [], lead: "No goals" })
  })
})
