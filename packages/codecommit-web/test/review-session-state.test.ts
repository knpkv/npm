import { describe, expect, it } from "@effect/vitest"
import {
  appendReviewTurn,
  applyFindingDecision,
  initialFindingDispositions,
  reconcileFindingDispositions,
  settleFindingPublication
} from "../src/client/review-session-state.js"
import {
  MAXIMUM_RELAY_REVIEW_TURNS,
  type RelayReviewConversationTurn,
  type RelayReviewFinding
} from "../src/server/Api.js"

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

  it("preserves a publication receipt across later local decisions", () => {
    for (
      const decision of ["acknowledged", "rejected"] satisfies ReadonlyArray<"acknowledged" | "rejected">
    ) {
      const posted = settleFindingPublication(
        [finding("first")],
        finding("first"),
        { F1: "posting" },
        "posted"
      ).dispositions
      const afterDecision = applyFindingDecision(posted, "F1", decision)

      expect(afterDecision).toEqual({ F1: "posted" })
      expect(reconcileFindingDispositions(
        [finding("first")],
        [finding("changed")],
        afterDecision
      )).toEqual({ F1: "posted-stale" })
    }
  })

  it("binds publication receipts to the submitted finding snapshot", () => {
    expect(settleFindingPublication(
      [finding("first")],
      finding("first"),
      { F1: "posting" },
      "posted"
    )).toEqual({ dispositions: { F1: "posted" }, stale: false })
    expect(settleFindingPublication(
      [finding("changed")],
      finding("first"),
      { F1: "pending" },
      "posted"
    )).toEqual({ dispositions: { F1: "posted-stale" }, stale: true })
    expect(settleFindingPublication(
      [],
      finding("first"),
      {},
      "posted"
    )).toEqual({ dispositions: { F1: "posted-stale" }, stale: true })
  })

  it("retains the newest continuation turn within the API limit", () => {
    const retained: ReadonlyArray<RelayReviewConversationTurn> = Array.from(
      { length: MAXIMUM_RELAY_REVIEW_TURNS },
      (_, index) => ({ findingId: "F1", role: "assistant", message: `turn-${String(index)}` })
    )
    const next = appendReviewTurn(retained, { findingId: "F1", role: "user", message: "newest" })
    expect(next).toHaveLength(MAXIMUM_RELAY_REVIEW_TURNS)
    expect(next[0]?.message).toBe("turn-1")
    expect(next.at(-1)?.message).toBe("newest")
    expect(appendReviewTurn([], { findingId: "F1", role: "user", message: "first" }))
      .toEqual([{ findingId: "F1", role: "user", message: "first" }])
  })
})
