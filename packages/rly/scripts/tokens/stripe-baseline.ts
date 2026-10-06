/**
 * A ratchet for one-sided stripes outside rly: stripes already in the product packages are listed in
 * `stripe-baseline.json` by path and declaration (not line, so edits elsewhere in a file don't move
 * them). A stripe not in the list fails, and so does a listed stripe that is gone, so the list only
 * shrinks as each package removes its own.
 */
import type { AccentStripeViolation } from "./accent-stripes.js"

/** One known stripe, keyed by file and declaration text. */
export interface StripeBaselineEntry {
  readonly path: string
  readonly declaration: string
}

/** Stripes the baseline does not allow, and baseline entries no longer found in the source. */
export interface StripeBaselineComparison {
  readonly fresh: ReadonlyArray<AccentStripeViolation>
  readonly fixed: ReadonlyArray<StripeBaselineEntry>
}

const keyOf = (entry: StripeBaselineEntry): string => `${entry.path}\t${entry.declaration}`

/** Splits found stripes into new ones and baseline entries that have been removed, counting repeats. */
export const compareToBaseline = (
  violations: ReadonlyArray<AccentStripeViolation>,
  baseline: ReadonlyArray<StripeBaselineEntry>
): StripeBaselineComparison => {
  const remaining = new Map<string, number>()
  for (const entry of baseline) remaining.set(keyOf(entry), (remaining.get(keyOf(entry)) ?? 0) + 1)
  const fresh = violations.filter((violation) => {
    const left = remaining.get(keyOf(violation)) ?? 0
    if (left === 0) return true
    remaining.set(keyOf(violation), left - 1)
    return false
  })
  const fixed = baseline.filter((entry) => {
    const left = remaining.get(keyOf(entry)) ?? 0
    if (left === 0) return false
    remaining.set(keyOf(entry), left - 1)
    return true
  })
  return { fixed, fresh }
}
