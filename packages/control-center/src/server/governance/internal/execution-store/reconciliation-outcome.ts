import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { GovernedActionTransitionCommand } from "../../../../domain/governedAction/index.js"
import type { PluginActionReconciliationKey } from "../../../../domain/plugins/actions.js"
import { PluginActionReconciliationResultV1 } from "../../../../domain/plugins/actions.js"
import { UtcTimestamp } from "../../../../domain/utcTimestamp.js"
import {
  canonicalizeGovernedActionJson,
  digestCanonicalGovernedActionJson,
  type EncodedGovernedActionDispatchOutcome,
  GovernedActionDigestError
} from "../../governedActionDigests.js"

/** Versioned local evidence that the dispatch-owning runtime generation cannot be recovered. */
export const GovernedActionRecoveryUnavailableOutcomeV1 = Schema.TaggedStruct("recovery-unavailable", {
  schemaVersion: Schema.Literal(1),
  reason: Schema.Literal("runtime-generation-unavailable"),
  observedAt: UtcTimestamp
})

/** Closed reconciliation-side artifacts accepted by the durable provider-outcome inbox. */
export const ReconciliationInboxOutcome = Schema.Union([
  PluginActionReconciliationResultV1,
  GovernedActionRecoveryUnavailableOutcomeV1
])

/** Decoded reconciliation-side inbox artifact. */
export type ReconciliationInboxOutcome = typeof ReconciliationInboxOutcome.Type

/** Closed persisted kinds for reconciliation results. */
export const ReconciliationResultKind = Schema.Literals([
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "recovery-unavailable"
])

const encodeOutcome = Schema.encodeEffect(ReconciliationInboxOutcome)

/** Project one reconciliation-side artifact to its immutable inbox kind. */
export const reconciliationInboxOutcomeKind = (
  outcome: ReconciliationInboxOutcome
): typeof ReconciliationResultKind.Type => outcome._tag

/** Project the source observation retained separately from trusted host receipt time. */
export const reconciliationInboxOutcomeObservedAt = (
  outcome: ReconciliationInboxOutcome,
  _receivedAt: UtcTimestamp
): UtcTimestamp =>
  outcome._tag === "recovery-unavailable"
    ? outcome.observedAt
    : outcome._tag === "pending"
    ? outcome.checkedAt
    : outcome.receipt.observedAt

/** Reconstruct the lifecycle command represented by one reconciliation-side inbox outcome. */
export const reconciliationInboxOutcomeCommand = (
  outcome: ReconciliationInboxOutcome,
  reconciliationKey: typeof PluginActionReconciliationKey.Type | null,
  observedAt: UtcTimestamp
): GovernedActionTransitionCommand => {
  switch (outcome._tag) {
    case "pending":
      return { _tag: "reconciliationPending", checkedAt: outcome.checkedAt, reconciliationKey }
    case "recovery-unavailable":
      return { _tag: "reconciliationPending", checkedAt: observedAt, reconciliationKey }
    case "succeeded":
      if (outcome.receipt.status !== "succeeded") {
        return { _tag: "reconciliationPending", checkedAt: observedAt, reconciliationKey }
      }
      return {
        _tag: "recordSucceeded",
        receipt: outcome.receipt,
        source: { _tag: "reconciliation", reconciliationKey }
      }
    case "failed":
      if (outcome.receipt.status !== "failed") {
        return { _tag: "reconciliationPending", checkedAt: observedAt, reconciliationKey }
      }
      return {
        _tag: "recordFailed",
        receipt: outcome.receipt,
        source: { _tag: "reconciliation", reconciliationKey }
      }
    case "cancelled":
      if (outcome.receipt.status !== "cancelled") {
        return { _tag: "reconciliationPending", checkedAt: observedAt, reconciliationKey }
      }
      return {
        _tag: "recordCancelled",
        receipt: outcome.receipt,
        source: { _tag: "reconciliation", reconciliationKey }
      }
  }
}

/** Canonically encode and hash either provider reconciliation output or timestamped local unavailable evidence. */
export const encodeReconciliationInboxOutcome = Effect.fn(
  "GovernedActionReconciliationOutcome.encodeInbox"
)(function*(outcome: ReconciliationInboxOutcome): Effect.fn.Return<
  EncodedGovernedActionDispatchOutcome,
  GovernedActionDigestError,
  Crypto.Crypto
> {
  const encoded = yield* encodeOutcome(outcome).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  const json = yield* Schema.decodeUnknownEffect(Schema.Json)(encoded).pipe(
    Effect.mapError(() => new GovernedActionDigestError({ operation: "encode" }))
  )
  return {
    outcomeDigest: yield* digestCanonicalGovernedActionJson(json),
    outcomeJson: canonicalizeGovernedActionJson(json)
  }
})
