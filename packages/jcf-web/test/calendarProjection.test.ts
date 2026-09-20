import { expect, it } from "@effect/vitest"
import { defaultCalendarLayers, projectCalendar, weekTotals } from "../src/client/calendarProjection.js"
import { previewWrite } from "../src/client/weekAtoms.js"
import type { SavedEntry } from "../src/shared/contracts.js"
import { fixtureWeek } from "./fixture.js"

// Provider IDs, not shared ticket/time, identify the edited record. Null is an exact saved description.
it("replaces only the edited provider card and preserves its whole-entry metadata", () => {
  const base = fixtureWeek()
  const entry: SavedEntry = {
    id: "shared-id",
    revision: "entry-revision",
    source: "jira",
    ticketKey: "PROJ-123",
    startMs: new Date(`${base.monday}T09:00:00`).getTime(),
    endMs: new Date(`${base.monday}T10:00:00`).getTime(),
    description: null
  }
  const plan = {
    ...base,
    rows: [{
      ...base.rows[0]!,
      intervals: [
        { ...entry, entry },
        { ...entry, source: "clockify", entry: { ...entry, source: "clockify", description: "Clockify exact" } }
      ] satisfies typeof base.rows[number]["intervals"]
    }]
  }
  expect(
    projectCalendar(plan, []).placements.get(base.monday)?.find(({ block }) =>
      block.kind === "logged" && block.source === "jira"
    )?.block
  ).toMatchObject({ description: null, entry })
  const edited = { ...entry, startMs: entry.startMs + 60000, description: "New description" }
  const projection = projectCalendar(plan, [{
    ...edited,
    entry: edited,
    id: "optimistic-edit",
    replaces: { source: entry.source, id: entry.id },
    pending: true,
    rowId: undefined,
    blocks: undefined
  }])
  const cards = projection.placements.get(base.monday)?.filter(({ block }) => block.kind === "logged")
  expect(cards).toHaveLength(2)
  expect(cards?.map(({ block }) => block)).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: "clockify", description: "Clockify exact" }),
    expect.objectContaining({ source: "jira", description: "New description", startMs: edited.startMs, entry: edited })
  ]))
})

// Occupied time follows visible providers, including Clockify entries without a ticket.
it("reclassifies suggestions and counts when provider visibility changes", () => {
  const base = fixtureWeek()
  const plan = {
    ...base,
    unlinkedClockify: [{
      day: base.monday,
      startMs: new Date(`${base.monday}T11:30:00`).getTime(),
      endMs: new Date(`${base.monday}T12:00:00`).getTime(),
      description: "Meeting",
      seconds: 1800
    }]
  }
  const shown = projectCalendar(plan, [])
  expect(shown.counts).toEqual({ jira: 0, clockify: 2, available: 1, overlapping: 1 })
  expect(shown.placements.get(plan.monday)?.filter(({ block }) => block.kind === "proposable")).toHaveLength(1)
  const hidden = projectCalendar(plan, [], { ...defaultCalendarLayers, clockify: false })
  expect(hidden.counts).toEqual({ jira: 0, clockify: 2, available: 2, overlapping: 0 })
  expect(hidden.placements.get(plan.monday)).toHaveLength(2)
  expect(hidden.visibleHours).toEqual(shown.visibleHours)
  expect(weekTotals(plan).clockify).toBe(5400)
})

// Only a positive intersection is occupied; an entry ending at a suggestion start does not overlap.
it("keeps touching suggestions available and retains separate provider layers", () => {
  const base = fixtureWeek()
  const plan = {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      intervals: [
        {
          source: "jira",
          startMs: new Date(`${base.monday}T10:00:00`).getTime(),
          endMs: new Date(`${base.monday}T11:00:00`).getTime()
        },
        ...row.intervals
      ] satisfies typeof row.intervals
    }))
  }
  const projection = projectCalendar(plan, [])
  expect(projection.counts).toEqual({ jira: 1, clockify: 1, available: 2, overlapping: 0 })
})

