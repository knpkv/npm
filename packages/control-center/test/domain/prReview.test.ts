import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  derivePrReviewOutcome,
  MAXIMUM_PR_REVIEW_REPORT_BYTES,
  PrReviewPrevention,
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
  targetFile: "packages/control-center/test/persistence/agent-job-repository.test.ts",
  sourcePaths: ["packages/control-center/src/server/persistence/repositories/agentJobRepository.ts"],
  matcherOrInvariant: "A review result and its terminal job state commit under the same active lease.",
  invalidFixture: "completeReview({ leaseToken: staleLease })",
  validFixture: "completeReview({ leaseToken: activeLease })",
  boundary: "Only durable PR-review jobs are covered; provider and sandbox contracts stay separate."
})

const suggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
  suggestionId: `sha256:${"1".repeat(64)}`,
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
  confidence: {
    level: "high",
    reason: "The persistence boundary is directly observable."
  },
  prevention
})

const report = Schema.decodeUnknownSync(PrReviewReport)({
  schemaVersion: 2,
  subject,
  completion: { status: "complete" },
  suggestions: [suggestion]
})

describe("PR review domain", () => {
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
  })
})
