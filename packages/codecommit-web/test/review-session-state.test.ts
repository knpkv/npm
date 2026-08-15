import { describe, expect, it } from "@effect/vitest"
import { initialFindingDispositions, reconcileFindingDispositions } from "../src/client/review-session-state.js"
import type { RelayReviewFinding } from "../src/server/Api.js"

const finding = (summary: string): RelayReviewFinding => ({
  id: "F1",
  priority: "P2",
  title: "Unsafe retry",
  summary,
  details: "The changed branch retries writes.",
  recommendation: "Retry reads only.",
  verification: "Inspect the changed branch.",
  publicationTarget: "line-comment",
  location: { scope: "line", filePath: "src/index.ts", line: 1, side: "after" }
})

describe("Relay finding dispositions", () => {
  it("starts every new finding pending", () => {
    expect(initialFindingDispositions([finding("first")])).toEqual({ F1: "pending" })
  })

  it("keeps decisions for unchanged findings and marks changed posted findings stale", () => {
    expect(reconcileFindingDispositions(
      [finding("first")],
      [finding("first")],
      { F1: "acknowledged" }
    )).toEqual({ F1: "acknowledged" })
    expect(reconcileFindingDispositions(
      [finding("first")],
      [finding("changed")],
      { F1: "posted" }
    )).toEqual({ F1: "posted-stale" })
  })

  it("returns changed non-posted findings to pending", () => {
    expect(reconcileFindingDispositions(
      [finding("first")],
      [finding("changed")],
      { F1: "rejected" }
    )).toEqual({ F1: "pending" })
  })
})
