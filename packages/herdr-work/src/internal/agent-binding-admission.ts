import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet"
import type { Schema } from "effect"
import { WorkProjectionError } from "../errors.js"
import { type WorkGoalCheckpoint, workHistoryMaxEvents } from "../model.js"
import { workHistoryError } from "./history-validation.js"

const encodedBytes = (value: typeof Schema.Json.Type): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength

const maximumTimestamp = 8_640_000_000_000_000
export const workAgentBindingLaneOperationMaxRecords = 16_384
export const workAgentBindingLaneOperationMaxBytes = 2 * 1024 * 1024
export const workAgentBindingSnapshotEnvelopeMaxBytes = encodedBytes({
  observedAt: maximumTimestamp,
  now: { window: "now", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  day: { window: "day", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  week: { window: "week", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] },
  month: { window: "month", observedAt: maximumTimestamp, asOf: maximumTimestamp, goals: [], families: [] }
})

export const workMaximumSnapshotBytesForHistory = (
  history: ReadonlyArray<WorkGoalCheckpoint>
): number => {
  const maximumGoalBytes = new Map<string, number>()
  let encodedGoals = 0
  const latest = new Map<string, WorkGoalCheckpoint>()
  for (const event of history) {
    const { goal } = event
    const bytes = encodedBytes(goal)
    const previous = maximumGoalBytes.get(goal.id)
    if (previous === undefined) {
      maximumGoalBytes.set(goal.id, bytes)
      encodedGoals += bytes
    } else if (bytes > previous) {
      maximumGoalBytes.set(goal.id, bytes)
      encodedGoals += bytes - previous
    }
    const previousLatest = latest.get(goal.id)
    if (previousLatest === undefined || previousLatest.occurredAt <= event.occurredAt) {
      latest.set(goal.id, event)
    }
  }
  const separators = Math.max(0, maximumGoalBytes.size - 1)
  const supersededCounts = new Map<string, number>()
  for (const { goal } of latest.values()) {
    if (goal.goalFamily?.role === "superseded") {
      const count = supersededCounts.get(goal.goalFamily.canonicalGoalId) ?? 0
      supersededCounts.set(goal.goalFamily.canonicalGoalId, count + 1)
    }
  }
  let canonicalBytesSum = 0
  let familyGroupsOverheadSum = 0
  for (const [canonicalGoalId, supersededCount] of supersededCounts) {
    if (supersededCount > 0 && latest.get(canonicalGoalId)?.goal.goalFamily?.role === "canonical") {
      canonicalBytesSum += maximumGoalBytes.get(canonicalGoalId) ?? 0
      familyGroupsOverheadSum += encodedBytes(canonicalGoalId) + 64
    }
  }
  const familiesPerWindowBytes = encodedGoals + canonicalBytesSum + familyGroupsOverheadSum + separators
  return workAgentBindingSnapshotEnvelopeMaxBytes +
    4 * Math.max(encodedGoals + separators, familiesPerWindowBytes)
}

export const workAgentBindingMaximumSnapshotBytes = (
  history: ReadonlyArray<WorkGoalCheckpoint>,
  candidate: WorkGoalCheckpoint
): number => workMaximumSnapshotBytesForHistory([...history, candidate])

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
  if (workAgentBindingMaximumSnapshotBytes(input.history, input.candidate) > fleetResponseBodyMaxBytes) {
    return new WorkProjectionError({
      cause: input.candidate,
      detail: `work snapshots cannot exceed ${fleetResponseBodyMaxBytes} encoded bytes`,
      reason: "capacity_exceeded"
    })
  }
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
