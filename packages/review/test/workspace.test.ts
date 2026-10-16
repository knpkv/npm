import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Severity } from "../src/guide/model.js"
import { reviewSeverityOrder, ReviewWorkspace } from "../src/workspace.js"

const identity = {
  namespace: "codecommit",
  subjectId: "pr-35",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
const finding = {
  id: "finding-1",
  source: "agent",
  resolved: false,
  anchor: { _tag: "Line", path: "src/main.ts", line: 42, side: "after", outdated: false },
  messages: [],
  finding: {
    severity: "P0",
    axis: "Security",
    confidence: "high",
    claim: "A draft crosses the agent boundary",
    summary: null,
    why: "The storage key omits the selected agent.",
    recommendation: "Include the agent identity in the key.",
    verification: "Switch agents while a draft is open.",
    requirement: null,
    patch: { path: "src/main.ts", headRevision: "head-1", text: "- key\n+ agentKey" },
    disposition: { _tag: "Open" }
  }
}
const workspace = {
  identity,
  observedAt: 1_000,
  run: {
    _tag: "Ready",
    run: {
      id: "run-1",
      identity,
      profile: null,
      kind: "security",
      completedAt: 900,
      summary: "Fix the draft identity before merging.",
      explanation: null,
      risks: ["A draft can appear under another agent."],
      focus: null,
      rules: ["AGENTS.md"],
      threads: [finding]
    }
  },
  conversations: { _tag: "Unavailable", reason: "not_cached" },
  checks: { _tag: "Unknown" }
}
const decode = Schema.decodeUnknownResult(ReviewWorkspace, { onExcessProperty: "error" })

describe("review workspace contracts", () => {
  it("refuses timestamps beyond the Date/Intl range before they reach a read view", () => {
    expect(decode({ ...workspace, observedAt: 8_640_000_000_000_000 })._tag).toBe("Success")
    expect(decode({ ...workspace, observedAt: 8_640_000_000_000_001 })._tag).toBe("Failure")
    expect(
      decode({
        ...workspace,
        run: {
          ...workspace.run,
          run: {
            ...workspace.run.run,
            completedAt: 8_640_000_000_000_001
          }
        }
      })._tag
    ).toBe("Failure")
  })
  it("accepts P0 and keeps the shipped P4 severity", () => {
    expect(Schema.decodeUnknownResult(Severity)("P0")._tag).toBe("Success")
    expect(decode(workspace)._tag).toBe("Success")
    expect(
      decode({
        ...workspace,
        run: {
          ...workspace.run,
          run: { ...workspace.run.run, threads: [{ ...finding, finding: { ...finding.finding, severity: "P4" } }] }
        }
      })._tag
    ).toBe("Success")
    expect(reviewSeverityOrder).toEqual(["P0", "P1", "P2", "P3", "P4"])
  })

  it("refuses a patch for another reviewed head or file", () => {
    for (
      const patch of [
        { ...finding.finding.patch, headRevision: "head-2" },
        { ...finding.finding.patch, path: "src/other.ts" }
      ]
    ) {
      expect(
        decode({
          ...workspace,
          run: {
            ...workspace.run,
            run: { ...workspace.run.run, threads: [{ ...finding, finding: { ...finding.finding, patch } }] }
          }
        })._tag
      ).toBe("Failure")
    }
  })

  it("keeps stale review identity separate from the current PR identity", () => {
    expect(decode({ ...workspace, identity: { ...identity, headRevision: "head-2" } })._tag).toBe("Success")
  })

  it("refuses duplicate thread identities and a dismissed finding without a reason", () => {
    expect(
      decode({ ...workspace, run: { ...workspace.run, run: { ...workspace.run.run, threads: [finding, finding] } } })
        ._tag
    ).toBe("Failure")
    expect(
      decode({
        ...workspace,
        run: {
          ...workspace.run,
          run: {
            ...workspace.run.run,
            threads: [{
              ...finding,
              finding: {
                ...finding.finding,
                disposition: { _tag: "Dismissed", note: null }
              }
            }]
          }
        }
      })._tag
    ).toBe("Failure")
  })

  it("keeps absent checks and conversation unknown, rather than claiming zero or clean", () => {
    const result = decode({ ...workspace, run: { _tag: "NotRecorded" } })
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success.checks._tag).toBe("Unknown")
      expect(result.success.conversations._tag).toBe("Unavailable")
      expect(result.success.run._tag).toBe("NotRecorded")
    }
  })

  it("refuses credentials and arbitrary fields at the persisted/wire boundary", () => {
    expect(decode({ ...workspace, token: "secret" })._tag).toBe("Failure")
    expect(decode({ ...workspace, identity: { ...identity, accountId: "private-coordinate" } })._tag).toBe("Failure")
  })
})
