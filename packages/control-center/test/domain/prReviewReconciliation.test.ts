import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"

import { PrReviewSuggestionId } from "../../src/domain/prReview.js"
import { reconcilePrReviewSuggestions } from "../../src/domain/prReviewReconciliation.js"

const id = (hex: string) => Schema.decodeUnknownSync(PrReviewSuggestionId)(`sha256:${hex.repeat(64)}`)
const first = id("1")
const second = id("2")
const third = id("3")

describe("PR review suggestion reconciliation", () => {
  it("classifies preserved, resolved, reopened, and new identities atomically", () => {
    const result = reconcilePrReviewSuggestions({
      previous: [
        { suggestionId: first, state: "published" },
        { suggestionId: second, state: "dismissed" }
      ],
      currentSuggestionIds: [first, second, third],
      declared: [
        { suggestionId: first, kind: "still-present" },
        { suggestionId: second, kind: "reopened" },
        { suggestionId: third, kind: "new" }
      ]
    })

    assert.deepEqual(result, {
      _tag: "success",
      transitions: [
        { suggestionId: first, kind: "still-present" },
        { suggestionId: second, kind: "reopened" },
        { suggestionId: third, kind: "new" }
      ]
    })
  })

  it("requires a resolved transition for an omitted open suggestion", () => {
    const result = reconcilePrReviewSuggestions({
      previous: [{ suggestionId: first, state: "published" }],
      currentSuggestionIds: [],
      declared: []
    })

    assert.deepEqual(result, {
      _tag: "failure",
      failure: { _tag: "missing-transition", suggestionId: first }
    })
  })

  it("does not manufacture transitions for omitted terminal suggestions", () => {
    const result = reconcilePrReviewSuggestions({
      previous: [
        { suggestionId: first, state: "dismissed" },
        { suggestionId: second, state: "resolved" }
      ],
      currentSuggestionIds: [],
      declared: []
    })

    assert.deepEqual(result, { _tag: "success", transitions: [] })
  })

  it("rejects unknown, duplicate, and contradictory declarations", () => {
    const unknown = reconcilePrReviewSuggestions({
      previous: [],
      currentSuggestionIds: [first],
      declared: [{ suggestionId: second, kind: "new" }]
    })
    assert.deepEqual(unknown, {
      _tag: "failure",
      failure: { _tag: "unknown-id", suggestionId: second }
    })

    const duplicate = reconcilePrReviewSuggestions({
      previous: [],
      currentSuggestionIds: [first, first],
      declared: []
    })
    assert.deepEqual(duplicate, {
      _tag: "failure",
      failure: { _tag: "duplicate-id", suggestionId: first }
    })

    const contradictory = reconcilePrReviewSuggestions({
      previous: [{ suggestionId: first, state: "published" }],
      currentSuggestionIds: [first],
      declared: [{ suggestionId: first, kind: "resolved" }]
    })
    assert.deepEqual(contradictory, {
      _tag: "failure",
      failure: {
        _tag: "contradictory-transition",
        suggestionId: first,
        expected: "still-present",
        actual: "resolved"
      }
    })
  })
})
