// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import type {
  WorkGoal,
  WorkGoalObservedEntry,
  WorkPullRequestObservation,
  WorkSnapshot,
  WorkSnapshots
} from "../src/model.js"
import { encodeWorkBoardNavigationGoal } from "../src/navigation.js"
import { WorkBoard } from "../src/view.js"
import { workTriage } from "../src/work-triage.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT: boolean
  }
}

window.IS_REACT_ACT_ENVIRONMENT = true

const NOW = 10 * 86_400_000
const HOUR = 3_600_000

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
})

const goal = (id: string, overrides: Partial<WorkGoal> = {}): WorkGoal => ({
  blocker: null,
  connectTarget: null,
  createdAt: NOW - 48 * HOUR,
  delivery: "pull_request",
  detail: `${id} detail`,
  id,
  owner: { id: "owner-1", name: "ui2-b" },
  repository: { branch: `feat/${id}`, repository: "npm" },
  spend: null,
  state: "working",
  summary: `${id} summary`,
  title: `Goal ${id}`,
  updatedAt: NOW - 30 * HOUR,
  ...overrides
})

const nothing = { agent: null, pullRequest: null, stale: false, unknown: null }

const merged = (goalId: string, closedAt: number): WorkGoalObservedEntry => ({
  ...nothing,
  displayState: "completed",
  goalId,
  pullRequest: {
    confirmedAt: NOW - HOUR,
    fact: {
      _tag: "pull_request",
      branch: `feat/${goalId}`,
      checks: "passing",
      closedAt,
      head: "a".repeat(40),
      pullRequest: 42,
      repository: "knpkv/npm",
      review: "approved",
      state: "merged"
    },
    observedAt: closedAt
  }
})

const snapshotOf = (
  goals: ReadonlyArray<WorkGoal>,
  overlay: Pick<WorkSnapshot, "activityOmitted" | "finishedOmitted" | "goalsOmitted" | "observed" | "observedOmitted">
): WorkSnapshots => {
  const window = (name: WorkSnapshot["window"]): WorkSnapshot => ({ asOf: NOW, goals, observedAt: NOW, window: name })
  return {
    day: window("day"),
    month: window("month"),
    now: { ...window("now"), ...overlay },
    observedAt: NOW,
    week: window("week")
  }
}

const mount = async (snapshots: WorkSnapshots, initialGoalId?: string): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<WorkBoard initialGoalId={initialGoalId ?? null} snapshots={snapshots} />))
  return host
}

describe("Work triage with the observed overlay", () => {
  it("groups by the observed state and dates done from the pull request's close", () => {
    const rows = workTriage({
      asOf: NOW,
      goals: [goal("merged"), goal("closed"), goal("stuck"), goal("plain")],
      observed: [
        merged("merged", NOW - 2 * HOUR),
        { ...nothing, displayState: "abandoned", goalId: "closed" },
        { ...nothing, displayState: "blocked", goalId: "stuck" }
      ]
    }).rows.map(({ displayState, goal: { id }, group }) => [id, displayState, group])
    expect(rows).toEqual([
      ["stuck", "blocked", "blocked"],
      ["plain", "working", "moving"],
      ["merged", "completed", "done"],
      // Abandoned with no close time: its last update (30h ago) is outside the done window.
      ["closed", "abandoned", "earlier"]
    ])
  })
})

