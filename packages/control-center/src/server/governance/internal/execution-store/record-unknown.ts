import * as Clock from "effect/Clock"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

import { GovernedActionUnknownOutcome } from "../../../../domain/governedAction/index.js"
import type { GovernedActionExecutionStoreV1 } from "../GovernedActionExecutionStore.js"
import { GovernedActionExecutionStoreError } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionDispatchInbox } from "./dispatch-inbox.js"

const invalidOutcome = (): GovernedActionExecutionStoreError =>
  new GovernedActionExecutionStoreError({ operation: "record-unknown", reason: "conflict" })

/** Persist a locally synthesized unknown outcome at a trusted host receipt time. */
export const makeGovernedActionExecutionRecordUnknown = Effect.gen(function*() {
  const clock = yield* Clock.Clock
  const inbox = yield* makeGovernedActionExecutionDispatchInbox

  const recordUnknown: GovernedActionExecutionStoreV1["recordUnknown"] = Effect.fn(
    "GovernedActionExecutionRecordUnknown.recordUnknown"
  )(function*(input) {
    const outcome = yield* Schema.decodeUnknownEffect(Schema.toType(GovernedActionUnknownOutcome))(
      input.outcome
    ).pipe(Effect.mapError(invalidOutcome))
    const receivedAt = DateTime.makeUnsafe(yield* clock.currentTimeMillis)
    return yield* inbox.recordOutcome({
      operation: "record-unknown",
      outcome,
      permitToken: input.permitToken,
      receivedAt
    })
  })

  return { recordUnknown }
})
