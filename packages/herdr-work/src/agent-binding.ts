import { agentConnectTarget } from "@knpkv/herdr-fleet/model"
import { Schema } from "effect"
import {
  WorkAgentBinding,
  type WorkAgentBindingRequest,
  type WorkGoalCheckpoint,
  type WorkLaneClaimed
} from "./model.js"

/** Builds the single checkpoint and lane revision committed when a worker starts. */
export const makeWorkAgentBinding = (
  request: WorkAgentBindingRequest,
  currentLane: WorkLaneClaimed,
  currentCheckpoint: WorkGoalCheckpoint,
  occurredAt: number
): WorkAgentBinding =>
  Schema.decodeUnknownSync(WorkAgentBinding)({
    version: "herdr.work.agent-binding.v1",
    request,
    lane: {
      ...currentLane,
      operationId: request.dispatchRequestId,
      expectedRevision: request.expectedRevision,
      revision: request.expectedRevision + 1
    },
    checkpoint: {
      eventId: request.dispatchRequestId,
      goal: {
        ...currentCheckpoint.goal,
        agentHierarchy: { agent: request.worker },
        connectTarget: agentConnectTarget(request.worker),
        updatedAt: occurredAt
      },
      occurredAt,
      version: "herdr.work.event.v1"
    }
  })
