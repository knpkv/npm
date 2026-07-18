import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { WorkspaceId } from "../../../../domain/identifiers.js"
import { GovernedActionExecutionStore } from "../GovernedActionExecutionStore.js"
import { makeGovernedActionExecutionBegin } from "./begin.js"
import { makeGovernedActionExecutionInspect } from "./inspect.js"
import { makeGovernedActionExecutionRecordBlocked } from "./record-blocked.js"
import { makeGovernedActionExecutionRecordDispatch } from "./record-dispatch.js"
import { makeGovernedActionExecutionRecordReconciliation } from "./record-reconciliation.js"
import { makeGovernedActionExecutionRecordRecoveryUnavailable } from "./record-recovery-unavailable.js"
import { makeGovernedActionExecutionRecordUnknown } from "./record-unknown.js"
import { makeGovernedActionRecoveryCandidates } from "./recovery-candidates.js"

const makeGovernedActionExecutionStore = Effect.fn(
  "GovernedActionExecutionStore.make"
)(function*(workspaceId: WorkspaceId) {
  const inspect = yield* makeGovernedActionExecutionInspect
  const begin = yield* makeGovernedActionExecutionBegin
  const blocked = yield* makeGovernedActionExecutionRecordBlocked
  const dispatch = yield* makeGovernedActionExecutionRecordDispatch
  const unknown = yield* makeGovernedActionExecutionRecordUnknown
  const unavailable = yield* makeGovernedActionExecutionRecordRecoveryUnavailable
  const reconciliation = yield* makeGovernedActionExecutionRecordReconciliation
  const recoveryCandidates = yield* makeGovernedActionRecoveryCandidates(workspaceId)

  return {
    recoveryCandidates: recoveryCandidates.recoveryCandidates,
    inspect: inspect.inspect,
    begin: begin.begin,
    recordBlocked: blocked.recordBlocked,
    recordDispatch: dispatch.recordDispatch,
    recordUnknown: unknown.recordUnknown,
    recordRecoveryUnavailable: unavailable.recordRecoveryUnavailable,
    recordReconciliation: reconciliation.recordReconciliation
  }
})

/** Private live store; only governed worker startup may install this authority-bearing service. */
export const governedActionExecutionStoreLayer = (workspaceId: WorkspaceId) =>
  Layer.effect(
    GovernedActionExecutionStore,
    makeGovernedActionExecutionStore(workspaceId)
  )
