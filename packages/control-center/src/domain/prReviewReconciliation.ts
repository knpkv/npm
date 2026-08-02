/** Pure cross-head reconciliation for immutable PR-review suggestions. @module */

import type { PrReviewSuggestionId, PrReviewSuggestionState } from "./prReview.js"

/** One suggestion's state at the last completed review head. */
export type PreviousPrReviewSuggestion = {
  readonly suggestionId: PrReviewSuggestionId
  readonly state: PrReviewSuggestionState
}

/** Host-observed transition declared by the completed re-review. */
export type DeclaredPrReviewSuggestionTransition = {
  readonly suggestionId: PrReviewSuggestionId
  readonly kind: PrReviewSuggestionReconciliationKind
}

/** Explicit lifecycle result for one stable suggestion identity. */
export type PrReviewSuggestionReconciliationKind =
  | "still-present"
  | "resolved"
  | "reopened"
  | "new"

/** Inputs to the pure reconciliation seam. */
export type ReconcilePrReviewSuggestionsInput = {
  readonly previous: ReadonlyArray<PreviousPrReviewSuggestion>
  readonly currentSuggestionIds: ReadonlyArray<PrReviewSuggestionId>
  readonly declared: ReadonlyArray<DeclaredPrReviewSuggestionTransition>
}

/** Why a re-review cannot be committed as a single lifecycle transition. */
export type ReconcilePrReviewSuggestionsFailure =
  | { readonly _tag: "duplicate-id"; readonly suggestionId: PrReviewSuggestionId }
  | { readonly _tag: "unknown-id"; readonly suggestionId: PrReviewSuggestionId }
  | {
    readonly _tag: "contradictory-transition"
    readonly suggestionId: PrReviewSuggestionId
    readonly expected: PrReviewSuggestionReconciliationKind
    readonly actual: PrReviewSuggestionReconciliationKind
  }
  | { readonly _tag: "missing-transition"; readonly suggestionId: PrReviewSuggestionId }

/** One committed transition, returned in deterministic identity order. */
export type PrReviewSuggestionReconciliation = {
  readonly suggestionId: PrReviewSuggestionId
  readonly kind: PrReviewSuggestionReconciliationKind
}

export type ReconcilePrReviewSuggestionsResult =
  | { readonly _tag: "success"; readonly transitions: ReadonlyArray<PrReviewSuggestionReconciliation> }
  | { readonly _tag: "failure"; readonly failure: ReconcilePrReviewSuggestionsFailure }

const isPresentState = (state: PrReviewSuggestionState): boolean =>
  state === "draft" || state === "published" || state === "stale" || state === "reopened"

/**
 * Validate and classify a complete re-review observation without touching
 * persistence. Callers can reject the whole transaction on the failure branch.
 */
export const reconcilePrReviewSuggestions = (
  input: ReconcilePrReviewSuggestionsInput
): ReconcilePrReviewSuggestionsResult => {
  const previous = new Map<PrReviewSuggestionId, PrReviewSuggestionState>()
  for (const suggestion of input.previous) {
    if (previous.has(suggestion.suggestionId)) {
      return { _tag: "failure", failure: { _tag: "duplicate-id", suggestionId: suggestion.suggestionId } }
    }
    previous.set(suggestion.suggestionId, suggestion.state)
  }

  const current = new Set<PrReviewSuggestionId>()
  for (const suggestionId of input.currentSuggestionIds) {
    if (current.has(suggestionId)) {
      return { _tag: "failure", failure: { _tag: "duplicate-id", suggestionId } }
    }
    current.add(suggestionId)
  }

  const expected = new Map<PrReviewSuggestionId, PrReviewSuggestionReconciliationKind>()
  for (const [suggestionId, state] of previous) {
    expected.set(
      suggestionId,
      current.has(suggestionId)
        ? state === "dismissed" || state === "resolved"
          ? "reopened"
          : "still-present"
        : isPresentState(state)
        ? "resolved"
        : "resolved"
    )
  }
  for (const suggestionId of current) {
    if (!expected.has(suggestionId)) expected.set(suggestionId, "new")
  }

  const declared = new Map<PrReviewSuggestionId, PrReviewSuggestionReconciliationKind>()
  for (const transition of input.declared) {
    if (!expected.has(transition.suggestionId)) {
      return { _tag: "failure", failure: { _tag: "unknown-id", suggestionId: transition.suggestionId } }
    }
    if (declared.has(transition.suggestionId)) {
      return { _tag: "failure", failure: { _tag: "duplicate-id", suggestionId: transition.suggestionId } }
    }
    declared.set(transition.suggestionId, transition.kind)
  }

  for (const [suggestionId, kind] of expected) {
    const actual = declared.get(suggestionId)
    if (actual === undefined) {
      return { _tag: "failure", failure: { _tag: "missing-transition", suggestionId } }
    }
    if (actual !== kind) {
      return {
        _tag: "failure",
        failure: { _tag: "contradictory-transition", suggestionId, expected: kind, actual }
      }
    }
  }

  return {
    _tag: "success",
    transitions: [...expected].map(([suggestionId, kind]) => ({ suggestionId, kind }))
  }
}
