import { type AgentWorkerIdentity, FleetStoreError, type JobStore } from "@knpkv/herdr-fleet"
import { Effect } from "effect"

/**
 * The worker Fleet recorded as started for one job, or null when the job is
 * unknown or no worker started for it. Fleet's job record is the authority
 * for which agent a job started: pane metadata can be written by any local
 * agent. A store that can't be read fails, never answers null.
 */
export const startedWorker = Effect.fn("Hostd.startedWorker")(function*(jobs: JobStore, jobId: string) {
  const job = yield* jobs.get(jobId)
  return job?.worker ?? null
})

/** Without a job store there is no record to read, so the question cannot be answered. */
export const noStartedWorkerStore = (_jobId: string): Effect.Effect<AgentWorkerIdentity | null, FleetStoreError> =>
  Effect.fail(
    new FleetStoreError({
      cause: null,
      detail: "hostd composed operations without its job store",
      operation: "started-worker"
    })
  )