// A selected pending block disappears from suggestions while unselected evidence remains reviewable.
it("suppresses only the proposed blocks represented by optimistic writes", () => {
  const plan = fixtureWeek()
  const entries = previewWrite({ plan, entries: [] }, {
    kind: "confirm",
    request: { planId: plan.planId, rowId: "row-one", blocks: [1] }
  })
  const projection = projectCalendar(plan, entries)
  expect(projection.counts).toEqual({ jira: 1, clockify: 2, available: 1, overlapping: 0 })
  const suggestions = projection.placements.get(plan.monday)?.filter(({ block }) => block.kind === "proposable")
  expect(suggestions?.map(({ block }) => block.id)).toEqual(["row-one:gap:0"])
})

// Friday-started time still occupies Saturday. Hidden layers must not collapse the day or hour frame.
it("includes both days and midnight hours for an overnight entry into the weekend", () => {
  const base = fixtureWeek()
  const plan = {
    ...base,
    unlinkedClockify: [{
      day: "2026-09-11",
      startMs: new Date("2026-09-11T23:00:00").getTime(),
      endMs: new Date("2026-09-12T01:00:00").getTime(),
      seconds: 7200,
      description: "Overnight operation"
    }]
  }
  const shown = projectCalendar(plan, [])
  expect(shown.days).toContain("2026-09-12")
  expect(shown.days).not.toContain("2026-09-13")
  expect(shown.visibleHours).toEqual({ fromHour: 0, toHour: 24 })
  expect(shown.placements.get("2026-09-11")?.[0]).toMatchObject({ startMinutes: 1380, endMinutes: 1440 })
  expect(shown.placements.get("2026-09-12")?.[0]).toMatchObject({ startMinutes: 0, endMinutes: 60 })
  const hidden = projectCalendar(plan, [], { ...defaultCalendarLayers, clockify: false })
  expect(hidden.days).toEqual(shown.days)
  expect(hidden.visibleHours).toEqual(shown.visibleHours)
  expect(hidden.placements.get("2026-09-12")).toEqual([])
})

// Saved entries can be shorter than suggestion policy; their drawn cards still need collision space.
it("reserves the drawn card height without changing saved entry duration", () => {
  const base = fixtureWeek()
  const startMs = new Date(`${base.monday}T22:00:00`).getTime()
  const plan = {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      proposal: undefined,
      intervals: Array.from({ length: 6 }, (_, index) => ({
        source: "clockify",
        startMs: startMs + index * 180000,
        endMs: startMs + index * 180000 + 60000
      })) satisfies typeof row.intervals
    }))
  }
  const blocks =
    projectCalendar(plan, []).placements.get(plan.monday)?.filter(({ block }) => block.kind === "logged") ?? []
  expect(blocks).toHaveLength(6)
  for (const a of blocks) {
    expect(a.endMinutes - a.startMinutes).toBe(1)
    for (const b of blocks) {
      if (a === b || a.column !== b.column) continue
      expect(a.startMinutes + 12 <= b.startMinutes || b.startMinutes + 12 <= a.startMinutes).toBe(true)
    }
  }
})

// Restored evidence is immutable: filtering short blocks must not renumber a later confirmation target.
it("suppresses sixteen-second and sub-fifteen-minute suggestions while preserving original block indexes", () => {
  const base = fixtureWeek()
  const startMs = new Date(`${base.monday}T11:00:00`).getTime()
  const plan = {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      proposal: row.proposal === undefined ? undefined : {
        ...row.proposal,
        blocks: [16, 899, 900].map((seconds, index) => ({
          consumed: { clockify: 0, jira: 0 },
          startMs: startMs + index * 3600000,
          endMs: startMs + index * 3600000 + seconds * 1000,
          seconds
        }))
      }
    }))
  }
  const before = structuredClone(plan)
  const projection = projectCalendar(plan, [])
  const suggestions = projection.placements.get(plan.monday)?.filter(({ block }) => block.kind === "proposable")
  expect(suggestions).toHaveLength(1)
  expect(suggestions?.[0]?.block).toMatchObject({
    id: "row-one:gap:2",
    blockIndex: 2,
    seconds: 900,
    startMs: startMs + 7200000,
    endMs: startMs + 8100000
  })
  expect(projection.counts).toEqual({ jira: 0, clockify: 1, available: 1, overlapping: 0 })
  expect(plan).toEqual(before)
  expect(weekTotals(plan)).toMatchObject({ jiraSuggested: 900, clockifySuggested: 900 })
})

