import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { buildSessionProposals, type SessionProposal, type TicketDayCredit } from "../src/agent/sessions.js"
import * as SourceConsumption from "../src/agent/sourceConsumption.js"
import type { PlannedWrite } from "../src/agent/writePlanning.js"
import {
  applyPlannedWrite,
  applyProposal,
  asProposed,
  byHand,
  clockifyWritten,
  entryDescription,
  jiraWritten,
  keepGoing,
  provenanceText,
  type WriteOutcome,
  writeOutcomeLines
} from "../src/cli/agentWrite.js"
import type { JiraWorklogOutcome } from "../src/services/TimerService.js"

const outcome = (clockify: WriteOutcome["clockify"], jira: WriteOutcome["jira"]): WriteOutcome => ({ clockify, jira })

describe("provenanceText", () => {
  it("cites the evidence when nothing was overruled", () => {
    expect(provenanceText(asProposed)).toBe("Reconciled from Claude Agent Session")
  })

  it("names each part a person chose", () => {
    expect(provenanceText({ ...asProposed, amountSetByHand: true }))
      .toBe("Reconciled from Claude Agent Session, amount set by hand")
    expect(provenanceText({ ...asProposed, ticketSetByHand: true }))
      .toBe("Reconciled from Claude Agent Session, ticket set by hand")
    expect(provenanceText({ amountSetByHand: true, evidence: "session", ticketSetByHand: true }))
      .toBe("Reconciled from Claude Agent Session, amount and ticket set by hand")
  })

  it("claims no evidence for time no session evidences", () => {
    expect(provenanceText(byHand)).toBe("Entered by hand")
    expect(provenanceText(byHand)).not.toContain("Agent Session")
  })
})

describe("entryDescription", () => {
  it("defaults to the session origin", () => {
    expect(entryDescription({ note: null, summary: null })).toBe("Reconciled from Claude Agent Session")
  })

  it("carries the provenance through into a described entry", () => {
    const description = entryDescription({
      note: "Traced the retry path",
      provenance: { ...asProposed, amountSetByHand: true },
      summary: "Add OTEL spans"
    })
    expect(description).toBe(
      "Add OTEL spans — Traced the retry path (Reconciled from Claude Agent Session, amount set by hand)"
    )
  })
})

describe("writeOutcomeLines", () => {
  it("reports each side that acted", () => {
    expect(writeOutcomeLines(outcome({ _tag: "Written", seconds: 600 }, { _tag: "Written", seconds: 600 })))
      .toEqual(["✓ created Clockify entry", "✓ posted to Jira"])
  })

  it("says nothing about a side that owed nothing", () => {
    expect(writeOutcomeLines(outcome({ _tag: "NothingOwed" }, { _tag: "Written", seconds: 600 })))
      .toEqual(["✓ posted to Jira"])
  })

  it("names the reason a side refused", () => {
    expect(writeOutcomeLines(outcome({ _tag: "Refused", message: "rate limited" }, { _tag: "NothingOwed" })))
      .toEqual(["✗ Clockify: rate limited"])
  })

  it("tells the user how to log in again", () => {
    const lines = writeOutcomeLines(outcome({ _tag: "Written", seconds: 600 }, { _tag: "NotLoggedIn" }))
    expect(lines[1]).toContain("jcf auth jira login")
  })
})

describe("keepGoing", () => {
  it("stops the run only for an expired Jira session", () => {
    expect(keepGoing(outcome({ _tag: "NothingOwed" }, { _tag: "NotLoggedIn" }))).toBe(false)
    // A refusal about this row says nothing about the next one.
    expect(
      keepGoing(outcome({ _tag: "Refused", message: "rate limited" }, { _tag: "Refused", message: "no such issue" }))
    )
      .toBe(true)
  })
})

describe("written seconds", () => {
  it("counts only what a side actually took", () => {
    const partial = outcome({ _tag: "Written", seconds: 900 }, { _tag: "Refused", message: "no such issue" })
    expect(clockifyWritten(partial)).toBe(900)
    expect(jiraWritten(partial)).toBe(0)
  })
})

