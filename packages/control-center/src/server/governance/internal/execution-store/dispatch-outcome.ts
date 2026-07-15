import * as Schema from "effect/Schema"

import type { GovernedActionTransitionCommand } from "../../../../domain/governedAction/index.js"
import type { PluginActionDispatchResultV1 } from "../../../../domain/plugins/actions.js"
import type { UtcTimestamp } from "../../../../domain/utcTimestamp.js"

/** Closed persisted kinds for immediate dispatch results. */
export const DispatchResultKind = Schema.Literals(["accepted", "succeeded", "failed", "cancelled", "unknown"])

/** Project one provider result to its immutable inbox kind. */
export const dispatchResultKind = (
  result: PluginActionDispatchResultV1
): typeof DispatchResultKind.Type => result._tag === "unknown" ? "unknown" : result.receipt.status

/** Provider-owned observation time retained separately from host receipt time. */
export const dispatchResultObservedAt = (
  result: PluginActionDispatchResultV1
): typeof UtcTimestamp.Type => result._tag === "unknown" ? result.observedAt : result.receipt.observedAt

/** Reconstruct the exact lifecycle command represented by one immediate provider result. */
export const dispatchResultCommand = (
  result: PluginActionDispatchResultV1
): GovernedActionTransitionCommand => {
  if (result._tag === "unknown") {
    return {
      _tag: "recordUnknown",
      outcome: {
        _tag: "reconcilable",
        reconciliationKey: result.reconciliationKey,
        observedAt: result.observedAt,
        safeSummary: result.safeSummary
      }
    }
  }
  switch (result.receipt.status) {
    case "accepted":
      return { _tag: "recordAccepted", receipt: result.receipt }
    case "succeeded":
      return { _tag: "recordSucceeded", receipt: result.receipt, source: { _tag: "direct" } }
    case "failed":
      return { _tag: "recordFailed", receipt: result.receipt, source: { _tag: "direct" } }
    case "cancelled":
      return { _tag: "recordCancelled", receipt: result.receipt, source: { _tag: "direct" } }
  }
}
