import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  derivePrReviewOutcome,
  MAXIMUM_PR_REVIEW_REPORT_BYTES,
  PrReviewNote,
  PrReviewPrevention,
  PrReviewRelatedLocation,
  PrReviewReport,
  PrReviewSubject,
  PrReviewSuggestion
} from "../../src/domain/prReview.js"

const subject = Schema.decodeUnknownSync(PrReviewSubject)({
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "276",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
})

const prevention = Schema.decodeUnknownSync(PrReviewPrevention)({
  summary: "Protect active-lease review completion.",
  enforcement: "test",
  existingRuleOrConfig: "agent job repository integration suite",
  recurrenceEvidence: "The same active-lease boundary is used by completion and retry transitions.",
  targetFile: "packages/control-center/test/persistence/agent-job-repository.test.ts",
  sourcePaths: ["packages/control-center/src/server/persistence/repositories/agentJobRepository.ts"],
  matcherOrInvariant: "A review result and its terminal job state commit under the same active lease.",
  invalidFixture: "completeReview({ leaseToken: staleLease })",
  validFixture: "completeReview({ leaseToken: activeLease })",
  boundary: "Only durable PR-review jobs are covered; provider and sandbox contracts stay separate."
})

const suggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
  suggestionId: `sha256:${"1".repeat(64)}`,
  state: "draft",
  title: "Decode review output before persistence",
  severity: "P2",
  problem: "Review output must cross a typed boundary.",
  impact: "Malformed review output could otherwise enter durable state.",
  evidence: {
    path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
    startLine: 42,
    endLine: 45,
    excerpt: "const report = decodeReviewOutput(output)"
  },
  recommendation: "Decode the complete report before committing any model-authored result.",
  anchor: {
    _tag: "line",
    path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
    line: 42
  },
  relatedLocations: [],
  confidence: {
    level: "high",
    reason: "The persistence boundary is directly observable."
  },
  prevention
})

const report = Schema.decodeUnknownSync(PrReviewReport)({
  schemaVersion: 3,
  subject,
  completion: { status: "complete" },
  suggestions: [suggestion],
  notes: []
})

