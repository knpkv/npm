import { expect, it } from "@effect/vitest"
import { AtomRegistry } from "effect/unstable/reactivity"
import { makeWeekAtoms, previewWrite, type QueuedConfirmation, settleEntries } from "../src/client/weekAtoms.js"
import type { WeekPlanResponse } from "../src/shared/contracts.js"
import { fixtureWeek } from "./fixture.js"

// Invalid selections and unavailable targets cannot produce apparently writable preview intervals.
it("does not preview a refused selection, amount or provider scope", () => {
  const plan = fixtureWeek()
  for (
    const request of [
      { blocks: [] },
      { blocks: [9] },
      { blocks: [1], seconds: 3601 },
      { seconds: 59 },
      { targets: { clockify: false, jira: false } }
    ]
  ) {
    expect(previewWrite({ plan, entries: [] }, {
      kind: "confirm",
      request: { planId: plan.planId, rowId: "row-one", ...request }
    })).toEqual([])
  }
})

// Previously held morning time must not shift a specifically selected afternoon block.
it("previews the selected block at its own start and preserves an edited duration", () => {
  const plan = fixtureWeek()
  const entries = previewWrite({ plan, entries: [] }, {
    kind: "confirm",
    request: {
      planId: plan.planId,
      rowId: "row-one",
      blocks: [1],
      seconds: 2400,
      targets: { jira: false, clockify: true }
    }
  })
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    source: "clockify",
    pending: true,
    startMs: new Date(`${plan.monday}T14:00:00`).getTime(),
    endMs: new Date(`${plan.monday}T14:40:00`).getTime()
  })
})

it("uses projected per-provider consumption for optimistic corrected-ticket intervals", () => {
  const original = fixtureWeek()
  const plan = {
    ...original,
    rows: original.rows.map((row) => ({
      ...row,
      proposal: row.proposal === undefined ? undefined : {
        ...row.proposal,
        blocks: row.proposal.blocks.map((block, index) => ({
          ...block,
          consumed: index === 0 ? { clockify: 1800, jira: 0 } : block.consumed
        }))
      }
    }))
  }
  const entries = previewWrite({ plan, entries: [] }, {
    kind: "confirm",
    request: { planId: plan.planId, rowId: "row-one", blocks: [0] }
  })
  const startMs = new Date(`${plan.monday}T11:00:00`).getTime()
  expect(entries.filter((entry) => entry.source === "clockify").map(({ endMs, startMs }) => ({ startMs, endMs })))
    .toEqual([{ startMs: startMs + 1800000, endMs: startMs + 3600000 }])
  expect(entries.filter((entry) => entry.source === "jira").map(({ endMs, startMs }) => ({ startMs, endMs })))
    .toEqual([{ startMs, endMs: startMs + 3600000 }])
})

// An overridden ticket uses that ticket's saved totals, including asymmetric provider room.
it("sizes each preview against the overridden ticket bucket", () => {
  const original = fixtureWeek()
  const plan = {
    ...original,
    rows: [...original.rows, {
      ...original.rows[0]!,
      rowId: "target",
      ticketKey: "PROJ-999",
      jiraSeconds: 7200,
      clockifySeconds: 6300
    }]
  }
  const entries = previewWrite({ plan, entries: [] }, {
    kind: "confirm",
    request: {
      planId: plan.planId,
      rowId: "row-one",
      blocks: [0],
      ticketKey: "PROJ-999"
    }
  })
  expect(entries).toHaveLength(1)
  expect(entries[0]?.source).toBe("clockify")
  expect(entries[0]?.ticketKey).toBe("PROJ-999")
  expect(entries[0]!.endMs - entries[0]!.startMs).toBe(900000)
})

