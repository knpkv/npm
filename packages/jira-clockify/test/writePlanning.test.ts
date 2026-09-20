import { describe, expect, it } from "@effect/vitest"
import { prepareProposal, type ProposedWrite } from "../src/agent/writePlanning.js"

const morning = { startMs: 0, endMs: 3600000, seconds: 3600 }
const afternoon = { startMs: 18000000, endMs: 21600000, seconds: 3600 }
const evidence = { ticketKey: "PROJ-1", day: "2026-07-01", credited: 7200, blocks: [morning, afternoon] }
const targets = { clockify: true, jira: true }
const interval = (source: "clockify" | "jira", startMs: number, endMs: number) => ({ source, startMs, endMs })
const held = {
  ticketKey: evidence.ticketKey,
  day: evidence.day,
  clockifySeconds: 3600,
  jiraSeconds: 1800,
  intervals: [
    interval("clockify", morning.startMs, morning.endMs),
    interval("jira", morning.startMs, morning.startMs + 1800000)
  ]
}

describe("confirmation planning", () => {
  // The same selection has independent sizing and anchoring semantics: existing morning time
  // reduces the day's room but cannot move a deliberately selected afternoon start.
  it("sizes a deduplicated subset against each provider and keeps its own start", () => {
    const prepared = prepareProposal({ evidence, targets, request: { blocks: [1, 1], seconds: 2400 } })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([{
      ...held,
      clockifySeconds: 6300,
      intervals: [...held.intervals, interval("clockify", morning.endMs, morning.endMs + 2700000)]
    }])).toMatchObject({
      _tag: "Write",
      ticketKey: evidence.ticketKey,
      day: evidence.day,
      targets,
      clockify: { seconds: 900, startedAt: new Date(afternoon.startMs) },
      jira: { seconds: 2400, startedAt: new Date(afternoon.startMs) }
    })
    expect(prepared.provenance).toEqual({ evidence: "session", amountSetByHand: true, ticketSetByHand: false })
  })

  it("does not write the same selected block twice", () => {
    const prepared = prepareProposal({ evidence, targets, request: { blocks: [1] } })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([{
      ...held,
      clockifySeconds: 7200,
      jiraSeconds: 5400,
      intervals: [
        ...held.intervals,
        { startMs: afternoon.startMs, endMs: afternoon.endMs, source: "clockify" },
        { startMs: afternoon.startMs, endMs: afternoon.startMs + 1800000, source: "jira" }
      ]
    }])).toMatchObject({
      _tag: "Write",
      ticketKey: evidence.ticketKey,
      day: evidence.day,
      targets,
      clockify: { seconds: 0, startedAt: undefined },
      jira: { seconds: 1800, startedAt: new Date(afternoon.startMs + 1800000) }
    })
  })

  it("does not consume independent overlapping credit from another ticket", () => {
    const prepared = prepareProposal({ evidence, targets, request: {} })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([{
      ...held,
      ticketKey: "PROJ-2",
      clockifySeconds: evidence.credited,
      jiraSeconds: evidence.credited
    }])).toMatchObject({
      _tag: "Write",
      clockify: { seconds: evidence.credited },
      jira: { seconds: evidence.credited }
    })
  })

  it("writes the uncovered prefix when recorded time covers a block suffix", () => {
    const single = { ...evidence, credited: morning.seconds, blocks: [morning] }
    const prepared = prepareProposal({ evidence: single, targets, request: {} })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    const result = prepared.plan([{
      ticketKey: evidence.ticketKey,
      day: evidence.day,
      clockifySeconds: 1800,
      jiraSeconds: 1800,
      intervals: [
        { startMs: morning.startMs + 1800000, endMs: morning.endMs, source: "clockify" },
        { startMs: morning.startMs + 1800000, endMs: morning.endMs, source: "jira" }
      ]
    }])
    expect(result).toMatchObject({
      _tag: "Write",
      clockify: { seconds: 1800, startedAt: new Date(morning.startMs) },
      jira: { seconds: 1800, startedAt: new Date(morning.startMs) }
    })
  })

  it("withholds Jira gaps that are individually below its one-minute floor", () => {
    const short = { startMs: 0, endMs: 180000, seconds: 180 }
    const prepared = prepareProposal({
      evidence: { ...evidence, credited: short.seconds, blocks: [short] },
      targets: { clockify: false, jira: true },
      request: {}
    })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([{
      ticketKey: evidence.ticketKey,
      day: evidence.day,
      clockifySeconds: 0,
      jiraSeconds: 120,
      intervals: [{ startMs: 30000, endMs: 150000, source: "jira" }]
    }])).toEqual({ _tag: "BelowMinimum", minimumSeconds: 60 })
  })

  it("keeps separate Jira gaps when each satisfies its one-minute floor", () => {
    const split = { startMs: 0, endMs: 180000, seconds: 180 }
    const prepared = prepareProposal({
      evidence: { ...evidence, credited: split.seconds, blocks: [split] },
      targets: { clockify: false, jira: true },
      request: {}
    })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([{
      ticketKey: evidence.ticketKey,
      day: evidence.day,
      clockifySeconds: 0,
      jiraSeconds: 60,
      intervals: [{ startMs: 60000, endMs: 120000, source: "jira" }]
    }])).toMatchObject({
      _tag: "Write",
      jira: {
        seconds: 120,
        segments: [
          { seconds: 60, startedAt: new Date(0) },
          { seconds: 60, startedAt: new Date(120000) }
        ]
      }
    })
  })

  it("writes exact sub-minute Clockify credit without making a Jira worklog", () => {
    const short = { startMs: 0, endMs: 45000, seconds: 45 }
    const shortEvidence = { ...evidence, credited: 45, blocks: [short] }
    for (const selectedTargets of [{ clockify: true, jira: false }, { clockify: true, jira: true }]) {
      const prepared = prepareProposal({ evidence: shortEvidence, targets: selectedTargets, request: {} })
      expect(prepared._tag).toBe("Prepared")
      if (prepared._tag !== "Prepared") return
      expect(prepared.plan([])).toMatchObject({
        _tag: "Write",
        clockify: { seconds: 45, segments: [{ seconds: 45, startedAt: new Date(0) }] },
        jira: { seconds: 0, segments: [] }
      })
    }
    const jiraOnly = prepareProposal({ evidence: shortEvidence, targets: { clockify: false, jira: true }, request: {} })
    expect(jiraOnly._tag).toBe("Prepared")
    if (jiraOnly._tag === "Prepared") {
      expect(jiraOnly.plan([])).toEqual({ _tag: "BelowMinimum", minimumSeconds: 60 })
    }
  })

  it("keeps a Jira debt when every disjoint gap is below its floor", () => {
    const blocks = [
      { startMs: 0, endMs: 40000, seconds: 40 },
      { startMs: 120000, endMs: 160000, seconds: 40 }
    ]
    const prepared = prepareProposal({
      evidence: { ...evidence, credited: 80, blocks },
      targets,
      request: {}
    })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([])).toMatchObject({
      _tag: "Write",
      clockify: { seconds: 80, withheldSeconds: 0 },
      jira: { seconds: 0, withheldSeconds: 80 }
    })
  })

  // Naming every block still means the whole row, including provider-specific offsets.
  it("advances whole-row starts independently, with implicit or explicit full selection", () => {
    for (const blocks of [undefined, [1, 0, 1]]) {
      const prepared = prepareProposal({ evidence, targets, request: { blocks } })
      expect(prepared._tag).toBe("Prepared")
      if (prepared._tag !== "Prepared") return
      expect(prepared.plan([held])).toMatchObject({
        _tag: "Write",
        ticketKey: evidence.ticketKey,
        day: evidence.day,
        targets,
        clockify: { seconds: 3600, startedAt: new Date(afternoon.startMs) },
        jira: { seconds: 5400, startedAt: new Date(1800000) }
      })
      expect(prepared.provenance.amountSetByHand).toBe(false)
    }
  })

  // Resolve by both identity fields; neither another ticket nor another day is recorded credit.
  it("uses only the overridden ticket's day and honors explicit target scope", () => {
    const prepared = prepareProposal({
      evidence,
      targets,
      request: { ticketKey: "PROJ-2", targets: { clockify: false, jira: true } }
    })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    const result = prepared.plan([
      { ...held, clockifySeconds: 7200, jiraSeconds: 7200 },
      { ...held, ticketKey: "PROJ-2", day: "2026-07-02", jiraSeconds: 7200 },
      { ...held, ticketKey: "PROJ-2", jiraSeconds: 6300 }
    ])
    expect(result).toMatchObject({
      _tag: "Write",
      ticketKey: "PROJ-2",
      targets: { clockify: false, jira: true },
      clockify: { seconds: 0 },
      jira: { seconds: 900, startedAt: new Date(morning.startMs + 1800000) }
    })
    expect(prepared.provenance.ticketSetByHand).toBe(true)
  })

  // Refusals remain explicit and cannot be turned into empty writes by a caller.
  it("refuses unknown selections and an empty provider scope", () => {
    for (const blocks of [[], [2], [-1]]) {
      expect(prepareProposal({ evidence, targets, request: { blocks } })).toEqual({ _tag: "UnknownBlocks" })
    }
    expect(prepareProposal({ evidence, targets: { jira: false, clockify: false }, request: {} }))
      .toEqual({ _tag: "NoTargets" })
  })

  // The selected evidence and Jira's minute floor constrain requested time, even when the day has room.
  it("refuses amounts outside the selection while preserving Clockify's sub-minute room", () => {
    for (
      const [seconds, expected] of [
        [3601, { _tag: "PastEvidence", maxSeconds: 3600 }]
      ] satisfies ReadonlyArray<readonly [number, Exclude<ProposedWrite, { readonly _tag: "Write" }>]>
    ) {
      const prepared = prepareProposal({ evidence, targets, request: { blocks: [1], seconds } })
      expect(prepared._tag).toBe("Prepared")
      if (prepared._tag !== "Prepared") return
      expect(prepared.plan([])).toEqual(expected)
    }
    const prepared = prepareProposal({ evidence, targets, request: {} })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([{ ...held, clockifySeconds: 7141, jiraSeconds: 7200 }])).toMatchObject({
      _tag: "Write",
      clockify: { seconds: 59 },
      jira: { seconds: 0 }
    })
  })
})
