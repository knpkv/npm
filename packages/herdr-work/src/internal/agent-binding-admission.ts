import { WorkProjectionError } from "../errors.js"
import { type WorkGoalCheckpoint, workHistoryMaxEvents } from "../model.js"
import { workHistoryError } from "./history-validation.js"

export const workAgentBindingLaneOperationMaxRecords = 16_384
export const workAgentBindingLaneOperationMaxBytes = 2 * 1024 * 1024

export const agentBindingAdmissionError = (input: {
  readonly history: ReadonlyArray<WorkGoalCheckpoint>
  readonly candidate: WorkGoalCheckpoint
  readonly operationCount: number
  readonly operationBytes: number
  readonly candidateOperationBytes: number
}): WorkProjectionError | undefined => {
  if (input.history.length >= workHistoryMaxEvents) {
    return new WorkProjectionError({
      cause: input.candidate,
      detail: `work history cannot exceed ${workHistoryMaxEvents} checkpoints`,
      reason: "capacity_exceeded"
    })
  }
  const historyError = workHistoryError([...input.history, input.candidate])
  if (historyError !== undefined) return historyError
  if (input.operationCount >= workAgentBindingLaneOperationMaxRecords) {
    return new WorkProjectionError({
      cause: input.candidate,
      detail: `work lane operation history cannot exceed ${workAgentBindingLaneOperationMaxRecords} operation IDs`,
      reason: "capacity_exceeded"
    })
  }
  if (
    input.operationBytes + input.candidateOperationBytes >
      workAgentBindingLaneOperationMaxBytes
  ) {
    return new WorkProjectionError({
      cause: input.candidate,
      detail: `work lane operation history cannot exceed ${workAgentBindingLaneOperationMaxBytes} encoded bytes`,
      reason: "capacity_exceeded"
    })
  }
}
