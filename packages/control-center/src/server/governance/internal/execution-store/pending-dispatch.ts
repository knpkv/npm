import * as Effect from "effect/Effect"

import { makeGovernedActionExecutionDispatchInboxFolder } from "./dispatch-inbox-fold.js"

/** Expose restart folding without duplicating the canonical dispatch-inbox fold invariant. */
export const makeGovernedActionExecutionPendingDispatchFolder = Effect.gen(function*() {
  const folder = yield* makeGovernedActionExecutionDispatchInboxFolder
  return { foldPending: folder.foldPending }
})
