import { FleetStoreError, isWorkJobKind, type JobRecord, type JobStore } from "@knpkv/herdr-fleet"
import { Clock, Effect } from "effect"

/**
 * Whether any Work job (admit, recover, reconcile, reassign) is still to run:
 * waiting for approval, approved and queued, or running. Such a job carries
 * preflight tokens that hash the whole Work store until it runs, so a writer
 * that must keep them valid defers its writes while this is true. A pending
 * approval past its expiry no longer counts: Fleet marks it expired only when
 * something next reads that job.
 */
export const hasOutstandingWorkJob = Effect.fn("Hostd.hasOutstandingWorkJob")(function*(jobs: JobStore) {
  const now = yield* Clock.currentTimeMillis
  const outstanding = (job: JobRecord): boolean =>
    job.status !== "pending_approval" ||
    job.approvalExpiresAt === null ||
    job.approvalExpiresAt === undefined ||
    job.approvalExpiresAt > now
  const recoverable = yield* jobs.listRecoverable()
  return recoverable.some((job) => isWorkJobKind(job.payload.kind) && outstanding(job))
})

/** Without a job store there is nothing to read, so the question cannot be answered. */
export const noJobStore: Effect.Effect<boolean, FleetStoreError> = Effect.fail(
  new FleetStoreError({
    cause: null,
    detail: "hostd composed operations without its job store",
    operation: "outstanding-work-job"
  })
)
