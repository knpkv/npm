import { type ApprovedJobIdentity, FleetOperationError, type JobActor } from "@knpkv/herdr-fleet"
import type { WorkReassign } from "@knpkv/herdr-fleet/model"
import type { WorkService } from "@knpkv/herdr-work"
import { Effect } from "effect"

/**
 * Executes an approved `work.reassign` job against the host's Work store.
 * Compose it into `HostOperations.run` with the approval the Fleet service
 * passes in; a job without persisted approval never reaches the store.
 */
export const runWorkReassign = Effect.fn("HostOperations.workReassign")(function*(
  work: Pick<WorkService, "reassign">,
  payload: WorkReassign,
  jobId: string,
  actor: JobActor,
  approval: ApprovedJobIdentity | null
) {
  if (approval === null) {
    return yield* new FleetOperationError({
      cause: jobId,
      detail: "work.reassign requires a persisted Fleet approval",
      operation: "work.reassign"
    })
  }
  const result = yield* work.reassign({
    ...payload,
    approvalJobId: jobId,
    approvalActor: actor,
    approvalApprovedBy: approval.approvedBy,
    approvalApprovedAt: approval.approvedAt,
    approvalHash: approval.hash
  }).pipe(
    Effect.mapError((error) =>
      new FleetOperationError({ cause: error, detail: error._tag, operation: "work.reassign" })
    )
  )
  return JSON.stringify({
    goalId: result.checkpoint.goal.id,
    eventId: result.checkpoint.eventId,
    owner: result.checkpoint.goal.owner,
    laneId: result.lane?.laneId ?? null,
    laneRevision: result.lane?.revision ?? null,
    bindingDispatchRequestId: result.binding?.request.dispatchRequestId ?? null
  })
})
