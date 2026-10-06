import { FleetStoreError, isWorkJobKind, type JobStore, type PendingApprovalCursor } from "@knpkv/herdr-fleet"
import { Effect } from "effect"

const pageSize = 100

/**
 * Whether any Work job (admit, recover, reconcile, reassign) is waiting for
 * approval. Such a job's preflight tokens hash the whole Work store, so a
 * writer that wants to keep pending approvals valid defers its writes while
 * this is true. Pages through the pending jobs, newest first, and stops at
 * the first Work job.
 */
export const hasPendingWorkApproval = (
  jobs: JobStore
): Effect.Effect<boolean, FleetStoreError> => {
  const page = (cursor: PendingApprovalCursor | null): Effect.Effect<boolean, FleetStoreError> =>
    jobs.listPending(cursor, pageSize).pipe(
      Effect.flatMap((pending) => {
        if (pending.some(({ payload }) => isWorkJobKind(payload.kind))) return Effect.succeed(true)
        const last = pending.at(-1)
        return last === undefined || pending.length < pageSize
          ? Effect.succeed(false)
          : page({ createdAt: last.createdAt, id: last.id })
      })
    )
  return page(null)
}

/** Without a job store there is nothing to read, so the question cannot be answered. */
export const noJobStore: Effect.Effect<boolean, FleetStoreError> = Effect.fail(
  new FleetStoreError({
    cause: null,
    detail: "hostd composed operations without its job store",
    operation: "pending-work-approval"
  })
)
