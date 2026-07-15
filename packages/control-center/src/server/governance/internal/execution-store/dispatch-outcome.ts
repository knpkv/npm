import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import {
  type GovernedActionTransitionCommand,
  GovernedActionUnknownOutcome
} from "../../../../domain/governedAction/index.js"
import { PluginActionDispatchResultV1 } from "../../../../domain/plugins/actions.js"
import type { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import { encodeGovernedActionDispatchOutcome, encodeGovernedActionUnknownOutcome } from "../../governedActionDigests.js"
import type { EncodedGovernedActionDispatchOutcome, GovernedActionDigestError } from "../../governedActionDigests.js"

/** Closed dispatch-side artifacts that can enter the durable provider-outcome inbox. */
export const DispatchInboxOutcome = Schema.Union([
  PluginActionDispatchResultV1,
  GovernedActionUnknownOutcome
])

/** Decoded dispatch-side inbox artifact. */
export type DispatchInboxOutcome = typeof DispatchInboxOutcome.Type

/** Closed persisted kinds for immediate dispatch results. */
export const DispatchResultKind = Schema.Literals([
  "accepted",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "manual-unknown"
])

const isLocalUnknown = (
  outcome: DispatchInboxOutcome
): outcome is typeof GovernedActionUnknownOutcome.Type => outcome._tag === "reconcilable" || outcome._tag === "manual"

/** Project one provider or locally synthesized dispatch-side outcome to its immutable inbox kind. */
export const dispatchInboxOutcomeKind = (
  outcome: DispatchInboxOutcome
): typeof DispatchResultKind.Type =>
  isLocalUnknown(outcome)
    ? outcome._tag === "manual" ? "manual-unknown" : "unknown"
    : outcome._tag === "unknown"
    ? "unknown"
    : outcome.receipt.status

/** Source observation time retained separately from the trusted host receipt time. */
export const dispatchInboxOutcomeObservedAt = (
  outcome: DispatchInboxOutcome
): typeof UtcTimestamp.Type =>
  isLocalUnknown(outcome)
    ? outcome.observedAt
    : outcome._tag === "unknown"
    ? outcome.observedAt
    : outcome.receipt.observedAt

/** Reconstruct the exact lifecycle command represented by one immediate provider result. */
export const dispatchInboxOutcomeCommand = (
  result: DispatchInboxOutcome
): GovernedActionTransitionCommand => {
  if (isLocalUnknown(result)) return { _tag: "recordUnknown", outcome: result }
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

/** Canonically encode either provider output or a local unknown marker. */
export const encodeDispatchInboxOutcome = Effect.fn(
  "GovernedActionDispatchOutcome.encodeInbox"
)(function*(outcome: DispatchInboxOutcome): Effect.fn.Return<
  EncodedGovernedActionDispatchOutcome,
  GovernedActionDigestError,
  Crypto.Crypto
> {
  return yield* isLocalUnknown(outcome)
    ? encodeGovernedActionUnknownOutcome(outcome)
    : encodeGovernedActionDispatchOutcome(outcome)
})
