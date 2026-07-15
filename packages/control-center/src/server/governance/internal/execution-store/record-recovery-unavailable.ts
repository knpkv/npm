import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import type { GovernedActionExecutionStoreV1 } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionReconciliationInbox } from "./reconciliation-inbox.js"
import { GovernedActionRecoveryUnavailableOutcomeV1 } from "./reconciliation-outcome.js"

const invalidOutcome = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "record-recovery-unavailable", reason: "conflict" })

/** Persist unavailable runtime-generation evidence without converting ambiguity into a terminal state. */
export const makeGovernedActionExecutionRecordRecoveryUnavailable = Effect.gen(function*() {
  const inbox = yield* makeGovernedActionExecutionReconciliationInbox

  const recordRecoveryUnavailable: GovernedActionExecutionStoreV1["recordRecoveryUnavailable"] = Effect.fn(
    "GovernedActionExecutionRecordRecoveryUnavailable.recordRecoveryUnavailable"
  )(function*(input) {
    const outcome = yield* Schema.decodeUnknownEffect(
      Schema.toType(GovernedActionRecoveryUnavailableOutcomeV1)
    )({
      _tag: "recovery-unavailable",
      schemaVersion: 1,
      reason: input.reason,
      observedAt: input.observedAt
    }).pipe(
      Effect.mapError(invalidOutcome)
    )
    return yield* inbox.recordOutcome({
      operation: "record-recovery-unavailable",
      outcome,
      receivedAt: input.observedAt,
      recoveryToken: input.recoveryToken
    })
  })

  return { recordRecoveryUnavailable }
})
