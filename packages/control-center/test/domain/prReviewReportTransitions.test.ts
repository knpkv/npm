import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { PrReviewReport, PrReviewSuggestionId, reconcilePrReviewReports } from "../../src/domain/prReview.js"

const decodeReport = (headRevision: string, suggestionIds: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(PrReviewReport)({
    schemaVersion: 3,
    subject: {
      providerId: "codecommit",
      repository: "control-center",
      pullRequestId: "212",
      baseRevision: "1111111111111111111111111111111111111111",
      headRevision
    },
    completion: { status: "complete" },
    suggestions: suggestionIds.map((suggestionId) => ({
      suggestionId: PrReviewSuggestionId.make(suggestionId),
      state: "draft",
      title: "Keep the transaction atomic",
      severity: "P1",
      problem: "The write can be observed before its evidence is durable.",
      impact: "A retry can publish an incomplete transition.",
      evidence: {
        path: "src/transaction.ts",
        startLine: 10,
        endLine: 10,
        excerpt: "write()"
      },
      recommendation: "Commit the evidence and state in one transaction.",
      confidence: { level: "high", reason: "The write path is unconditional." },
      relatedLocations: [],
      anchor: { _tag: "changes" }
    })),
    notes: []
  })

describe("PR review report transitions", () => {
  it("records stable identities and immutable heads for new, present, and resolved suggestions", () => {
    const first = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
    const second = "sha256:2222222222222222222222222222222222222222222222222222222222222222"

    expect(
      reconcilePrReviewReports(
        decodeReport("2222222222222222222222222222222222222222", [first]),
        decodeReport("3333333333333333333333333333333333333333", [first, second])
      )
    ).toMatchObject([
      {
        suggestionId: first,
        transition: "still-present",
        previousHead: "2222222222222222222222222222222222222222",
        currentHead: "3333333333333333333333333333333333333333"
      },
      { suggestionId: second, transition: "new", previousState: null }
    ])

    expect(
      reconcilePrReviewReports(
        decodeReport("2222222222222222222222222222222222222222", [first]),
        decodeReport("3333333333333333333333333333333333333333", [])
      )
    ).toMatchObject([{ suggestionId: first, transition: "resolved", currentState: null }])
  })
})
