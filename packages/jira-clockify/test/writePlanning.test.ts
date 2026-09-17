import { describe, expect, it } from "@effect/vitest"
import { prepareProposal, type ProposedWrite } from "../src/agent/writePlanning.js"

const morning = { startMs: 0, endMs: 3600000, seconds: 3600 }
const afternoon = { startMs: 18000000, endMs: 21600000, seconds: 3600 }
const evidence = { ticketKey: "PROJ-1", day: "2026-07-01", credited: 7200, blocks: [morning, afternoon] }
const targets = { clockify: true, jira: true }
const held = { ticketKey: evidence.ticketKey, day: evidence.day, clockifySeconds: 3600, jiraSeconds: 1800 }

describe("confirmation planning", () => {
  // The same selection has independent sizing and anchoring semantics: existing morning time
  // reduces the day's room but cannot move a deliberately selected afternoon start.
  it("sizes a deduplicated subset against each provider and keeps its own start", () => {
    const prepared = prepareProposal({ evidence, targets, request: { blocks: [1, 1], seconds: 2400 } })
    expect(prepared._tag).toBe("Prepared")
    if (prepared._tag !== "Prepared") return
    expect(prepared.plan([{ ...held, clockifySeconds: 6300 }])).toEqual({
      _tag: "Write",
      ticketKey: evidence.ticketKey,
      day: evidence.day,
      targets,
      clockify: { seconds: 900, startedAt: new Date(afternoon.startMs) },
      jira: { seconds: 2400, startedAt: new Date(afternoon.startMs) }
    })
    expect(prepared.provenance).toEqual({ evidence: "session", amountSetByHand: true, ticketSetByHand: false })
  })

  // Naming every block still means the whole row, including provider-specific offsets.
  it("advances whole-row starts independently, with implicit or explicit full selection", () => {
    for (const blocks of [undefined, [1, 0, 1]]) {
      const prepared = prepareProposal({ evidence, targets, request: { blocks } })
      expect(prepared._tag).toBe("Prepared")
      if (prepared._tag !== "Prepared") return
      expect(prepared.plan([held])).toEqual({
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
      jira: { seconds: 900, startedAt: new Date(afternoon.startMs + 2700000) }
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

  // The selected evidence and minute floor constrain requested time, even when the day has room.
  it("refuses amounts outside the selection and drops sub-minute provider gaps", () => {
    for (
      const [seconds, expected] of [
        [3601, { _tag: "PastEvidence", maxSeconds: 3600 }],
        [59, { _tag: "BelowMinimum", minimumSeconds: 60 }]
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
    expect(prepared.plan([{ ...held, clockifySeconds: 7141, jiraSeconds: 7200 }])).toEqual({ _tag: "NothingOwed" })
  })
})
