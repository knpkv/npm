import { describe, expect, it } from "@effect/vitest"
import { type AgentSessions, type IssueFacts, type ReconcileService, SourceConsumption } from "@knpkv/jira-clockify"
import { Schema } from "effect"
import {
  buildWeekPlan,
  evidenceBlockKey,
  isOwnedByMe,
  MINIMUM_WRITE_SECONDS,
  type OwnershipInput,
  proposeWrite,
  reconcileConsumption,
  rowId,
  selectedBlocks,
  weekDays
} from "../src/server/WeekPlan.js"
import { WeekPlan } from "../src/shared/contracts.js"

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
  sourceStartMs: at(16, 10),
  settlementEndMs: at(16, 11),
  signal: "branch",
  blocks: [{ endMs: at(16, 11), seconds: 3600, startMs: at(16, 10) }],
  ...overrides
})

const recorded = (
  overrides: Partial<ReconcileService.ReconcileRow> & { readonly ticketKey: string; readonly day: string }
): ReconcileService.ReconcileRow => ({
  clockifyDescription: null,
  clockifySeconds: 0,
  intervals: [],
  jiraSeconds: 0,
  ...overrides
})

const report = (
  overrides: Partial<ReconcileService.SessionProposalReport>
): ReconcileService.SessionProposalReport => ({
  attributed: [],
  attributorAvailable: true,
  attributorCalls: 0,
  digests: new Map(),
  excludedDays: [],
  proposals: [],
  recorded: [],
  unlinkedClockify: [],
  sessionCount: 1,
  sessionRootCount: 1,
  sides: { clockify: true, jira: true },
  unattributed: [],
  withheld: [],
  ...overrides
})

const build = (overrides: Partial<ReconcileService.SessionProposalReport>) =>
  buildWeekPlan({ createdAtMillis: 0, monday, planId: "plan-1", report: report(overrides), scope: "both" })

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

