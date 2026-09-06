// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import type { WorkGoal, WorkSnapshot, WorkSnapshots } from "../src/model.js"
import { decodeWorkBoardNavigationGoal, encodeWorkBoardNavigationGoal, workNavigationHref } from "../src/navigation.js"
import { WorkBoard } from "../src/view.js"

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT: boolean
  }
}

window.IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<Root> = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount()
  })
  roots.length = 0
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
})

const goal = (index: number): WorkGoal => {
  const blocked = index % 2 === 0
  return {
    blocker: blocked ? { since: 1_000, summary: "Waiting for review" } : null,
    connectTarget: null,
    createdAt: 1_000,
    delivery: "local",
    detail: `Goal ${index} detail`,
    id: `goal-${index}`,
    owner: { id: "owner-coordinator", name: "Coordinator" },
    repository: { branch: `fix/goal-${index}`, repository: "npm" },
    spend: null,
    state: blocked ? "blocked" : "working",
    summary: `Goal ${index} summary`,
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

const mountBoard = async ({
  boardSnapshots = snapshots,
  initialGoalId,
  navigation
}: {
  readonly boardSnapshots?: WorkSnapshots
  readonly initialGoalId?: string
  readonly navigation?: (selection: {
    readonly goalId: string | null
    readonly window: WorkSnapshot["window"]
  }) => string
} = {}): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(<WorkBoard initialGoalId={initialGoalId} navigation={navigation} snapshots={boardSnapshots} />)
  )
  return host
}

const buttonNamed = (host: HTMLElement, name: string): HTMLButtonElement | null =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent?.trim() === name) ??
  null

const rowNamed = (host: HTMLElement, name: string): HTMLButtonElement | null =>
  [...host.querySelectorAll<HTMLButtonElement>(".work-board-row")].find(({ textContent }) =>
    textContent?.includes(name)
  ) ?? null

const linkNamed = (host: HTMLElement, name: string): HTMLAnchorElement | null =>
  [...host.querySelectorAll<HTMLAnchorElement>("a")].find(({ textContent }) => textContent?.trim() === name) ?? null