describe("PR review domain", () => {
  it("rejects pre-stable schema v2 reports instead of guessing a migration", () => {
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PrReviewReport)({
          ...report,
          schemaVersion: 2
        })
      )
    )
  })

  it("keeps file anchors on their exact evidence path while allowing whole-change grouping", () => {
    assert.isFalse(
      Schema.is(PrReviewSuggestion)({
        ...suggestion,
        anchor: {
          _tag: "file",
          path: "packages/control-center/src/server/agent/OtherFile.ts",
          line: 1,
          relativeFileVersion: "AFTER"
        }
      })
    )
    assert.isTrue(
      Schema.is(PrReviewSuggestion)({
        ...suggestion,
        anchor: {
          _tag: "file",
          path: suggestion.evidence.path,
          line: 1,
          relativeFileVersion: "AFTER"
        }
      })
    )
    assert.isTrue(
      Schema.is(PrReviewSuggestion)({
        ...suggestion,
        anchor: { _tag: "changes" }
      })
    )
  })

  it("rejects reversed related-location ranges while retaining equal and increasing ranges", () => {
    const location = {
      path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
      startLine: 10,
      endLine: 10,
      label: "Same root cause"
    }
    assert.isTrue(Schema.is(PrReviewRelatedLocation)(location))
    assert.isTrue(Schema.is(PrReviewRelatedLocation)({ ...location, endLine: 12 }))
    assert.isFalse(Schema.is(PrReviewRelatedLocation)({ ...location, endLine: 9 }))
  })

  it("retains suggestion scope, grouped locations, exact replacement patches, and non-publishable notes", () => {
    const richSuggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
      ...suggestion,
      title: "Authorize before writing durable state",
      anchor: {
        _tag: "file",
        path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
        line: 40
      },
      relatedLocations: [{
        path: "packages/control-center/test/agent/agent-job-worker.test.ts",
        startLine: 529,
        endLine: 529,
        label: "Nearby regression coverage"
      }],
      replacement: {
        reviewedHead: subject.headRevision,
        unifiedDiff: [
          "--- a/packages/control-center/src/server/agent/AgentJobWorker.ts",
          "+++ b/packages/control-center/src/server/agent/AgentJobWorker.ts",
          "@@ -42,1 +42,2 @@",
          "+yield* authorize()",
          " const report = decodeReviewOutput(output)"
        ].join("\n"),
        explanation: "Make the authority check explicit before the durable write."
      }
    })
    const note = Schema.decodeUnknownSync(PrReviewNote)({
      noteId: `sha256:${"2".repeat(64)}`,
      reason: "low-confidence",
      title: "A provider retry may obscure the first failure",
      observation: "The retry path needs a provider-backed reproduction before this can become a suggestion.",
      confidence: {
        level: "low",
        reason: "Static control-flow evidence is incomplete."
      },
      location: {
        path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
        startLine: 80,
        endLine: 80
      }
    })
    const richReport = Schema.decodeUnknownSync(PrReviewReport)({
      ...report,
      suggestions: [richSuggestion],
      notes: [note]
    })

    assert.strictEqual(richReport.suggestions[0]?.anchor._tag, "file")
    assert.strictEqual(richReport.suggestions[0]?.relatedLocations.length, 1)
    assert.strictEqual(richReport.suggestions[0]?.replacement?.reviewedHead, subject.headRevision)
    assert.strictEqual(richReport.notes[0]?.reason, "low-confidence")
  })

  it("derives the browser outcome instead of accepting a model-authored verdict", () => {
    assert.strictEqual(derivePrReviewOutcome(report), "changes-required")
    assert.strictEqual(
      derivePrReviewOutcome({
        ...report,
        suggestions: [{ ...suggestion, severity: "P4" }]
      }),
      "non-blocking-suggestions"
    )
    assert.strictEqual(derivePrReviewOutcome({ ...report, suggestions: [] }), "no-issues-found")
    assert.strictEqual(
      derivePrReviewOutcome({
        ...report,
        suggestions: [{ ...suggestion, state: "resolved" }]
      }),
      "no-issues-found"
    )
    assert.strictEqual(
      derivePrReviewOutcome({
        ...report,
        completion: { status: "unable-to-conclude", reason: "Build dependency unavailable." },
        suggestions: []
      }),
      "unable-to-conclude"
    )
    assert.isFalse(
      "verdict" in Schema.decodeUnknownSync(PrReviewReport)({
        ...report,
        verdict: "approve"
      })
    )
  })

  it("rejects traversal, absolute, backslash, and control-character evidence paths", () => {
    for (
      const path of [
        "../secrets.env",
        "src/../../secrets.env",
        "/etc/passwd",
        "C:/Windows/system.ini",
        String.raw`src\escape.ts`,
        "src/\u0000escape.ts"
      ]
    ) {
      assert.isTrue(
        Result.isFailure(
          Schema.decodeUnknownResult(PrReviewReport)({
            ...report,
            suggestions: [{
              ...suggestion,
              evidence: { ...suggestion.evidence, path }
            }]
          })
        ),
        path
      )
    }
  })

  it("rejects duplicate host-derived suggestion identifiers", () => {
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PrReviewReport)({
          ...report,
          suggestions: [
            suggestion,
            { ...suggestion, problem: "A second suggestion with the same identity." }
          ]
        })
      )
    )
  })

  it("has no suggestion-count cap below the durable byte envelope", () => {
    const suggestions = Array.from({ length: 13 }, (_, index) => ({
      ...suggestion,
      suggestionId: `sha256:${index.toString(16).padStart(64, "0")}`,
      problem: `Problem ${String(index)}`
    }))
    const many = { ...report, suggestions }

    assert.isBelow(
      new TextEncoder().encode(JSON.stringify(many)).byteLength,
      MAXIMUM_PR_REVIEW_REPORT_BYTES
    )
    assert.isTrue(Schema.is(PrReviewReport)(many))
  })

  it("rejects only the aggregate durable-byte overflow", () => {
    const oversized = {
      ...report,
      suggestions: Array.from({ length: 16 }, (_, index) => ({
        ...suggestion,
        suggestionId: `sha256:${index.toString(16).padStart(64, "0")}`,
        impact: `${String(index)}-${"x".repeat(3_900)}`
      }))
    }

    assert.isAbove(
      new TextEncoder().encode(JSON.stringify(oversized)).byteLength,
      MAXIMUM_PR_REVIEW_REPORT_BYTES
    )
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PrReviewReport)(oversized)))
  })

  it("retains independently validated suggestions while deriving an inconclusive outcome", () => {
    const incomplete = Schema.decodeUnknownSync(PrReviewReport)({
      ...report,
      completion: {
        status: "unable-to-conclude",
        reason: "Build dependency unavailable."
      }
    })
    assert.strictEqual(incomplete.suggestions.length, 1)
    assert.strictEqual(derivePrReviewOutcome(incomplete), "unable-to-conclude")
  })

  it("requires implementation-ready prevention fixtures when enforcement is proposed", () => {
    assert.isFalse(
      Schema.is(PrReviewSuggestion)({
        ...suggestion,
        prevention: { ...prevention, validFixture: "completeReview({ leaseToken: staleLease })" }
      })
    )
    assert.isTrue(
      Schema.is(PrReviewSuggestion)({
        ...suggestion,
        prevention: { ...prevention, enforcement: "ESLint" }
      })
    )
    assert.isFalse(
      Schema.is(PrReviewSuggestion)({
        ...suggestion,
        prevention: { ...prevention, enforcement: "eslint" }
      })
    )
    assert.isFalse(
      Schema.is(PrReviewSuggestion)({
        ...suggestion,
        severity: "P3"
      })
    )
  })
})
