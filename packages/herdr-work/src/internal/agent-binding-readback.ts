import { Equal, Schema } from "effect"
import { WorkStoreError } from "../errors.js"
import { WorkAgentBinding, WorkGoalCheckpoint, WorkLaneClaimed } from "../model.js"
import type { WorkAgentBinding as WorkAgentBindingType } from "../model.js"

export const AgentBindingLaneOperationRow = Schema.Struct({
  goalId: Schema.String,
  laneId: Schema.String,
  operationId: Schema.String,
  phase: Schema.String,
  record: Schema.String,
  revision: Schema.Number
})

export const AgentBindingGoalEventRow = Schema.Struct({
  eventId: Schema.String,
  goalId: Schema.String,
  occurredAt: Schema.Number,
  record: Schema.String
})

export type AgentBindingGoalEventDecision =
  | { readonly _tag: "valid"; readonly checkpoint: WorkGoalCheckpoint }
  | { readonly _tag: "invalid"; readonly error: WorkStoreError }

/** Decodes a checkpoint only when its indexed identity matches its durable record. */
export const decodeAgentBindingGoalEvent = (
  row: typeof AgentBindingGoalEventRow.Type,
  operation: string
): AgentBindingGoalEventDecision => {
  try {
    const checkpoint = Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(row.record))
    return row.eventId === checkpoint.eventId &&
        row.goalId === checkpoint.goal.id &&
        row.occurredAt === checkpoint.occurredAt
      ? { _tag: "valid", checkpoint }
      : {
        _tag: "invalid",
        error: new WorkStoreError({ cause: { checkpoint, row }, operation: `${operation}.identity-mismatch` })
      }
  } catch (cause) {
    return { _tag: "invalid", error: new WorkStoreError({ cause, operation: `${operation}.decode` }) }
  }
}

/** Validates the two immutable ledger rows committed beside an agent binding. */
export const agentBindingReadbackError = (
  binding: WorkAgentBindingType,
  laneRow: typeof AgentBindingLaneOperationRow.Type | undefined,
  checkpointRow: typeof AgentBindingGoalEventRow.Type | undefined,
  operation: string
): WorkStoreError | undefined => {
  if (laneRow === undefined || checkpointRow === undefined) {
    return new WorkStoreError({
      cause: {
        binding: binding.request.dispatchRequestId,
        checkpoint: checkpointRow === undefined ? "missing" : "present",
        laneOperation: laneRow === undefined ? "missing" : "present"
      },
      operation: `${operation}.missing-companion`
    })
  }
  try {
    const lane = Schema.decodeUnknownSync(WorkLaneClaimed)(JSON.parse(laneRow.record))
    const checkpoint = Schema.decodeUnknownSync(WorkGoalCheckpoint)(JSON.parse(checkpointRow.record))
    if (
      laneRow.operationId !== lane.operationId ||
      laneRow.laneId !== lane.laneId ||
      laneRow.goalId !== lane.goalId ||
      laneRow.phase !== lane.phase ||
      laneRow.revision !== lane.revision ||
      checkpointRow.eventId !== checkpoint.eventId ||
      checkpointRow.goalId !== checkpoint.goal.id ||
      checkpointRow.occurredAt !== checkpoint.occurredAt ||
      !Equal.equals(lane, binding.lane) ||
      !Equal.equals(checkpoint, binding.checkpoint)
    ) {
      return new WorkStoreError({
        cause: { binding, checkpoint, checkpointRow, lane, laneRow },
        operation: `${operation}.companion-identity-mismatch`
      })
    }
    return undefined
  } catch (cause) {
    return new WorkStoreError({ cause, operation: `${operation}.decode-companion` })
  }
}

/** Ensures an untrusted binding record still conforms before companion comparison. */
export const decodeAgentBindingRecord = (record: string): WorkAgentBindingType =>
  Schema.decodeUnknownSync(WorkAgentBinding)(JSON.parse(record))