describe("WorkBoard interactions", () => {
  it("opens goal details only on selection and closes them explicitly", async () => {
    const host = await mountBoard()

    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()
    expect(host.querySelector('.work-board-row[aria-pressed="true"]')).toBeNull()
    expect(host.textContent).not.toContain("Shipment path")
    const goalRow = rowNamed(host, "Goal 2")
    expect(goalRow).not.toBeNull()
    if (goalRow === null) return

    await act(async () => goalRow.click())
    const details = host.querySelector<HTMLElement>('[aria-label="Goal details"]')
    expect(details?.textContent).toContain("Goal 2 detail")
    expect(host.textContent).toContain("Shipment path · Goal 2")
    expect(document.activeElement).toBe(details)

    const close = buttonNamed(host, "Close details")
    expect(close).not.toBeNull()
    if (close === null) return
    await act(async () => close.click())
    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()
    expect(document.activeElement).toBe(goalRow)
  })

  it("filters by status and reveals crowded results ten at a time", async () => {
    const host = await mountBoard()
    const blocked = buttonNamed(host, "Blocked")
    expect(blocked).not.toBeNull()
    if (blocked === null) return

    await act(async () => blocked.click())
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(10)
    expect(host.textContent).toContain("Showing 10 of 23 goals")

    const loadMore = buttonNamed(host, "Load 10 more")
    expect(loadMore).not.toBeNull()
    if (loadMore === null) return
    await act(async () => loadMore.click())
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(20)
    expect(host.textContent).toContain("Showing 20 of 23 goals")
  })

  it("resets the visible row count when time travel changes the snapshot", async () => {
    const host = await mountBoard()
    const loadMore = buttonNamed(host, "Load 10 more")
    expect(loadMore).not.toBeNull()
    if (loadMore === null) return
    await act(async () => loadMore.click())
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(20)

    const previousDay = buttonNamed(host, "24 hours ago")
    expect(previousDay).not.toBeNull()
    if (previousDay === null) return
    await act(async () => previousDay.click())
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(10)
    expect(host.textContent).toContain("Showing 10 of 47 goals")
  })

  it("closes stale details when time travel lacks the selected goal", async () => {
    const boardSnapshots: WorkSnapshots = {
      ...snapshots,
      day: { ...snapshots.day, goals: snapshots.day.goals.slice(0, 10) }
    }
    const host = await mountBoard({ boardSnapshots, initialGoalId: "goal-47" })
    expect(host.querySelector('[aria-label="Goal details"]')).not.toBeNull()

    const previousDay = buttonNamed(host, "24 hours ago")
    expect(previousDay).not.toBeNull()
    if (previousDay === null) return
    await act(async () => previousDay.click())
    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()

    const now = buttonNamed(host, "Now")
    expect(now).not.toBeNull()
    if (now === null) return
    await act(async () => now.click())
    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()
  })

  it("gives a deep-linked navigation row an explicit close route", async () => {
    const host = await mountBoard({
      initialGoalId: "goal-47",
      navigation: ({ goalId, window }) => `/?tab=work&window=${window}&goal=${goalId ?? ""}`
    })
    const selectedRow = host.querySelector<HTMLAnchorElement>('.work-board-row[aria-current="true"]')
    const close = linkNamed(host, "Close details")
    expect(selectedRow).not.toBeNull()
    expect(close).not.toBeNull()
    if (selectedRow === null || close === null) return

    expect(close.href).toContain("goal=__work_board_v1__")
    expect(close.hash).toBe("#work-selected-goal")
    expect(selectedRow.id).toBe("work-selected-goal")
  })

  it("focuses a static close target that mounts after fragment navigation", async () => {
    window.location.hash = "#work-selected-goal"
    const host = await mountBoard({
      initialGoalId: encodeWorkBoardNavigationGoal({
        detailsOpen: false,
        goalId: "goal-47",
        statusFilter: "all",
        visibleGoalCount: 10
      }),
      navigation: workNavigationHref
    })
    const selectedRow = host.querySelector<HTMLAnchorElement>('.work-board-row[aria-current="true"]')
    expect(selectedRow).not.toBeNull()
    expect(document.activeElement).toBe(selectedRow)
  })

  it("keeps filtered selection across static time-travel links", async () => {
    const host = await mountBoard({
      initialGoalId: encodeWorkBoardNavigationGoal({
        detailsOpen: true,
        goalId: "goal-46",
        statusFilter: "blocked",
        visibleGoalCount: 20
      }),
      navigation: workNavigationHref
    })
    const previousDay = linkNamed(host, "24 hours ago")
    expect(previousDay).not.toBeNull()
    if (previousDay === null) return

    const encoded = new URL(previousDay.href).searchParams.get("goal")
    expect(decodeWorkBoardNavigationGoal(encoded)).toEqual({
      detailsOpen: true,
      goalId: "goal-46",
      statusFilter: "blocked",
      visibleGoalCount: 10
    })
  })

  it("keeps the active filter in static goal-row links", async () => {
    const host = await mountBoard({
      initialGoalId: encodeWorkBoardNavigationGoal({
        detailsOpen: false,
        goalId: null,
        statusFilter: "blocked",
        visibleGoalCount: 10
      }),
      navigation: workNavigationHref
    })
    const row = host.querySelector<HTMLAnchorElement>(".work-board-row")
    expect(row).not.toBeNull()
    if (row === null) return

    const encoded = new URL(row.href).searchParams.get("goal")
    expect(decodeWorkBoardNavigationGoal(encoded)).toEqual({
      detailsOpen: true,
      goalId: "goal-2",
      statusFilter: "blocked",
      visibleGoalCount: 10
    })
  })

  it("caps static incremental reveal at the available goal count", async () => {
    const host = await mountBoard({
      initialGoalId: encodeWorkBoardNavigationGoal({
        detailsOpen: false,
        goalId: null,
        statusFilter: "all",
        visibleGoalCount: 40
      }),
      navigation: workNavigationHref
    })
    const loadMore = linkNamed(host, "Load 10 more")
    expect(loadMore).not.toBeNull()
    if (loadMore === null) return

    const encoded = new URL(loadMore.href).searchParams.get("goal")
    expect(decodeWorkBoardNavigationGoal(encoded)?.visibleGoalCount).toBe(47)
  })

  it("closes details when time travel moves the goal outside the active filter", async () => {
    const boardSnapshots: WorkSnapshots = {
      ...snapshots,
      day: {
        ...snapshots.day,
        goals: snapshots.day.goals.map((entry) => (entry.id === "goal-47" ? { ...entry, state: "blocked" } : entry))
      }
    }
    const host = await mountBoard({
      boardSnapshots,
      initialGoalId: encodeWorkBoardNavigationGoal({
        detailsOpen: true,
        goalId: "goal-47",
        statusFilter: "working",
        visibleGoalCount: 10
      })
    })
    expect(host.querySelector('[aria-label="Goal details"]')).not.toBeNull()

    const previousDay = buttonNamed(host, "24 hours ago")
    expect(previousDay).not.toBeNull()
    if (previousDay === null) return
    await act(async () => previousDay.click())
    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()
  })

  it("closes details when a live update moves the goal outside the active filter", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const initialGoalId = encodeWorkBoardNavigationGoal({
      detailsOpen: true,
      goalId: "goal-47",
      statusFilter: "working",
      visibleGoalCount: 40
    })
    await act(async () => root.render(<WorkBoard initialGoalId={initialGoalId} snapshots={snapshots} />))
    expect(host.querySelector('[aria-label="Goal details"]')).not.toBeNull()
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(24)

    const updatedSnapshots: WorkSnapshots = {
      ...snapshots,
      now: {
        ...snapshots.now,
        goals: snapshots.now.goals.map((entry) => (entry.id === "goal-47" ? { ...entry, state: "blocked" } : entry))
      }
    }
    await act(async () => root.render(<WorkBoard initialGoalId={initialGoalId} snapshots={updatedSnapshots} />))
    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(10)

    await act(async () => root.render(<WorkBoard initialGoalId={initialGoalId} snapshots={snapshots} />))
    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()
    expect(host.querySelector('.work-board-row[aria-pressed="true"]')).toBeNull()
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(10)

    const all = buttonNamed(host, "All")
    expect(all).not.toBeNull()
    if (all === null) return
    await act(async () => all.click())
    expect(host.querySelector('[aria-label="Goal details"]')).toBeNull()
    expect(host.querySelector('.work-board-row[aria-pressed="true"]')).toBeNull()
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(10)
  })

  it("names an empty status result", async () => {
    const host = await mountBoard()
    const planned = buttonNamed(host, "Planned")
    expect(planned).not.toBeNull()
    if (planned === null) return

    await act(async () => planned.click())
    expect(host.querySelectorAll(".work-board-row")).toHaveLength(0)
    expect(host.textContent).toContain("No goals match this status")
  })
})