describe("evidenceBlockKey", () => {
  it("keeps confirmed time on the first of two allocations from one source cluster", () => {
    const sourceRow = rowId("PROJ-1", "2025-06-16")
    const sourceStartMs = at(16, 9)
    const first = {
      allocationIndex: 0,
      endMs: sourceStartMs + 20 * 60_000,
      seconds: 1200,
      sourceStartMs,
      startMs: sourceStartMs
    }
    const later = {
      allocationIndex: 1,
      endMs: sourceStartMs + 120 * 60_000,
      seconds: 2400,
      sourceStartMs,
      startMs: sourceStartMs + 80 * 60_000
    }
    const credit: AgentSessions.TicketDayCredit = {
      activeSeconds: 4800,
      blocks: [first, later],
      confidence: null,
      day: "2025-06-16",
      seconds: 3600,
      sessionIds: ["s1"],
      settlementEndMs: later.endMs,
      signal: "branch",
      sourceStartMs,
      ticketKey: "PROJ-1"
    }
    const confirmed: ReconcileService.RecordedEntry = {
      description: "corrected",
      endMs: first.endMs,
      id: "synthetic-confirmed",
      source: "clockify",
      startMs: first.startMs,
      ticketKey: "PROJ-2"
    }
    const consumption = reconcileConsumption(report({
      attributed: [credit],
      recorded: [recorded({
        clockifySeconds: 1200,
        day: "2025-06-16",
        intervals: [{ entry: confirmed, endMs: first.endMs, source: "clockify", startMs: first.startMs }],
        ticketKey: "PROJ-2"
      })],
      sourceEntries: [{
        endMs: first.endMs,
        id: confirmed.id,
        rowId: sourceRow,
        source: "clockify",
        sourceStartMs,
        startMs: first.startMs
      }]
    }))
    expect(evidenceBlockKey(sourceRow, first)).not.toBe(evidenceBlockKey(sourceRow, later))
    expect(consumption.get(evidenceBlockKey(sourceRow, first))?.clockify).toBe(1200)
    expect(consumption.get(evidenceBlockKey(sourceRow, later))).toBeUndefined()
  })

  it("retains consumption when a live block grows, without merging a later block", () => {
    const sourceStartMs = at(16, 9)
    const initial = { startMs: at(16, 10), endMs: at(16, 11), seconds: 3600, sourceStartMs }
    const grown = { startMs: at(16, 11), endMs: at(16, 12), seconds: 7200, sourceStartMs }
    const later = { startMs: at(16, 12), endMs: at(16, 13), seconds: 3600 }
    expect(evidenceBlockKey("row", grown)).toBe(evidenceBlockKey("row", initial))
    expect(evidenceBlockKey("row", later)).not.toBe(evidenceBlockKey("row", initial))
  })

  it("maps a clipped watch marker onto the widened block reconstructed by a week read", () => {
    const sourceRow = rowId("PROJ-1", "2025-06-16")
    const block = {
      startMs: at(16, 9),
      endMs: at(16, 10),
      seconds: 3600,
      sourceStartMs: at(16, 9)
    }
    const credit: AgentSessions.TicketDayCredit = {
      activeSeconds: 3600,
      blocks: [block],
      confidence: null,
      day: "2025-06-16",
      seconds: 3600,
      sessionIds: ["s1"],
      settlementEndMs: at(16, 10),
      signal: "branch",
      sourceStartMs: at(16, 9),
      ticketKey: "PROJ-1"
    }
    const markerStartMs = at(16, 9) + 30 * 60_000
    const sources: ReadonlyArray<"clockify" | "jira"> = ["clockify", "jira"]
    const corrected = recorded({
      clockifySeconds: 1800,
      day: "2025-06-16",
      intervals: sources.map((source) => ({
        source,
        startMs: markerStartMs,
        endMs: at(16, 10),
        entry: {
          description: SourceConsumption.marker(sourceRow, markerStartMs),
          endMs: at(16, 10),
          id: `${source}-clipped`,
          source,
          startMs: markerStartMs,
          ticketKey: "PROJ-2"
        }
      })),
      jiraSeconds: 1800,
      ticketKey: "PROJ-2"
    })

    const consumption = reconcileConsumption(report({ attributed: [credit], recorded: [corrected] }))
    expect(consumption.get(evidenceBlockKey(sourceRow, block))).toEqual({ clockify: 1800, jira: 1800 })
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
    expect(row.proposal?.blocks[0]?.consumed).toEqual({ clockify: 0, jira: 0 })
  })

  it("serializes retained consumption for a provider omitted from the current read", () => {
    const block = { endMs: at(16, 11), seconds: 3600, startMs: at(16, 10) }
    const source = proposal({ blocks: [block], day: "2025-06-16", ticketKey: "PROJ-1" })
    const credit: AgentSessions.TicketDayCredit = {
      activeSeconds: source.activeSeconds,
      blocks: source.blocks,
      confidence: source.confidence,
      day: source.day,
      seconds: source.sessionSeconds,
      sessionIds: source.sessionIds,
      settlementEndMs: source.settlementEndMs,
      signal: source.signal,
      sourceStartMs: source.sourceStartMs,
      ticketKey: source.ticketKey
    }
    const key = evidenceBlockKey(rowId(source.ticketKey, source.day), block)
    const previous = new Map([[key, { clockify: 900, jira: 1800 }]])
    const cases: ReadonlyArray<{
      readonly scope: "clockify" | "jira"
      readonly sides: { readonly clockify: boolean; readonly jira: boolean }
      readonly expected: { readonly clockify: number; readonly jira: number }
    }> = [
      { scope: "clockify", sides: { clockify: true, jira: false }, expected: { clockify: 0, jira: 1800 } },
      { scope: "jira", sides: { clockify: false, jira: true }, expected: { clockify: 900, jira: 0 } }
    ]
    for (const { expected, scope, sides } of cases) {
      const held = buildWeekPlan({
        createdAtMillis: 0,
        monday,
        planId: `plan-${scope}`,
        report: report({ attributed: [credit], proposals: [source], sides }),
        scope,
        consumption: previous
      })
      const wire = Schema.encodeSync(WeekPlan)(held.plan)
      const decoded = Schema.decodeSync(WeekPlan)(wire)
      expect(decoded.rows[0]?.proposal?.blocks[0]?.consumed).toEqual(expected)
    }
  })

  it("holds the engine's own proposal behind the row a confirmation names", () => {
    const held = build({ proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-2" })] })
    const evidence = held.evidence.get(rowId("PROJ-2", "2025-06-16"))
    expect(evidence?.proposal.blocks).toEqual([{ endMs: at(16, 11), seconds: 3600, startMs: at(16, 10) }])
  })

  it("keeps row names stable across reads, so a re-read puts every row back where it was", () => {
    const first = build({ proposals: [proposal({ day: "2025-06-18", ticketKey: "PROJ-3" })] })
    const second = buildWeekPlan({
      createdAtMillis: 1,
      monday,
      planId: "plan-2",
      report: report({ proposals: [proposal({ day: "2025-06-18", ticketKey: "PROJ-3" })] }),
      scope: "both"
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

  it("carries the intervals behind the totals, which is what a calendar is drawn from", () => {
    const held = build({
      recorded: [
        recorded({
          clockifySeconds: 3600,
          day: "2025-06-17",
          intervals: [{ endMs: at(17, 11), source: "clockify", startMs: at(17, 10) }],
          ticketKey: "PROJ-1"
        })
      ]
    })
    expect(held.plan.rows[0]!.intervals).toEqual([{ endMs: at(17, 11), source: "clockify", startMs: at(17, 10) }])
  })

  it("says which systems the week was read from", () => {
    const held = buildWeekPlan({ createdAtMillis: 0, monday, planId: "p", report: report({}), scope: "jira" })
    expect(held.plan.scope).toBe("jira")
  })

  it("carries the directories behind unplaced hours, which is what makes them actionable", () => {
    const held = build({
      unattributed: [{ cwds: ["/dev/docs/releases"], day: "2025-06-19", seconds: 5400, sessionCount: 2 }]
    })
    expect(held.plan.unattributed[0]!.cwds).toEqual(["/dev/docs/releases"])
  })
})

describe("ownership", () => {
  const fact = (
    key: string,
    overrides: Partial<IssueFacts.IssueFact> = {}
  ): IssueFacts.IssueFact => ({
    assignee: "Someone Else",
    assignment: "other-assignee",
    key,
    mine: false,
    title: `${key} title`,
    ...overrides
  })

  const owning = (overrides: Partial<OwnershipInput> = {}): OwnershipInput => ({
    checked: true,
    facts: new Map([
      ["PROJ-1", fact("PROJ-1", { assignee: "Me", assignment: "mine", mine: true })],
      ["PROJ-2", fact("PROJ-2")]
    ]),
    mode: "assigned",
    overrides: [],
    ...overrides
  })

  const withOwnership = (
    overrides: Partial<ReconcileService.SessionProposalReport>,
    ownership: OwnershipInput
  ) =>
    buildWeekPlan({
      createdAtMillis: 0,
      monday,
      ownership,
      planId: "plan-1",
      report: report(overrides),
      scope: "both"
    })

  it("proposes a ticket assigned to me", () => {
    const held = withOwnership({ proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-1" })] }, owning())
    expect(held.plan.rows[0]?.proposal).toBeDefined()
    expect(held.plan.notMine).toEqual([])
  })

  // The case this exists for: a branch checked out to review somebody's pull request.
  it("withholds a ticket assigned to somebody else, keeping its hours in view", () => {
    const held = withOwnership({ proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-2" })] }, owning())
    // No row to accept, and no evidence held, so there is nothing a confirmation could name either.
    expect(held.plan.rows).toEqual([])
    expect(held.evidence.size).toBe(0)
    expect(held.plan.notMine).toEqual([{
      assignee: "Someone Else",
      day: "2025-06-16",
      seconds: 3600,
      signal: "branch",
      ticketKey: "PROJ-2",
      ticketTitle: "PROJ-2 title"
    }])
  })

  it("proposes a withheld ticket once it has been claimed", () => {
    const held = withOwnership(
      { proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-2" })] },
      owning({ overrides: ["PROJ-2"] })
    )
    expect(held.plan.rows[0]?.proposal).toBeDefined()
    expect(held.plan.notMine).toEqual([])
  })

  // Silence is not an answer. A key Jira was never asked about, or could not answer for, stays
  // proposable — withholding on an unknown is how hours go missing with nothing to explain them.
  it("proposes a ticket nobody could answer for", () => {
    const unknown = withOwnership({ proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-9" })] }, owning())
    expect(unknown.plan.rows[0]?.proposal).toBeDefined()

    const unchecked = withOwnership(
      { proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-2" })] },
      owning({ checked: false, facts: new Map() })
    )
    expect(unchecked.plan.rows[0]?.proposal).toBeDefined()
    expect(unchecked.plan.ownershipChecked).toBe(false)
  })

  it("proposes everything when ownership is not being enforced", () => {
    const held = withOwnership(
      { proposals: [proposal({ day: "2025-06-16", ticketKey: "PROJ-2" })] },
      owning({ mode: "any" })
    )
    expect(held.plan.rows[0]?.proposal).toBeDefined()
    expect(held.plan.ownership).toBe("any")
  })

  it("titles every row it can, including one only Clockify knows about", () => {
    const held = withOwnership({
      recorded: [recorded({ clockifySeconds: 1800, day: "2025-06-17", ticketKey: "PROJ-1" })],
      withheld: [{
        activeSeconds: 600,
        blocks: [],
        confidence: 0.4,
        day: "2025-06-18",
        seconds: 600,
        sourceStartMs: at(18, 10),
        settlementEndMs: at(18, 11),
        sessionIds: ["s1"],
        signal: "agent",
        ticketKey: "PROJ-2"
      }]
    }, owning())
    expect(held.plan.rows[0]?.ticketTitle).toBe("PROJ-1 title")
    expect(held.plan.withheld[0]?.ticketTitle).toBe("PROJ-2 title")
  })

  it("says a key is mine on any of the four grounds, and only withholds on a named assignee", () => {
    expect(isOwnedByMe("PROJ-1", owning())).toBe(true)
    expect(isOwnedByMe("PROJ-2", owning())).toBe(false)
    expect(isOwnedByMe("PROJ-2", owning({ mode: "any" }))).toBe(true)
    expect(isOwnedByMe("PROJ-2", owning({ overrides: ["PROJ-2"] }))).toBe(true)
    expect(isOwnedByMe("PROJ-404", owning())).toBe(true)
  })
})

describe("selectedBlocks", () => {
  const blocks = [
    { endMs: at(16, 11), seconds: 600, startMs: at(16, 10) },
    { endMs: at(16, 15), seconds: 900, startMs: at(16, 14) },
    { endMs: at(16, 20), seconds: 1200, startMs: at(16, 19) }
  ]

  it("takes every block when a confirmation names none", () => {
    expect(selectedBlocks(blocks, undefined)).toEqual(blocks)
  })

  it("takes the named blocks, deduplicated and in time order", () => {
    expect(selectedBlocks(blocks, [2, 0, 2])).toEqual([blocks[0], blocks[2]])
  })

  // A page confirming against a plan that has since been re-read. Refusing is the only safe answer:
  // writing "whatever block 7 turned out to be" would write time nobody chose.
  it("refuses a position this row does not have, and refuses an empty choice", () => {
    expect(selectedBlocks(blocks, [7])).toBeUndefined()
    expect(selectedBlocks(blocks, [])).toBeUndefined()
    expect(selectedBlocks(blocks, [-1])).toBeUndefined()
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

  it("writes only the blocks that were chosen", () => {
    expect(proposeWrite({ ...held, credited: 3600, requested: undefined, selected: 900 }))
      .toEqual({ _tag: "Write", clockifyDelta: 900, jiraDelta: 900 })
  })

  // The reason a side is sized against the row and not against the selection. Writing the morning
  // must not make the afternoon look like time both systems already hold.
  it("still writes a second block after the first one is in", () => {
    expect(proposeWrite({
      credited: 3600,
      heldClockifySeconds: 900,
      heldJiraSeconds: 900,
      requested: undefined,
      selected: 1800
    })).toEqual({ _tag: "Write", clockifyDelta: 1800, jiraDelta: 1800 })
  })

  // Whatever the selection says, the day's total credit is the ceiling: the last block of a row
  // three-quarters written is worth only the quarter that is left.
  it("never writes past the row's own credit, however much was selected", () => {
    expect(proposeWrite({
      credited: 3600,
      heldClockifySeconds: 3000,
      heldJiraSeconds: 3000,
      requested: undefined,
      selected: 1800
    })).toEqual({ _tag: "Write", clockifyDelta: 600, jiraDelta: 600 })
  })

  it("caps an edited amount at the selection rather than at the row", () => {
    expect(proposeWrite({ ...held, credited: 3600, requested: 1200, selected: 900 }))
      .toEqual({ _tag: "PastEvidence", maxSeconds: 900 })
  })

  it("refuses an amount Jira could not record faithfully", () => {
    expect(proposeWrite({ ...held, credited: 3600, requested: 30, targets: { clockify: false, jira: true } }))
      .toEqual({ _tag: "BelowMinimum", minimumSeconds: MINIMUM_WRITE_SECONDS })
  })

  it("retains Clockify's exact sub-minute remainder while Jira keeps its minute floor", () => {
    expect(proposeWrite({ credited: 3600, heldClockifySeconds: 3570, heldJiraSeconds: 0, requested: undefined }))
      .toEqual({ _tag: "Write", clockifyDelta: 30, jiraDelta: 3600 })
  })

  it("proposes nothing for a system that is out of scope", () => {
    expect(proposeWrite({
      ...held,
      credited: 3600,
      requested: undefined,
      targets: { clockify: false, jira: true }
    })).toEqual({ _tag: "Write", clockifyDelta: 0, jiraDelta: 3600 })
  })

  it("owes nothing when the only system in scope already holds the time", () => {
    expect(proposeWrite({
      credited: 3600,
      heldClockifySeconds: 0,
      heldJiraSeconds: 3600,
      requested: undefined,
      targets: { clockify: false, jira: true }
    })).toEqual({ _tag: "NothingOwed" })
  })
})