// Credit and wall range each need the floor. Neither can be padded to make a card actionable.
it.each([
  { credited: 16, duration: 900 },
  { credited: 900, duration: 16 },
  { credited: 899, duration: 1800 }
])("suppresses a $credited-second credit over a $duration-second range", ({ credited, duration }) => {
  const base = fixtureWeek()
  const startMs = new Date(`${base.monday}T11:00:00`).getTime()
  const plan = {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      proposal: row.proposal === undefined ? undefined : {
        ...row.proposal,
        blocks: [{ startMs, endMs: startMs + duration * 1000, seconds: credited, consumed: { clockify: 0, jira: 0 } }]
      }
    }))
  }
  expect(projectCalendar(plan, []).counts.available).toBe(0)
  expect(weekTotals(plan)).toMatchObject({ jiraSuggested: 0, clockifySuggested: 0 })
})

// A large hidden-provider delta cannot keep a tiny remainder in the selected provider visible.
it.each([16, 899, 900])("applies the suggestion floor to the selected provider's %s-second remainder", (remaining) => {
  const base = fixtureWeek()
  const plan = {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      clockifySeconds: (row.proposal?.maxSeconds ?? 0) - remaining,
      proposal: row.proposal === undefined ? undefined : {
        ...row.proposal,
        clockifyDelta: remaining,
        jiraDelta: 1800
      }
    }))
  }
  const both = projectCalendar(plan, [])
  expect(both.counts.available).toBe(2)
  const clockify = projectCalendar(plan, [], { ...defaultCalendarLayers, jira: false })
  expect(clockify.counts.available).toBe(remaining >= 900 ? 2 : 0)
  expect(clockify.placements.get(plan.monday)?.filter(({ block }) => block.kind === "proposable")).toHaveLength(
    remaining >= 900 ? 2 : 0
  )
  expect(clockify.visibleHours).toEqual(both.visibleHours)
  expect(clockify.days).toEqual(both.days)
  const jira = projectCalendar(plan, [], { ...defaultCalendarLayers, clockify: false })
  expect(jira.counts.available).toBe(2)
  expect(jira.placements.get(plan.monday)?.[0]?.block).toMatchObject({ deltaSeconds: 1800 })
  expect(projectCalendar(plan, [], { ...defaultCalendarLayers, clockify: false, jira: false }).counts.available).toBe(0)
  // Scope also limits authority when a restored plan contains a delta for an excluded provider.
  expect(projectCalendar({ ...plan, scope: "clockify" }, []).counts.available).toBe(remaining >= 900 ? 2 : 0)
  expect(weekTotals(plan)).toMatchObject({ jiraSuggested: 1800, clockifySuggested: remaining >= 900 ? remaining : 0 })
  expect(weekTotals({ ...plan, scope: "clockify" }).jiraSuggested).toBe(0)
})

