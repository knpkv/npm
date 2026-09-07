import { describe, expect, it } from "@effect/vitest"
import type { AgentSessions, ReconcileService } from "@knpkv/jira-clockify"
import { buildWeekPlan, MINIMUM_WRITE_SECONDS, proposeWrite, rowId, weekDays } from "../src/server/WeekPlan.js"

/** Local components throughout, so these hold in any timezone. */
const at = (day: number, hour: number): number => new Date(2025, 5, day, hour, 0, 0, 0).getTime()

const monday = new Date(2025, 5, 16, 0, 0, 0, 0)

const proposal = (
  overrides: Partial<AgentSessions.SessionProposal> & { readonly ticketKey: string; readonly day: string }
): AgentSessions.SessionProposal => ({
  activeSeconds: 3600,
  clockifyDelta: 3600,
  clockifySeconds: 0,
  confidence: null,
  jiraDelta: 3600,
  jiraSeconds: 0,
  sessionIds: ["s1"],
  sessionSeconds: 3600,
  signal: "branch",
  spans: [{ endMs: at(16, 11), startMs: at(16, 10) }],
  ...overrides
})

const recorded = (
  overrides: Partial<ReconcileService.ReconcileRow> & { readonly ticketKey: string; readonly day: string }
): ReconcileService.ReconcileRow => ({
  clockifyDescription: null,
  clockifySeconds: 0,
  jiraSeconds: 0,
  ...overrides
})

const report = (
  overrides: Partial<ReconcileService.SessionProposalReport>
): ReconcileService.SessionProposalReport => ({
  attributorAvailable: true,
  attributorCalls: 0,
  digests: new Map(),
  excludedDays: [],
  proposals: [],
  recorded: [],
  sessionCount: 1,
  sessionRootCount: 1,
  unattributed: [],
  withheld: [],
  ...overrides
})

const build = (overrides: Partial<ReconcileService.SessionProposalReport>) =>
  buildWeekPlan({ createdAtMillis: 0, monday, planId: "plan-1", report: report(overrides) })

describe("weekDays", () => {
  it("names the seven local days from Monday", () => {
    expect(weekDays(monday)).toEqual([
      "2025-06-16",
      "2025-06-17",
      "2025-06-18",
      "2025-06-19",
      "2025-06-20",
      "2025-06-21",
      "2025-06-22"
    ])
  })
})

