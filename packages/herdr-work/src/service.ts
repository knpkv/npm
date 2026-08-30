import { Clock, Effect } from "effect"
import type { WorkCheckpointConflictError, WorkProjectionError, WorkStoreError } from "./errors.js"
import type { WorkGoalCheckpoint, WorkSnapshots } from "./model.js"
import { projectWorkSnapshots } from "./projection.js"
import type { WorkStoreService } from "./store.js"

export interface WorkService {
  readonly record: (
    event: WorkGoalCheckpoint
  ) => Effect.Effect<
    WorkGoalCheckpoint,
    WorkCheckpointConflictError | WorkProjectionError | WorkStoreError
  >
  readonly snapshots: (observedAt?: number) => Effect.Effect<WorkSnapshots, WorkStoreError | WorkProjectionError>
}

export const makeWorkService = Effect.fn("HerdrWork.makeService")(function*(store: WorkStoreService) {
  const record = Effect.fn("HerdrWork.record")((event: WorkGoalCheckpoint) => store.append(event))
  const snapshots = Effect.fn("HerdrWork.snapshots")(function*(observedAt?: number) {
    const timestamp = observedAt ?? (yield* Clock.currentTimeMillis)
    return yield* store.list().pipe(Effect.flatMap((events) => projectWorkSnapshots(events, timestamp)))
  })
  return { record, snapshots } satisfies WorkService
})