it("hides a block when its selected provider has less than fifteen executable minutes", () => {
  const base = fixtureWeek()
  const row = base.rows[0]!
  const plan = {
    ...base,
    rows: [{
      ...row,
      clockifySeconds: 0,
      intervals: row.intervals.map((interval): typeof row.intervals[number] => ({ ...interval, source: "jira" })),
      proposal: row.proposal === undefined ? undefined : {
        ...row.proposal,
        clockifyDelta: 3900,
        jiraDelta: 3600,
        blocks: row.proposal.blocks.map((block, index) => ({
          ...block,
          consumed: { clockify: index === 0 ? 3300 : 0, jira: 0 }
        }))
      }
    }]
  }
  const clockify = projectCalendar(plan, [], { ...defaultCalendarLayers, jira: false })
  const suggestions = clockify.placements.get(plan.monday)?.filter(({ block }) => block.kind === "proposable")
  expect(suggestions?.map(({ block }) => block.id)).toEqual(["row-one:gap:1"])
  expect(weekTotals(plan).clockifySuggested).toBe(3600)
})

it("keeps an exact-threshold block for its provider without reviving the shorter side or hiding saved time", () => {
  const base = fixtureWeek()
  const row = base.rows[0]!
  const startMs = new Date(`${base.monday}T16:00:00`).getTime()
  const plan = {
    ...base,
    unlinkedClockify: [{
      day: base.monday,
      startMs,
      endMs: startMs + 16000,
      seconds: 16,
      description: "Saved short entry"
    }],
    rows: [{
      ...row,
      clockifySeconds: 0,
      intervals: row.intervals.map((interval): typeof row.intervals[number] => ({ ...interval, source: "jira" })),
      proposal: row.proposal === undefined ? undefined : {
        ...row.proposal,
        clockifyDelta: 4500,
        jiraDelta: 300,
        blocks: row.proposal.blocks.map((block, index) => ({
          ...block,
          consumed: { clockify: index === 0 ? 2700 : 0, jira: index === 0 ? 3300 : 0 }
        }))
      }
    }]
  }
  const clockify = projectCalendar(plan, [], { ...defaultCalendarLayers, jira: false })
  const jira = projectCalendar(plan, [], { ...defaultCalendarLayers, clockify: false })
  const suggestions = clockify.placements.get(plan.monday)?.filter(({ block }) => block.kind === "proposable")
  expect(suggestions?.map(({ block }) => block.id)).toEqual(["row-one:gap:0", "row-one:gap:1"])
  expect(suggestions?.[0]?.block).toMatchObject({ deltaSeconds: 900 })
  expect(jira.placements.get(plan.monday)?.filter(({ block }) => block.kind === "proposable")).toEqual([])
  expect(
    clockify.placements.get(plan.monday)?.some(({ block }) => block.kind === "logged" && block.source === "clockify")
  ).toBe(true)
  expect(weekTotals(plan)).toMatchObject({ clockify: 16, clockifySuggested: 4500, jiraSuggested: 0 })
})

// The fifteen-minute policy governs offers, never real Jira or Clockify records, including ticketless time.
it("retains sixteen-second provider records when all remaining suggestions are too short", () => {
  const base = fixtureWeek()
  const startMs = new Date(`${base.monday}T11:00:00`).getTime()
  const plan = {
    ...base,
    rows: base.rows.map((row) => ({
      ...row,
      clockifySeconds: 16,
      jiraSeconds: 16,
      intervals: (["jira", "clockify"] satisfies Array<"jira" | "clockify">).map((source) => ({
        source,
        startMs,
        endMs: startMs + 16000
      })),
      proposal: row.proposal === undefined ? undefined : {
        ...row.proposal,
        clockifyDelta: 16,
        jiraDelta: 16
      }
    })),
    unlinkedClockify: [{
      day: base.monday,
      startMs: startMs + 60000,
      endMs: startMs + 76000,
      seconds: 16,
      description: "Saved short entry"
    }]
  }
  const projection = projectCalendar(plan, [])
  expect(projection.counts).toEqual({ jira: 1, clockify: 2, available: 0, overlapping: 0 })
  expect(projection.placements.get(plan.monday)).toHaveLength(3)
  expect(weekTotals(plan)).toEqual({ jira: 16, clockify: 32, jiraSuggested: 0, clockifySuggested: 0 })
})
