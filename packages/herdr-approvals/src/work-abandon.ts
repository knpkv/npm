import { type ApprovedJobIdentity, FleetOperationError, type JobActor } from "@knpkv/herdr-fleet"
import type { WorkAbandon } from "@knpkv/herdr-fleet/model"
import type { WorkService } from "@knpkv/herdr-work"
import { Effect } from "effect"

/**
 * Executes an approved `work.abandon` job against the host's Work store.
 * Compose it into `HostOperations.run` with the approval the Fleet service
 * passes in, and declare `"work.abandon"` in `HostOperations.workJobKinds`
 * so submission accepts the job; a job without persisted approval never
 * reaches the store.
 */
export const runWorkAbandon = Effect.fn("HostOperations.workAbandon")(function*(
  work: Pick<WorkService, "abandon">,
  payload: WorkAbandon,
  jobId: string,
  actor: JobActor,
  approval: ApprovedJobIdentity | null
) {
  if (approval === null) {
    return yield* new FleetOperationError({
      cause: jobId,
      detail: "work.abandon requires a persisted Fleet approval",
      operation: "work.abandon"
    })
  }
  const result = yield* work.abandon({
    ...payload,
    approvalJobId: jobId,
    approvalActor: actor,
    approvalApprovedBy: approval.approvedBy,
    approvalApprovedAt: approval.approvedAt,
    approvalHash: approval.hash
  }).pipe(
    Effect.mapError((error) => new FleetOperationError({ cause: error, detail: error._tag, operation: "work.abandon" }))
  )
  return JSON.stringify({
    goalId: result.checkpoint.goal.id,
    eventId: result.checkpoint.eventId,
    state: result.checkpoint.goal.state
  })
})
