import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { PluginActionReconciliationResultV1 } from "../../../../domain/plugins/actions.js"
import type { GovernedActionExecutionStoreV1 } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionReconciliationInbox } from "./reconciliation-inbox.js"

const invalidResult = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "record-reconciliation", reason: "conflict" })

/** Append one provider reconciliation result and fold it into the governed lifecycle. */
export const makeGovernedActionExecutionRecordReconciliation = Effect.gen(function*() {
  const inbox = yield* makeGovernedActionExecutionReconciliationInbox

  const recordReconciliation: GovernedActionExecutionStoreV1["recordReconciliation"] = Effect.fn(
    "GovernedActionExecutionRecordReconciliation.recordReconciliation"
  )(function*(input) {
    const result = yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionReconciliationResultV1))(
      input.result
    ).pipe(Effect.mapError(invalidResult))
    return yield* inbox.recordOutcome({
      operation: "record-reconciliation",
      outcome: result,
      receivedAt: input.observedAt,
      recoveryToken: input.recoveryToken
    })
  })

  return { recordReconciliation }
})
