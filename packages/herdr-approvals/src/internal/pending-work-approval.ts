import {
  FleetStoreError,
  isWorkJobKind,
  type JobRecord,
  type JobStore,
  type PendingApprovalCursor
} from "@knpkv/herdr-fleet"
import { Clock, Effect } from "effect"

const pageSize = 100

/**
 * Whether any Work job (admit, recover, reconcile, reassign) is waiting for
 * approval. Such a job's preflight tokens hash the whole Work store, so a
 * writer that wants to keep pending approvals valid defers its writes while
 * this is true. Pages through the pending jobs, newest first, and stops at
 * the first Work job whose approval has not expired.
 */
export const hasPendingWorkApproval = (
  jobs: JobStore
): Effect.Effect<boolean, FleetStoreError> => {
  // Fleet marks an expired approval only when something reads that job, so a
  // stored `pending_approval` past its expiry no longer counts as pending.
  const page = (cursor: PendingApprovalCursor | null, now: number): Effect.Effect<boolean, FleetStoreError> =>
    jobs.listPending(cursor, pageSize).pipe(
      Effect.flatMap((pending) => {
        const live = ({ approvalExpiresAt }: JobRecord) =>
          approvalExpiresAt === null || approvalExpiresAt === undefined || approvalExpiresAt > now
        if (pending.some((job) => isWorkJobKind(job.payload.kind) && live(job))) return Effect.succeed(true)
        const last = pending.at(-1)
        return last === undefined || pending.length < pageSize
          ? Effect.succeed(false)
          : page({ createdAt: last.createdAt, id: last.id }, now)
      })
    )
  return Clock.currentTimeMillis.pipe(Effect.flatMap((now) => page(null, now)))
}

/** Without a job store there is nothing to read, so the question cannot be answered. */
export const noJobStore: Effect.Effect<boolean, FleetStoreError> = Effect.fail(
  new FleetStoreError({
    cause: null,
    detail: "hostd composed operations without its job store",
    operation: "pending-work-approval"
  })
)
