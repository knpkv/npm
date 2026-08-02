import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"

import { PrReviewReport, PrReviewSuggestionId, reconcilePrReviewReports } from "../../src/domain/prReview.js"

const decodeReport = (
  headRevision: string,
  suggestionIds: ReadonlyArray<string>,
  reopenedSuggestionIds: ReadonlyArray<string> = []
) =>
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
      state: reopenedSuggestionIds.includes(suggestionId) ? "reopened" : "draft",
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

  it("requires the new head to explicitly reopen a dismissed identity", () => {
    const dismissed = "sha256:4444444444444444444444444444444444444444444444444444444444444444"
    const previous = decodeReport("2222222222222222222222222222222222222222", [dismissed])
    const dismissedReport = Schema.decodeUnknownSync(PrReviewReport)({
      ...previous,
      suggestions: previous.suggestions.map((suggestion) => ({
        ...suggestion,
        state: "dismissed",
        dismissalReason: "accepted-risk"
      }))
    })

    const reopenedReport = decodeReport(
      "3333333333333333333333333333333333333333",
      [dismissed],
      [dismissed]
    )
    const movedReopenedReport = Schema.decodeUnknownSync(PrReviewReport)({
      ...reopenedReport,
      suggestions: reopenedReport.suggestions.map((suggestion) => ({
        ...suggestion,
        evidence: { ...suggestion.evidence, startLine: 11, endLine: 11 }
      }))
    })
    expect(reconcilePrReviewReports(dismissedReport, movedReopenedReport)).toMatchObject([{
      suggestionId: dismissed,
      transition: "reopened",
      previousState: "dismissed",
      previousDismissalReason: "accepted-risk"
    }])

    expect(
      reconcilePrReviewReports(
        dismissedReport,
        decodeReport("3333333333333333333333333333333333333333", [dismissed])
      )
    ).toMatchObject([{ suggestionId: dismissed, transition: "still-present", currentState: "draft" }])
  })

  it("does not turn omitted dismissed identities into resolved transitions", () => {
    const dismissed = "sha256:5555555555555555555555555555555555555555555555555555555555555555"
    const original = decodeReport("2222222222222222222222222222222222222222", [dismissed])
    const [originalSuggestion] = original.suggestions
    if (originalSuggestion === undefined) throw new Error("expected a dismissed suggestion fixture")
    const previous = Schema.decodeUnknownSync(PrReviewReport)({
      ...original,
      suggestions: [{
        ...originalSuggestion,
        state: "dismissed",
        dismissalReason: "accepted-risk"
      }]
    })

    expect(
      reconcilePrReviewReports(
        previous,
        decodeReport("3333333333333333333333333333333333333333", [])
      )
    ).toEqual([])
  })
})
