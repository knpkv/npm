import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import {
  appendReviewTurn,
  applyFindingDecision,
  initialFindingDispositions,
  reconcileFindingDispositions,
  settleFindingPublication
} from "../src/client/review-session-state.js"
import { MAXIMUM_RELAY_REVIEW_TURNS, RelayReviewConversationTurn, type RelayReviewFinding } from "../src/server/Api.js"
import { MAXIMUM_RELAY_REVIEW_TURNS_BYTES } from "../src/server/review/ReviewPromptBudget.js"

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

  it("preserves an active publication while its finding is reconciled", () => {
    expect(reconcileFindingDispositions(
      [finding("first")],
      [finding("first")],
      { F1: "posting" }
    )).toEqual({ F1: "posting" })
    expect(reconcileFindingDispositions(
      [finding("first")],
      [finding("changed")],
      { F1: "posting" }
    )).toEqual({ F1: "posting" })
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
    expect(settleFindingPublication(
      [finding("changed")],
      finding("first"),
      { F1: "posting" },
      "failed"
    )).toEqual({ dispositions: { F1: "failed" }, stale: true })
    expect(settleFindingPublication(
      [],
      finding("first"),
      { F1: "posting" },
      "failed"
    )).toEqual({ dispositions: { F1: "posting" }, stale: false })
  })

  it("retains the newest continuation turn within the API limit", () => {
    const retained: ReadonlyArray<RelayReviewConversationTurn> = Array.from(
      { length: MAXIMUM_RELAY_REVIEW_TURNS },
      (_, index) => ({
        findingId: "F1",
        role: index % 2 === 0 ? "user" : "assistant",
        message: `turn-${String(index)}`
      })
    )
    const next = appendReviewTurn(retained, { findingId: "F1", role: "user", message: "newest" })
    expect(next).toHaveLength(MAXIMUM_RELAY_REVIEW_TURNS - 1)
    expect(next[0]?.message).toBe("turn-2")
    expect(next.at(-1)?.message).toBe("newest")
    expect(appendReviewTurn([], { findingId: "F1", role: "user", message: "first" }))
      .toEqual([{ findingId: "F1", role: "user", message: "first" }])
  })

  it("trims completed conversation exchanges as atomic user and assistant pairs", () => {
    const turns: ReadonlyArray<RelayReviewConversationTurn> = [
      { findingId: "F1", role: "user", message: `old-question:${"x".repeat(7_800)}` },
      { findingId: "F1", role: "assistant", message: "old-answer" },
      { findingId: "F1", role: "user", message: `kept-question:${"x".repeat(7_800)}` },
      { findingId: "F1", role: "assistant", message: `kept-answer:${"x".repeat(3_800)}` },
      { findingId: "F1", role: "user", message: `newest-question:${"x".repeat(7_800)}` },
      { findingId: "F1", role: "assistant", message: `newest-answer:${"x".repeat(7_800)}` }
    ]
    const next = appendReviewTurn(turns.slice(0, -1), turns.at(-1)!)

    expect(new TextEncoder().encode(JSON.stringify(next)).byteLength).toBeLessThanOrEqual(
      MAXIMUM_RELAY_REVIEW_TURNS_BYTES
    )
    expect(next.map(({ role }) => role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(next[0]?.message.startsWith("kept-question:")).toBe(true)
  })

  it("retains the newest turns within the aggregate UTF-8 budget", () => {
    const turns: ReadonlyArray<RelayReviewConversationTurn> = Array.from(
      { length: 5 },
      (_, index) => ({ findingId: "F1", role: "assistant", message: `${String(index)}${"é".repeat(3_900)}` })
    )
    const next = appendReviewTurn(turns, { findingId: "F1", role: "user", message: `5${"é".repeat(3_900)}` })

    expect(new TextEncoder().encode(JSON.stringify(next)).byteLength).toBeLessThanOrEqual(
      MAXIMUM_RELAY_REVIEW_TURNS_BYTES
    )
    expect(next.at(-1)?.message.startsWith("5")).toBe(true)
    expect(next.length).toBeLessThan(turns.length + 1)
  })

  it("rejects a single message that cannot be retained as a conversation turn", () => {
    const invalid = { findingId: "F1", role: "user", message: "\0".repeat(8_000) }
    const valid = {
      findingId: "F1",
      role: "user",
      message: `5${"é".repeat(3_900)}`
    } satisfies RelayReviewConversationTurn

    expect(Schema.is(RelayReviewConversationTurn)(invalid)).toBe(false)
    expect(Schema.is(RelayReviewConversationTurn)(valid)).toBe(true)
    expect(appendReviewTurn([], valid).at(-1)).toEqual(valid)
  })
})
