import { describe, expect, it } from "@effect/vitest"
import {
  clockifyWritten,
  entryDescription,
  jiraWritten,
  keepGoing,
  provenanceOf,
  type WriteOutcome,
  writeOutcomeLines
} from "../src/cli/agentWrite.js"

const outcome = (clockify: WriteOutcome["clockify"], jira: WriteOutcome["jira"]): WriteOutcome => ({ clockify, jira })

describe("provenanceOf", () => {
  it("says a transcript stands behind the amount only when one does", () => {
    expect(provenanceOf("session")).toBe("Reconciled from Claude Agent Session")
    expect(provenanceOf("session-adjusted")).toContain("amount set by hand")
    expect(provenanceOf("manual")).toBe("Entered by hand")
    expect(provenanceOf("manual")).not.toContain("Agent Session")
  })
})

describe("entryDescription", () => {
  it("defaults to the session origin", () => {
    expect(entryDescription({ note: null, summary: null })).toBe("Reconciled from Claude Agent Session")
  })

  it("carries the origin through into a described entry", () => {
    const description = entryDescription({
      note: "Traced the retry path",
      origin: "session-adjusted",
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