describe("buildWeekPlan", () => {
  it("shows a bucket only Clockify holds, with no proposal", () => {
    const held = build({
      recorded: [
        recorded({
          clockifyDescription: "[PROJ-1] timer",
          clockifySeconds: 1800,
          day: "2025-06-17",
          ticketKey: "PROJ-1"
        })
      ]
    })
    expect(held.plan.rows).toHaveLength(1)
    const row = held.plan.rows[0]!
    expect(row.clockifySeconds).toBe(1800)
    expect(row.jiraSeconds).toBe(0)
    expect(row.proposal).toBeUndefined()
    expect(row.clockifyDescription).toBe("[PROJ-1] timer")
  })

  it("merges a proposal onto the bucket it tops up rather than adding a second row", () => {
    const held = build({
      proposals: [
        proposal({
          clockifyDelta: 1800,
          clockifySeconds: 1800,
          day: "2025-06-17",
          sessionSeconds: 3600,
          ticketKey: "PROJ-1"
        })
      ],
      recorded: [recorded({ clockifySeconds: 1800, day: "2025-06-17", ticketKey: "PROJ-1" })]
    })
    expect(held.plan.rows).toHaveLength(1)
    const row = held.plan.rows[0]!
    expect(row.clockifySeconds).toBe(1800)
    expect(row.proposal?.clockifyDelta).toBe(1800)
    // The cap on an edited amount is the credited evidence, not the gap that is missing right now.
    expect(row.proposal?.maxSeconds).toBe(3600)
  })

  it("holds the engine's own proposal behind the row a confirmation names", () => {
    const held = build({ proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-2" })] })
    const evidence = held.evidence.get(rowId("PROJ-2", "2025-06-16"))
    expect(evidence?.proposal.spans).toEqual([{ endMs: at(16, 11), startMs: at(16, 10) }])
  })

  it("keeps row names stable across reads, so a re-read puts every row back where it was", () => {
    const first = build({ proposals: [proposal({ day: "2025-06-18", ticketKey: "PROJ-3" })] })
    const second = buildWeekPlan({
      createdAtMillis: 1,
      monday,
      planId: "plan-2",
      report: report({ proposals: [proposal({ day: "2025-06-18", ticketKey: "PROJ-3" })] })
    })
    expect(first.plan.rows[0]!.rowId).toBe(second.plan.rows[0]!.rowId)
  })

  it("sends nothing from another week rather than a row with no column to sit in", () => {
    const held = build({
      proposals: [proposal({ day: "2025-06-23", ticketKey: "PROJ-4" })],
      recorded: [recorded({ clockifySeconds: 600, day: "2025-06-09", ticketKey: "PROJ-5" })],
      unattributed: [{ cwds: ["/dev/side"], day: "2025-06-23", seconds: 900, sessionCount: 1 }]
    })
    expect(held.plan.rows).toEqual([])
    expect(held.plan.unattributed).toEqual([])
    expect(held.evidence.size).toBe(0)
  })

  it("carries the directories behind unplaced hours, which is what makes them actionable", () => {
    const held = build({
      unattributed: [{ cwds: ["/dev/docs/releases"], day: "2025-06-19", seconds: 5400, sessionCount: 2 }]
    })
    expect(held.plan.unattributed[0]!.cwds).toEqual(["/dev/docs/releases"])
  })
})

describe("proposeWrite", () => {
  const held = { heldClockifySeconds: 0, heldJiraSeconds: 0 }

  it("writes the whole evidence when neither side holds anything", () => {
    expect(proposeWrite({ ...held, credited: 3600, requested: undefined }))
      .toEqual({ _tag: "Write", clockifyDelta: 3600, jiraDelta: 3600 })
  })

  it("sizes each side to its own gap", () => {
    expect(proposeWrite({ credited: 3600, heldClockifySeconds: 3600, heldJiraSeconds: 1800, requested: undefined }))
      .toEqual({ _tag: "Write", clockifyDelta: 0, jiraDelta: 1800 })
  })

  it("refuses more time than the sessions evidence, and says what the ceiling is", () => {
    expect(proposeWrite({ ...held, credited: 3600, requested: 7200 }))
      .toEqual({ _tag: "PastEvidence", maxSeconds: 3600 })
  })

  it("accepts an amount below the evidence — a person may say it overstates the work", () => {
    expect(proposeWrite({ ...held, credited: 3600, requested: 1800 }))
      .toEqual({ _tag: "Write", clockifyDelta: 1800, jiraDelta: 1800 })
  })

  it("writes nothing when both sides already hold the time", () => {
    expect(proposeWrite({ credited: 3600, heldClockifySeconds: 3600, heldJiraSeconds: 3600, requested: undefined }))
      .toEqual({ _tag: "NothingOwed" })
  })

  it("refuses an amount Jira could not record faithfully", () => {
    expect(proposeWrite({ ...held, credited: 3600, requested: 30 }))
      .toEqual({ _tag: "BelowMinimum", minimumSeconds: MINIMUM_WRITE_SECONDS })
  })

  it("drops a side whose remaining gap is under a minute rather than writing a rounding artefact", () => {
    expect(proposeWrite({ credited: 3600, heldClockifySeconds: 3570, heldJiraSeconds: 0, requested: undefined }))
      .toEqual({ _tag: "Write", clockifyDelta: 0, jiraDelta: 3600 })
  })
})