describe("segmented writes", () => {
  const block = (startMs: number): PlannedWrite["jira"]["segments"][number]["block"] => ({
    startMs,
    endMs: startMs + 60000,
    seconds: 60
  })
  const plan: PlannedWrite = {
    _tag: "Write",
    ticketKey: "PROJ-1",
    day: "2026-07-01",
    targets: { clockify: false, jira: true },
    clockify: { seconds: 0, startedAt: undefined, segments: [] },
    jira: {
      seconds: 120,
      startedAt: new Date(0),
      segments: [
        { block: block(0), seconds: 60, startedAt: new Date(0) },
        { block: block(120000), seconds: 60, startedAt: new Date(120000) }
      ]
    }
  }

  it.effect("keeps successful segments visible when a later Jira segment loses authentication", () =>
    Effect.gen(function*() {
      let calls = 0
      const descriptions: Array<string | undefined> = []
      const result = yield* applyPlannedWrite(
        {
          applyToClockify: () => Effect.succeed(true),
          applyToJira: (_ticketKey, _day, _seconds, description) => {
            descriptions.push(description)
            return Effect.succeed<JiraWorklogOutcome>(
              calls++ === 0 ? { _tag: "Posted" } : { _tag: "NotLoggedIn" }
            )
          }
        },
        plan,
        "note"
      )

      expect(result.jira).toMatchObject({
        _tag: "PartiallyWritten",
        seconds: 60,
        failure: { _tag: "NotLoggedIn" }
      })
      expect(jiraWritten(result)).toBe(60)
      expect(keepGoing(result)).toBe(false)
      expect(writeOutcomeLines(result)).toEqual([
        "· Clockify not asked for",
        "✓ posted 1m 0s to Jira",
        expect.stringContaining("jcf auth jira login")
      ])
      expect(descriptions).toEqual(["note", "note"])
      expect(descriptions.flatMap((description) => SourceConsumption.markers(description ?? ""))).toEqual([])
    }))
})