describe("Work board with the observed overlay", () => {
  it("shows four goal steps, using merge evidence and Done for completed non-PR work", async () => {
    const host = await mount(
      snapshotOf(
        [
          goal("planned", { delivery: "local", state: "planned" }),
          goal("working", { delivery: "local" }),
          goal("review", { state: "review" }),
          goal("merged"),
          goal("done", { delivery: "local", state: "completed" }),
          goal("closed", { state: "abandoned" }),
          goal("stopped-local", { delivery: "local", state: "abandoned" }),
          goal("recorded-merge", { delivery: "merged", state: "completed" }),
          goal("completed-pr", { state: "completed" })
        ],
        { observed: [merged("merged", NOW - 2 * HOUR)] }
      )
    )
    const progress = (id: string) =>
      [...host.querySelectorAll(".work-goal-card")]
        .find((card) => card.querySelector(".work-board-row")?.textContent?.includes(`Goal ${id}`))
        ?.querySelector(".work-row-progress")
    expect([...(progress("planned")?.querySelectorAll("li") ?? [])].map(({ textContent }) => textContent)).toEqual([
      "Planned",
      "In progress",
      "In review",
      "Done"
    ])
    for (const [id, current] of [
      ["planned", "Planned"],
      ["working", "In progress"],
      ["review", "In review"],
      ["merged", "Merged"],
      ["done", "Done"],
      ["recorded-merge", "Merged"],
      ["completed-pr", "In review"]
    ] satisfies ReadonlyArray<readonly [string, string]>) {
      expect(progress(id)?.querySelector('[aria-current="step"]')?.textContent).toBe(current)
    }
    expect(progress("closed")?.querySelector('[aria-current="step"]')).toBeNull()
    expect(progress("closed")?.querySelector('[data-stopped="true"]')?.getAttribute("aria-label")).toBe(
      "In review, abandoned here"
    )
    expect(progress("closed")?.querySelector('[data-stopped="true"]')?.getAttribute("data-reached")).toBe("false")
    expect(progress("closed")?.querySelector("li:last-child")?.getAttribute("data-reached")).toBe("false")
    expect(progress("stopped-local")?.querySelector('[aria-current="step"]')).toBeNull()
    expect(progress("stopped-local")?.querySelector('[data-stopped="true"]')?.getAttribute("aria-label")).toBe(
      "In progress, abandoned here"
    )
  })

  it("shows CI and review facts with their confirmation time, and Unknown without observations", async () => {
    const read = merged("read", NOW - 2 * HOUR)
    const host = await mount(
      snapshotOf(
        [
          goal("read"),
          goal("unread", {
            review: { state: "approved", summary: null, updatedAt: NOW, url: null }
          })
        ],
        { observed: [read] }
      )
    )
    const evidence = (id: string) =>
      [...host.querySelectorAll(".work-goal-card")]
        .find((card) => card.querySelector(".work-board-row")?.textContent?.includes(`Goal ${id}`))
        ?.querySelector(".work-row-evidence")
    expect(evidence("read")?.textContent).toContain("CI Passing")
    expect(evidence("read")?.textContent).toContain("Review Approved")
    expect(evidence("read")?.querySelector("time")?.getAttribute("datetime")).toBe(new Date(NOW - HOUR).toISOString())
    expect(evidence("unread")?.textContent).toContain("CI Unknown")
    expect(evidence("unread")?.textContent).toContain("Review Unknown")
    expect(evidence("unread")?.textContent).toContain("Not read")
    expect(evidence("unread")?.querySelector("time")).toBeNull()
  })

  it("counts retained finished goals and both distinct omission sources, regardless of the active filter", async () => {
    const host = await mount(
      snapshotOf(
        [
          goal("working"),
          goal("done", { state: "completed" }),
          goal("abandoned", { state: "abandoned" }),
          goal("merged")
        ],
        { finishedOmitted: 5, goalsOmitted: 12, observed: [merged("merged", NOW - 2 * HOUR)] }
      )
    )
    expect(host.querySelector(".work-finished-count")?.textContent).toBe(
      "3 finished goals · 5 older not shown · 12 more not in this read"
    )
    const working = [...host.querySelectorAll<HTMLButtonElement>(".work-status-filter")].find(
      ({ textContent }) => textContent === "Working"
    )
    await act(async () => working?.click())
    expect(host.querySelector(".work-finished-count")?.textContent).toBe(
      "3 finished goals · 5 older not shown · 12 more not in this read"
    )
  })

  it("keeps non-PR work quiet and hides zero omission counts", async () => {
    const host = await mount(
      snapshotOf([goal("local", { delivery: "local" })], { observed: [], finishedOmitted: 0, goalsOmitted: 0 })
    )
    expect(host.querySelector(".work-row-evidence")).toBeNull()
    expect(host.querySelector(".work-finished-count")?.textContent).toBe("0 finished goals")
  })

  it("keeps observed CI and review words in their shared tones, including an unreadable source's last read", async () => {
    const cases: ReadonlyArray<{
      readonly checks: WorkPullRequestObservation["checks"]
      readonly review: WorkPullRequestObservation["review"]
      readonly ciWord: string
      readonly reviewWord: string
      readonly ciTone: string
      readonly reviewTone: string
    }> = [
      {
        checks: "none",
        review: "not_requested",
        ciWord: "No checks",
        reviewWord: "Not requested",
        ciTone: "neutral",
        reviewTone: "neutral"
      },
      {
        checks: "pending",
        review: "requested",
        ciWord: "Running",
        reviewWord: "Requested",
        ciTone: "progress",
        reviewTone: "caution"
      },
      {
        checks: "failing",
        review: "changes_requested",
        ciWord: "Failing",
        reviewWord: "Changes requested",
        ciTone: "critical",
        reviewTone: "critical"
      },
      {
        checks: "passing",
        review: "approved",
        ciWord: "Passing",
        reviewWord: "Approved",
        ciTone: "positive",
        reviewTone: "positive"
      }
    ]
    for (const entry of cases) {
      const observed: WorkGoalObservedEntry = {
        ...nothing,
        displayState: "review",
        goalId: "g1",
        pullRequest: {
          confirmedAt: NOW - HOUR,
          observedAt: NOW - 2 * HOUR,
          fact: {
            _tag: "pull_request",
            branch: "feat/g1",
            checks: entry.checks,
            closedAt: null,
            head: "a".repeat(40),
            pullRequest: 42,
            repository: "knpkv/npm",
            review: entry.review,
            state: "open"
          }
        },
        unknown: { lastGoodAt: NOW - HOUR, reason: "rate limited", since: NOW, source: "github" }
      }
      const host = await mount(snapshotOf([goal("g1")], { observed: [observed] }))
      const evidence = host.querySelector(".work-row-evidence")
      expect(evidence?.querySelector(".work-ci-fact")?.textContent).toBe(`CI ${entry.ciWord}`)
      expect(evidence?.querySelector(".work-ci-fact")?.className).toContain(entry.ciTone)
      expect(evidence?.querySelector(".work-review-fact")?.textContent).toBe(`Review ${entry.reviewWord}`)
      expect(evidence?.querySelector(".work-review-fact")?.className).toContain(entry.reviewTone)
      expect(evidence?.textContent).toContain("Last read")
      expect(evidence?.querySelector("time")?.getAttribute("datetime")).toBe(new Date(NOW - HOUR).toISOString())
    }
  })

  it("says when live state is missing or trimmed, and only on the live window", async () => {
    expect((await mount(snapshotOf([goal("g1")], {}))).textContent).toContain(
      "Live state not available: this hub sends no observed facts"
    )
    expect((await mount(snapshotOf([goal("g1")], { observed: [] }))).textContent).not.toContain("Live state")
    expect((await mount(snapshotOf([goal("g1")], { observed: [], observedOmitted: 3 }))).textContent).toContain(
      "Live state shown for the most recently updated goals; 3 left out."
    )
  })

  it("says how many older goals a large board left out, so a goal leaving the view is never silent", async () => {
    expect((await mount(snapshotOf([goal("g1")], { goalsOmitted: 12, observed: [] }))).textContent).toContain(
      "12 more goals not in this read."
    )
    expect((await mount(snapshotOf([goal("g1")], { goalsOmitted: 1, observed: [] }))).textContent).toContain(
      "1 more goal not in this read."
    )
    expect(
      (await mount(snapshotOf([goal("g1")], { observed: [] }))).querySelector(".work-page-intro")?.textContent
    ).not.toContain("not shown")
  })

  it("reads as whole sentences when live state and a cut board are both reported", async () => {
    for (const overlay of [{ goalsOmitted: 12, observed: [], observedOmitted: 3 }, { goalsOmitted: 12 }]) {
      const header =
        (await mount(snapshotOf([goal("g1")], overlay))).querySelector(".work-page-intro")?.textContent ?? ""
      expect(header).toContain("12 more goals not in this read.")
      expect(header).not.toContain("..")
    }
  })

  it("says how many finished goals left the window, and how much older activity a goal's timeline leaves out", async () => {
    expect((await mount(snapshotOf([goal("g1")], { finishedOmitted: 5, observed: [] }))).textContent).toContain(
      "5 finished goals not shown."
    )
    const withActivity: WorkGoal = {
      ...goal("g1"),
      activity: [{ id: "a1", kind: "note", occurredAt: NOW - HOUR, summary: "Latest note" }]
    }
    const host = await mount(snapshotOf([withActivity], { activityOmitted: { g1: 11 }, observed: [] }), "g1")
    expect(host.textContent).toContain("1 most recent of 12")
  })

  it("shows the observed state on the row and names the recorded one in the detail", async () => {
    const host = await mount(snapshotOf([goal("g1")], { observed: [merged("g1", NOW - 2 * HOUR)] }), "g1")
    expect(host.querySelector(".work-board-row .work-row-state")?.textContent).toBe("Completed")
    expect(host.querySelector(".work-facts")?.textContent).toContain("Observed; recorded as working")
    expect(host.querySelector(".work-facts")?.textContent).toContain("#42 merged, checks passing")
    const event = [...host.querySelectorAll(".work-activity li")].find(({ textContent }) =>
      textContent?.includes("Pull request #42 merged")
    )
    expect(event?.querySelector("[data-rly-timeline-provenance='auto']")).not.toBeNull()
    expect(event?.textContent).toContain("Observed on GitHub")
  })

  it("says no pull request is known when the overlay has none for the goal", async () => {
    const host = await mount(snapshotOf([goal("g1")], { observed: [] }), "g1")
    expect(host.querySelector(".work-facts")?.textContent).toContain("Pull requestNone known")
  })

  it("says a pull request is not in this read only for a goal the trimmed overlay left out", async () => {
    const agentOnly: WorkGoalObservedEntry = { ...nothing, displayState: "working", goalId: "kept" }
    const host = await mount(
      snapshotOf([goal("kept"), goal("left")], { observed: [agentOnly], observedOmitted: 1 }),
      "kept"
    )
    expect(host.querySelector(".work-facts")?.textContent).toContain("Pull requestNone known")
    const trimmed = await mount(
      snapshotOf([goal("kept"), goal("left")], { observed: [agentOnly], observedOmitted: 1 }),
      "left"
    )
    expect(trimmed.querySelector(".work-facts")?.textContent).toContain("Not in this read")
  })

  it("flags a gone owner and an unreadable source, drawing the unreadable one hatched", async () => {
    const entry: WorkGoalObservedEntry = {
      ...nothing,
      agent: {
        confirmedAt: NOW - HOUR,
        fact: { _tag: "agent", agentId: "agent-1", host: "SER8", status: "gone" },
        observedAt: NOW - 30 * HOUR
      },
      displayState: "working",
      goalId: "g1",
      stale: true,
      unknown: { lastGoodAt: null, reason: "rate limited", since: NOW - 2 * HOUR, source: "github" }
    }
    const host = await mount(snapshotOf([goal("g1")], { observed: [entry] }), "g1")
    const notes = [...host.querySelectorAll(".work-note")].map(({ textContent }) => textContent)
    expect(notes.some((text) => text?.startsWith("Owner gone since"))).toBe(true)
    expect(notes.some((text) => text?.includes("Couldn't read GitHub") && text.includes("never been read"))).toBe(true)
    expect(host.querySelector(".work-row-caption")?.textContent).toMatch(/^Owner gone since/)
    expect(host.querySelector("[data-rly-timeline-provenance='unknown']")).not.toBeNull()
  })

  it("restores a link whose filter is the observed state the row showed", async () => {
    const link = encodeWorkBoardNavigationGoal({
      detailsOpen: true,
      goalId: "g1",
      statusFilter: "completed",
      visibleGoalCount: 10
    })
    const host = await mount(snapshotOf([goal("g1"), goal("g2")], { observed: [merged("g1", NOW - 2 * HOUR)] }), link)
    expect(host.querySelector(".work-facts")?.textContent).toContain("#42 merged, checks passing")
    expect([...host.querySelectorAll(".work-board-row")]).toHaveLength(1)
  })

  it("filters by the state each row shows", async () => {
    const host = await mount(snapshotOf([goal("g1"), goal("g2")], { observed: [merged("g1", NOW - 2 * HOUR)] }))
    const completed = [...host.querySelectorAll<HTMLButtonElement>(".work-status-filter")].find(
      ({ textContent }) => textContent === "Completed"
    )
    await act(async () => completed?.click())
    const titles = [...host.querySelectorAll(".work-board-row")].map(({ textContent }) => textContent)
    expect(titles).toHaveLength(1)
    expect(titles[0]).toContain("Goal g1")
  })
})
