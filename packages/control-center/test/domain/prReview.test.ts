import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"

import {
  MAXIMUM_PR_REVIEW_FINDINGS,
  MAXIMUM_PR_REVIEW_REPORT_BYTES,
  PrReviewFinding,
  PrReviewReport,
  PrReviewSubject
} from "../../src/domain/prReview.js"

const subject = Schema.decodeUnknownSync(PrReviewSubject)({
  providerId: "codecommit",
  repository: "control-center",
  pullRequestId: "212",
  baseRevision: "1".repeat(40),
  headRevision: "2".repeat(40)
})

const prevention = {
  summary: "Protect active-lease review completion.",
  enforcement: "test",
  existingRuleOrConfig: "agent job repository integration suite",
  targetFile: "packages/control-center/test/persistence/agent-job-repository.test.ts",
  sourcePaths: ["packages/control-center/src/server/persistence/repositories/agentJobRepository.ts"],
  matcherOrInvariant: "A review result and its terminal job state commit under the same active lease.",
  invalidFixture: "completeReview({ leaseToken: staleLease })",
  validFixture: "completeReview({ leaseToken: activeLease })",
  boundary: "Only durable PR-review jobs are covered; provider and sandbox contracts stay separate."
}

const finding = Schema.decodeUnknownSync(PrReviewFinding)({
  findingId: "finding-1",
  severity: "high",
  path: "packages/control-center/src/server/agent/AgentJobWorker.ts",
  startLine: 42,
  endLine: 45,
  title: "Review output must cross a typed boundary",
  detail: "Decode the complete report before committing any model-authored result.",
  prevention
})

const report = Schema.decodeUnknownSync(PrReviewReport)({
  schemaVersion: 1,
  subject,
  recommendation: "changes-recommended",
  summary: "One durable review finding.",
  findings: [finding]
})

describe("PR review domain", () => {
  it("decodes a bounded report while keeping agent recommendation distinct from human disposition", () => {
    const decoded = Schema.decodeUnknownSync(PrReviewReport)(report)

    assert.strictEqual(decoded.recommendation, "changes-recommended")
    assert.isFalse(Schema.is(PrReviewReport)({ ...report, recommendation: "approve" }))
    assert.isFalse(Schema.is(PrReviewReport)({ ...report, recommendation: "request-changes" }))
  })

  it("rejects traversal, absolute, backslash, and control-character finding paths", () => {
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
            findings: [{ ...finding, path }]
          })
        ),
        path
      )
    }
  })

  it("rejects duplicate finding identifiers", () => {
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(PrReviewReport)({
          ...report,
          findings: [finding, { ...finding, title: "A second finding with the same identity" }]
        })
      )
    )
  })

  it("retains at most the bounded number of findings", () => {
    const findings = Array.from({ length: MAXIMUM_PR_REVIEW_FINDINGS }, (_, index) => ({
      ...finding,
      findingId: `finding-${String(index)}`
    }))
    const bounded = { ...report, findings }

    assert.isAtMost(
      new TextEncoder().encode(JSON.stringify(bounded)).byteLength,
      MAXIMUM_PR_REVIEW_REPORT_BYTES
    )
    assert.isTrue(Schema.is(PrReviewReport)(bounded))
    assert.isFalse(
      Schema.is(PrReviewReport)({
        ...report,
        findings: [...findings, { ...finding, findingId: "finding-overflow" }]
      })
    )
  })

  it("rejects reports whose encoded form exceeds the durable report bound", () => {
    const oversized = {
      ...report,
      findings: Array.from({ length: MAXIMUM_PR_REVIEW_FINDINGS }, (_, index) => ({
        ...finding,
        findingId: `finding-${String(index)}`,
        detail: "d".repeat(4_000),
        prevention: {
          ...prevention,
          invalidFixture: `invalid-${String(index)}-${"x".repeat(7_900)}`,
          validFixture: `valid-${String(index)}-${"y".repeat(7_900)}`
        }
      }))
    }

    assert.isAbove(new TextEncoder().encode(JSON.stringify(oversized)).byteLength, MAXIMUM_PR_REVIEW_REPORT_BYTES)
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PrReviewReport)(oversized)))
  })

  it("rejects prevention proposals without distinct reject and allow fixtures", () => {
    const missingAllow = {
      ...report,
      findings: [
        {
          ...finding,
          prevention: {
            ...prevention,
            validFixture: undefined
          }
        }
      ]
    }
    const identicalFixtures = {
      ...report,
      findings: [
        {
          ...finding,
          prevention: {
            ...prevention,
            validFixture: prevention.invalidFixture
          }
        }
      ]
    }

    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PrReviewReport)(missingAllow)))
    assert.isTrue(Result.isFailure(Schema.decodeUnknownResult(PrReviewReport)(identicalFixtures)))
  })

  it("accepts the exact documented prevention enforcement vocabulary", () => {
    assert.isTrue(
      Schema.is(PrReviewFinding)({
        ...finding,
        prevention: { ...prevention, enforcement: "ESLint" }
      })
    )
    assert.isTrue(
      Schema.is(PrReviewFinding)({
        ...finding,
        prevention: { ...prevention, enforcement: "ast-grep" }
      })
    )
    assert.isFalse(
      Schema.is(PrReviewFinding)({
        ...finding,
        prevention: { ...prevention, enforcement: "ESlint" }
      })
    )
    assert.isFalse(
      Schema.is(PrReviewFinding)({
        ...finding,
        prevention: { ...prevention, enforcement: "eslint" }
      })
    )
  })
})