describe("applyProposal targets", () => {
  const proposal: SessionProposal = {
    activeSeconds: 3600,
    clockifyDelta: 3600,
    clockifySeconds: 0,
    confidence: null,
    day: "2026-07-01",
    jiraDelta: 3600,
    jiraSeconds: 0,
    sessionIds: ["s1"],
    sessionSeconds: 3600,
    sourceStartMs: 0,
    settlementEndMs: 3600000,
    signal: "branch",
    blocks: [{ endMs: 3600000, seconds: 3600, startMs: 0 }],
    ticketKey: "PROJ-1"
  }

  /** Captures what each side was asked to write, so "not asked" is assertable rather than implied. */
  const fakeService = () => {
    const calls: Array<string> = []
    const descriptions: Array<string | undefined> = []
    const starts: Array<Date | undefined> = []
    return {
      calls,
      descriptions,
      starts,
      service: {
        applyToClockify: (
          ticketKey: string,
          _day: string,
          seconds: number,
          description?: string,
          startedAt?: Date
        ) => {
          calls.push(`clockify ${ticketKey} ${seconds}`)
          descriptions.push(description)
          starts.push(startedAt)
          return Effect.succeed(true)
        },
        applyToJira: (ticketKey: string, _day: string, seconds: number, description?: string, startedAt?: Date) => {
          calls.push(`jira ${ticketKey} ${seconds}`)
          descriptions.push(description)
          starts.push(startedAt)
          return Effect.succeed<JiraWorklogOutcome>({ _tag: "Posted" })
        }
      }
    }
  }

  // CLI/watch own their deltas; execution retains sub-minute amounts and per-provider offsets.
  it.effect("preserves CLI/watch deltas and independent whole-row anchors", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      yield* applyProposal(fake.service, {
        ...proposal,
        blocks: [
          { startMs: 0, endMs: 3600000, seconds: 3600 },
          { startMs: 18000000, endMs: 21600000, seconds: 3600 }
        ],
        sessionSeconds: 7200,
        clockifySeconds: 3600,
        jiraSeconds: 1800,
        recordedIntervals: [
          { source: "clockify", startMs: 0, endMs: 3600000 },
          { source: "jira", startMs: 0, endMs: 1800000 }
        ],
        clockifyDelta: 30,
        jiraDelta: 900
      }, "note")
      expect(fake.calls).toEqual(["clockify PROJ-1 30", "jira PROJ-1 900"])
      expect(fake.starts).toEqual([new Date(18000000), new Date(1800000)])
    }))

  it.effect("writes both sides by default", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const outcome = yield* applyProposal(fake.service, proposal, "note")
      expect(fake.calls).toEqual(["clockify PROJ-1 3600", "jira PROJ-1 3600"])
      const marker = SourceConsumption.marker("2026-07-01:PROJ-1", 0)
      expect(fake.descriptions).toEqual([`note\n${marker}`, `note\n${marker}`])
      expect(outcome.clockify).toMatchObject({ _tag: "Written", seconds: 3600 })
      expect(outcome.jira).toMatchObject({ _tag: "Written", seconds: 3600 })
    }))

  it.effect("leaves a side alone when it is not asked for, and says so", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const outcome = yield* applyProposal(fake.service, proposal, "note", { clockify: false, jira: true })
      expect(fake.calls).toEqual(["jira PROJ-1 3600"])
      // Not `NothingOwed`: the Clockify gap is still there, and next time it may be asked for.
      expect(outcome.clockify).toEqual({ _tag: "Skipped" })
      expect(writeOutcomeLines(outcome)).toEqual(["· Clockify not asked for", "✓ posted to Jira"])
    }))

  it.effect("starts after a source block already consumed under a corrected ticket", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const later = 18000000
      yield* applyProposal(fake.service, {
        ...proposal,
        blocks: [
          {
            startMs: 0,
            endMs: 3600000,
            seconds: 3600,
            clockifyConsumedSeconds: 3600,
            jiraConsumedSeconds: 3600
          },
          { startMs: later, endMs: later + 3600000, seconds: 3600 }
        ],
        sessionSeconds: 7200,
        clockifyDelta: 3600,
        jiraDelta: 3600
      }, "note")
      expect(fake.calls).toEqual(["clockify PROJ-1 3600", "jira PROJ-1 3600"])
      expect(fake.starts).toEqual([new Date(later), new Date(later)])
    }))

  it.effect("allocates ordinary recorded time after corrected source capacity", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const later = 18000000
      yield* applyProposal(fake.service, {
        ...proposal,
        blocks: [
          {
            startMs: 0,
            endMs: 3600000,
            seconds: 3600,
            clockifyConsumedSeconds: 3600,
            jiraConsumedSeconds: 3600
          },
          { startMs: later, endMs: later + 3600000, seconds: 3600 }
        ],
        sessionSeconds: 7200,
        activeSeconds: 7200,
        clockifySeconds: 1800,
        jiraSeconds: 1800,
        recordedIntervals: [
          { source: "clockify", startMs: later, endMs: later + 1800000 },
          { source: "jira", startMs: later, endMs: later + 1800000 }
        ],
        clockifyDelta: 1800,
        jiraDelta: 1800
      }, "note")
      expect(fake.calls).toEqual(["clockify PROJ-1 1800", "jira PROJ-1 1800"])
      expect(fake.starts).toEqual([new Date(later + 1800000), new Date(later + 1800000)])
    }))

  it.effect("starts after adjacent ordinary and corrected coverage on both providers", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const block = { startMs: 0, endMs: 3600000, seconds: 3600, sourceStartMs: 0 }
      const sources: ReadonlyArray<"clockify" | "jira"> = ["clockify", "jira"]
      const credits: ReadonlyArray<TicketDayCredit> = [{
        activeSeconds: 3600,
        blocks: [block],
        confidence: null,
        day: "2026-07-01",
        seconds: 3600,
        sessionIds: ["s1"],
        settlementEndMs: 3600000,
        signal: "branch",
        sourceStartMs: 0,
        ticketKey: "PROJ-1"
      }]
      const correctedStartMs = 600000
      const proposals = buildSessionProposals(credits, [
        {
          clockifySeconds: 600,
          day: "2026-07-01",
          intervals: sources.map((source) => ({ source, startMs: 0, endMs: correctedStartMs })),
          jiraSeconds: 600,
          ticketKey: "PROJ-1"
        },
        {
          clockifySeconds: 600,
          day: "2026-07-01",
          intervals: sources.map((source) => ({
            entry: {
              description: SourceConsumption.marker("2026-07-01:PROJ-1", 0),
              endMs: correctedStartMs + 600000,
              id: `${source}-corrected`,
              source,
              startMs: correctedStartMs
            }
          })),
          jiraSeconds: 600,
          ticketKey: "PROJ-2"
        }
      ], { excludedDays: [], minimumSeconds: 60 })
      const proposal = proposals[0]!
      expect(proposal).toMatchObject({ clockifyDelta: 2400, jiraDelta: 2400 })

      yield* applyProposal(fake.service, proposal, "note")
      expect(fake.calls).toEqual(["clockify PROJ-1 2400", "jira PROJ-1 2400"])
      expect(fake.starts).toEqual([new Date(1200000), new Date(1200000)])
    }))

  it.effect("uses provider intervals when an afternoon block was recorded first", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const later = 18000000
      yield* applyProposal(fake.service, {
        ...proposal,
        blocks: [
          { startMs: 0, endMs: 3600000, seconds: 3600 },
          { startMs: later, endMs: later + 3600000, seconds: 3600 }
        ],
        sessionSeconds: 7200,
        activeSeconds: 7200,
        clockifySeconds: 3600,
        jiraSeconds: 3600,
        clockifyDelta: 3600,
        jiraDelta: 3600,
        recordedIntervals: [
          { source: "clockify", startMs: later, endMs: later + 3600000 },
          { source: "jira", startMs: later, endMs: later + 3600000 }
        ]
      }, "note")
      expect(fake.calls).toEqual(["clockify PROJ-1 3600", "jira PROJ-1 3600"])
      expect(fake.starts).toEqual([new Date(0), new Date(0)])
    }))

  it.effect("keeps disjoint activity in separate provider entries", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const later = 18000000
      yield* applyProposal(fake.service, {
        ...proposal,
        blocks: [
          { startMs: 0, endMs: 3600000, seconds: 3600 },
          { startMs: later, endMs: later + 3600000, seconds: 3600 }
        ],
        sessionSeconds: 7200,
        activeSeconds: 7200,
        clockifyDelta: 7200,
        jiraDelta: 7200
      }, "note")
      expect(fake.calls).toEqual([
        "clockify PROJ-1 3600",
        "clockify PROJ-1 3600",
        "jira PROJ-1 3600",
        "jira PROJ-1 3600"
      ])
      expect(fake.starts).toEqual([new Date(0), new Date(later), new Date(0), new Date(later)])
    }))

  it.effect("withholds a corrected Jira remainder below its one-minute floor", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const later = 180000
      const outcome = yield* applyProposal(
        fake.service,
        {
          ...proposal,
          blocks: [
            { startMs: 0, endMs: 120000, seconds: 120, jiraConsumedSeconds: 90 },
            { startMs: later, endMs: later + 60000, seconds: 60 }
          ],
          sessionSeconds: 180,
          activeSeconds: 180,
          clockifyDelta: 0,
          jiraDelta: 90
        },
        "note",
        { clockify: false, jira: true }
      )
      expect(fake.calls).toEqual(["jira PROJ-1 60"])
      expect(fake.starts).toEqual([new Date(later)])
      expect(outcome.jira).toMatchObject({ _tag: "PartiallyWritten", seconds: 60 })
    }))

  it.effect("withholds a sub-minute Jira tail introduced while capping against day totals", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const blocks = [
        { startMs: 0, endMs: 60000, seconds: 60, sourceStartMs: 0 },
        { startMs: 120000, endMs: 180000, seconds: 60, sourceStartMs: 120000 },
        { startMs: 240000, endMs: 330000, seconds: 90, sourceStartMs: 240000 }
      ]
      const credits: ReadonlyArray<TicketDayCredit> = [{
        activeSeconds: 210,
        blocks,
        confidence: null,
        day: "2026-07-01",
        seconds: 210,
        sessionIds: ["s1"],
        settlementEndMs: 330000,
        signal: "branch",
        sourceStartMs: 0,
        ticketKey: "PROJ-1"
      }]
      const proposals = buildSessionProposals(credits, [
        {
          clockifySeconds: 0,
          day: "2026-07-01",
          intervals: [{ source: "jira", startMs: 360000, endMs: 420000 }],
          jiraSeconds: 60,
          ticketKey: "PROJ-1"
        }
      ], { excludedDays: [], minimumSeconds: 60, sides: { clockify: false, jira: true } })
      const proposal = proposals[0]!
      expect(proposal.jiraDelta).toBe(150)

      const outcome = yield* applyProposal(fake.service, proposal, "note", { clockify: false, jira: true })
      expect(fake.calls).toEqual(["jira PROJ-1 60", "jira PROJ-1 60"])
      expect(outcome.jira).toMatchObject({
        _tag: "PartiallyWritten",
        seconds: 120,
        failure: { _tag: "Refused" }
      })
    }))

  it.effect("keeps three one-minute Jira segments fully writable", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const outcome = yield* applyProposal(
        fake.service,
        {
          ...proposal,
          activeSeconds: 180,
          blocks: [
            { startMs: 0, endMs: 60000, seconds: 60 },
            { startMs: 120000, endMs: 180000, seconds: 60 },
            { startMs: 240000, endMs: 300000, seconds: 60 }
          ],
          clockifyDelta: 0,
          jiraDelta: 180,
          sessionSeconds: 180,
          settlementEndMs: 300000
        },
        "note",
        { clockify: false, jira: true }
      )
      expect(fake.calls).toEqual(["jira PROJ-1 60", "jira PROJ-1 60", "jira PROJ-1 60"])
      expect(outcome.jira).toMatchObject({ _tag: "Written", seconds: 180 })
    }))

  it.effect("refuses rather than reporting nothing owed when every Jira segment is sub-minute", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const outcome = yield* applyProposal(
        fake.service,
        {
          ...proposal,
          blocks: [
            { startMs: 0, endMs: 50000, seconds: 50 },
            { startMs: 180000, endMs: 220000, seconds: 40 }
          ],
          sessionSeconds: 90,
          activeSeconds: 90,
          clockifyDelta: 0,
          jiraDelta: 90
        },
        "note",
        { clockify: false, jira: true }
      )
      expect(fake.calls).toEqual([])
      expect(outcome.jira).toMatchObject({ _tag: "Refused" })
    }))

  it.effect("writes nowhere when neither side is asked for", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const outcome = yield* applyProposal(fake.service, proposal, "note", { clockify: false, jira: false })
      expect(fake.calls).toEqual([])
      expect(outcome).toEqual({ clockify: { _tag: "Skipped" }, jira: { _tag: "Skipped" } })
    }))
})
