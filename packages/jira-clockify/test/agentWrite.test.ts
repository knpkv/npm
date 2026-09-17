import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SessionProposal } from "../src/agent/sessions.js"
import {
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
    signal: "branch",
    blocks: [{ endMs: 2, seconds: 3600, startMs: 1 }],
    ticketKey: "PROJ-1"
  }

  /** Captures what each side was asked to write, so "not asked" is assertable rather than implied. */
  const fakeService = () => {
    const calls: Array<string> = []
    const starts: Array<Date | undefined> = []
    return {
      calls,
      starts,
      service: {
        applyToClockify: (
          ticketKey: string,
          _day: string,
          seconds: number,
          _description?: string,
          startedAt?: Date
        ) => {
          calls.push(`clockify ${ticketKey} ${seconds}`)
          starts.push(startedAt)
          return Effect.succeed(true)
        },
        applyToJira: (ticketKey: string, _day: string, seconds: number, _description?: string, startedAt?: Date) => {
          calls.push(`jira ${ticketKey} ${seconds}`)
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
      expect(outcome.clockify).toEqual({ _tag: "Written", seconds: 3600 })
      expect(outcome.jira).toEqual({ _tag: "Written", seconds: 3600 })
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

  it.effect("writes nowhere when neither side is asked for", () =>
    Effect.gen(function*() {
      const fake = fakeService()
      const outcome = yield* applyProposal(fake.service, proposal, "note", { clockify: false, jira: false })
      expect(fake.calls).toEqual([])
      expect(outcome).toEqual({ clockify: { _tag: "Skipped" }, jira: { _tag: "Skipped" } })
    }))
})