// The returned provider amount supersedes a preview made before the server's live recheck.
it("settles complete and partial successes with their actual duration", () => {
  const entries = previewWrite({ plan: null, entries: [] }, {
    kind: "manual",
    request: {
      day: "2026-09-07",
      startClock: "09:00",
      ticketKey: "PROJ-123",
      seconds: 3600
    }
  })
  const settled = settleEntries(entries, {
    clockify: {
      _tag: "PartiallyWritten",
      seconds: 1800,
      failure: { _tag: "Refused", message: "Second segment unavailable" }
    },
    jira: { _tag: "Refused", message: "Unavailable" },
    description: "Saved note",
    lines: []
  })
  expect(settled).toHaveLength(1)
  expect(settled[0]).toMatchObject({ source: "clockify", pending: false, description: "Saved note" })
  expect(settled[0]!.endMs - settled[0]!.startMs).toBe(1800000)
})

it("previews and settles disjoint provider gaps as separate intervals", () => {
  const original = fixtureWeek()
  const row = original.rows[0]!
  const startMs = new Date(`${original.monday}T10:00:00`).getTime()
  const intervals: WeekPlanResponse["rows"][number]["intervals"] = [
    { source: "clockify", startMs: startMs + 3600000, endMs: startMs + 7200000 },
    { source: "jira", startMs: startMs + 3600000, endMs: startMs + 7200000 }
  ]
  const plan = {
    ...original,
    rows: [{
      ...row,
      clockifySeconds: 3600,
      jiraSeconds: 3600,
      intervals,
      proposal: {
        ...row.proposal!,
        blocks: [{ startMs, endMs: startMs + 10800000, seconds: 10800, consumed: { clockify: 0, jira: 0 } }],
        maxSeconds: 10800
      }
    }]
  }
  const entries = previewWrite({ plan, entries: [] }, {
    kind: "confirm",
    request: { planId: plan.planId, rowId: row.rowId }
  })
  expect(entries.filter((entry) => entry.source === "jira").map(({ endMs, startMs }) => ({ startMs, endMs })))
    .toEqual([
      { startMs, endMs: startMs + 3600000 },
      { startMs: startMs + 7200000, endMs: startMs + 10800000 }
    ])
  const settled = settleEntries(entries, {
    clockify: {
      _tag: "Written",
      seconds: 7200,
      segments: [
        { startMs, endMs: startMs + 3600000 },
        { startMs: startMs + 7200000, endMs: startMs + 10800000 }
      ]
    },
    jira: {
      _tag: "Written",
      seconds: 7200,
      segments: [
        { startMs, endMs: startMs + 3600000 },
        { startMs: startMs + 7200000, endMs: startMs + 10800000 }
      ]
    },
    description: "Saved note",
    lines: []
  })
  expect(settled.filter((entry) => entry.source === "clockify")).toHaveLength(2)
  expect(settled.every((entry) => !entry.pending)).toBe(true)
})

// Unsent previews belong to the queue, so Undo cannot erase saved entries or another approval.
it("projects queued entries immediately without changing the saved source", () => {
  const registry = AtomRegistry.make()
  try {
    const atoms = makeWeekAtoms()
    const plan = fixtureWeek()
    const queued = [0, 1].map((block): QueuedConfirmation => {
      const request = { planId: plan.planId, rowId: "row-one", blocks: [block] }
      const entries = previewWrite({ plan, entries: [] }, { kind: "confirm", request })
      return {
        id: `queued-${block}`,
        ticketKey: "PROJ-123",
        day: plan.monday,
        status: "queued",
        undoUntil: 5000,
        startMs: Math.min(...entries.map((entry) => entry.startMs)),
        endMs: Math.max(...entries.map((entry) => entry.endMs)),
        request,
        entries
      }
    })
    registry.set(atoms.source, { plan, entries: [] })
    registry.set(atoms.queued, queued)
    expect(registry.get(atoms.source).entries).toEqual([])
    expect(registry.get(atoms.visible).entries).toHaveLength(4)
    registry.update(atoms.queued, (items) => items.filter((item) => item.id !== "queued-0"))
    expect(registry.get(atoms.visible).entries).toHaveLength(2)
    expect(registry.get(atoms.visible).entries.every((entry) => entry.blocks?.includes(1))).toBe(true)
    expect(registry.get(atoms.source)).toEqual({ plan, entries: [] })
  } finally {
    registry.dispose()
  }
})
