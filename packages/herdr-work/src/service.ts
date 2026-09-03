import { Clock, Effect } from "effect"
import type { Option } from "effect"
import type {
  WorkCheckpointConflictError,
  WorkDecisionHandoffConflictError,
  WorkLaneClaimConflictError,
  WorkProjectionError,
  WorkStoreError,
  WorkTransactionConflictError
} from "./errors.js"
import type { WorkDecisionHandoff, WorkGoalCheckpoint, WorkLaneClaim, WorkLaneClaimed, WorkSnapshots } from "./model.js"
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
  readonly recordMany: (
    transactionId: string,
    events: ReadonlyArray<WorkGoalCheckpoint>
  ) => Effect.Effect<
    ReadonlyArray<WorkGoalCheckpoint>,
    WorkCheckpointConflictError | WorkProjectionError | WorkTransactionConflictError | WorkStoreError
  >
  readonly claim: (
    claim: WorkLaneClaim
  ) => Effect.Effect<WorkLaneClaimed, WorkLaneClaimConflictError | WorkStoreError>
  readonly currentClaim: (
    laneId: string
  ) => Effect.Effect<Option.Option<WorkLaneClaimed>, WorkStoreError>
  readonly handoff: (
    handoff: WorkDecisionHandoff
  ) => Effect.Effect<
    WorkDecisionHandoff,
    WorkDecisionHandoffConflictError | WorkProjectionError | WorkStoreError
  >
  readonly decisions: (
    laneId: string
  ) => Effect.Effect<ReadonlyArray<WorkDecisionHandoff>, WorkStoreError>
}

export const makeWorkService = Effect.fn("HerdrWork.makeService")(function*(store: WorkStoreService) {
  const record = Effect.fn("HerdrWork.record")((event: WorkGoalCheckpoint) => store.append(event))
  const snapshots = Effect.fn("HerdrWork.snapshots")(function*(observedAt?: number) {
    const timestamp = observedAt ?? (yield* Clock.currentTimeMillis)
    return yield* store.list().pipe(Effect.flatMap((events) => projectWorkSnapshots(events, timestamp)))
  })
  const recordMany = Effect.fn("HerdrWork.recordMany")((
    transactionId: string,
    events: ReadonlyArray<WorkGoalCheckpoint>
  ) => store.appendMany(transactionId, events))
  const claim = Effect.fn("HerdrWork.claim")((lane: WorkLaneClaim) => store.claim(lane))
  const currentClaim = Effect.fn("HerdrWork.currentClaim")((laneId: string) => store.currentClaim(laneId))
  const handoff = Effect.fn("HerdrWork.handoff")((decision: WorkDecisionHandoff) => store.decision(decision))
  const decisions = Effect.fn("HerdrWork.decisions")((laneId: string) => store.decisions(laneId))
  return { claim, currentClaim, decisions, handoff, record, recordMany, snapshots } satisfies WorkService
})
