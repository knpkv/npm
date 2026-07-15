import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { PluginActionDispatchResultV1 } from "../../../../domain/plugins/actions.js"
import type { GovernedActionExecutionStoreV1 } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionDispatchInbox } from "./dispatch-inbox.js"

const invalidResult = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "record-dispatch", reason: "conflict" })

/** Append one provider dispatch result to its immutable inbox and fold it into the current head. */
export const makeGovernedActionExecutionRecordDispatch = Effect.gen(function*() {
  const inbox = yield* makeGovernedActionExecutionDispatchInbox

  const recordDispatch: GovernedActionExecutionStoreV1["recordDispatch"] = Effect.fn(
    "GovernedActionExecutionRecordDispatch.recordDispatch"
  )(function*(input) {
    const result = yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionDispatchResultV1))(
      input.result
    ).pipe(Effect.mapError(invalidResult))
    return yield* inbox.recordOutcome({
      operation: "record-dispatch",
      outcome: result,
      permitToken: input.permitToken,
      receivedAt: input.observedAt
    })
  })

  return { recordDispatch }
})
