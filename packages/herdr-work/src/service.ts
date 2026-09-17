import { Clock, Effect } from "effect"
import type { Option } from "effect"
import type {
  WorkAgentBindingAuthorityError,
  WorkAgentBindingConflictError,
  WorkCheckpointConflictError,
  WorkCoordinatorHandoffConflictError,
  WorkDecisionAuthorityConflictError,
  WorkDecisionHandoffConflictError,
  WorkDecisionRevisionConflictError,
  WorkLaneClaimConflictError,
  WorkLaneGoalConflictError,
  WorkLaneOperationConflictError,
  WorkProjectionError,
  WorkStoreError,
  WorkTransactionConflictError
} from "./errors.js"
import type {
  WorkAgentBinding,
  WorkAgentBindingRequest,
  WorkDecisionHandoff,
  WorkGoalCheckpoint,
  WorkLaneClaim,
  WorkLaneClaimed,
  WorkSnapshots
} from "./model.js"
import { projectWorkSnapshots } from "./projection.js"
import type { WorkStoreService } from "./store.js"

export interface WorkService {
  readonly bindAgent: (
    request: WorkAgentBindingRequest
  ) => Effect.Effect<
    WorkAgentBinding,
    WorkAgentBindingAuthorityError | WorkAgentBindingConflictError | WorkProjectionError | WorkStoreError
  >
  readonly agentBinding: (
    dispatchRequestId: string
  ) => Effect.Effect<Option.Option<WorkAgentBinding>, WorkStoreError>
  readonly record: (
    event: WorkGoalCheckpoint
  ) => Effect.Effect<
    WorkGoalCheckpoint,
    WorkCheckpointConflictError | WorkProjectionError | WorkStoreError
  >
  /**
   * Projects history at an explicit timestamp, or at the later of the current
   * clock and the coordinator-owned logical timestamp when none is given.
   */
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
  ) => Effect.Effect<
    WorkLaneClaimed,
    | WorkLaneClaimConflictError
    | WorkLaneGoalConflictError
    | WorkLaneOperationConflictError
    | WorkProjectionError
    | WorkStoreError
  >
  readonly currentClaim: (
    laneId: string
  ) => Effect.Effect<Option.Option<WorkLaneClaimed>, WorkStoreError>
  readonly activeGoalClaim: (
    goalId: string
  ) => Effect.Effect<Option.Option<WorkLaneClaimed>, WorkStoreError>
  readonly handoff: (
    handoff: WorkDecisionHandoff
  ) => Effect.Effect<
    WorkDecisionHandoff,
    | WorkCoordinatorHandoffConflictError
    | WorkDecisionAuthorityConflictError
    | WorkDecisionHandoffConflictError
    | WorkDecisionRevisionConflictError
    | WorkProjectionError
    | WorkStoreError
  >
  readonly coordinatorHandoff: (
    sessionId: string
  ) => Effect.Effect<Option.Option<WorkDecisionHandoff>, WorkStoreError>
  readonly decisions: (
    laneId: string
  ) => Effect.Effect<ReadonlyArray<WorkDecisionHandoff>, WorkStoreError>
}

export const makeWorkService = Effect.fn("HerdrWork.makeService")(function(store: WorkStoreService) {
  const bindAgent = Effect.fn("HerdrWork.bindAgent")((request: WorkAgentBindingRequest) => store.bindAgent(request))
  const agentBinding = Effect.fn("HerdrWork.agentBinding")((dispatchRequestId: string) =>
    store.agentBinding(dispatchRequestId)
  )
  const record = Effect.fn("HerdrWork.record")((event: WorkGoalCheckpoint) => store.append(event))
  const snapshots = Effect.fn("HerdrWork.snapshots")(function*(observedAt?: number) {
    const source = yield* store.snapshotInput()
    const timestamp = observedAt ?? Math.max(
      yield* Clock.currentTimeMillis,
      source.logicalObservedAt ?? 0
    )
    return yield* projectWorkSnapshots(source.events, timestamp)
  })
  const recordMany = Effect.fn("HerdrWork.recordMany")((
    transactionId: string,
    events: ReadonlyArray<WorkGoalCheckpoint>
  ) => store.appendMany(transactionId, events))
  const claim = Effect.fn("HerdrWork.claim")((lane: WorkLaneClaim) => store.claim(lane))
  const currentClaim = Effect.fn("HerdrWork.currentClaim")((laneId: string) => store.currentClaim(laneId))
  const activeGoalClaim = Effect.fn("HerdrWork.activeGoalClaim")((goalId: string) => store.activeGoalClaim(goalId))
  const handoff = Effect.fn("HerdrWork.handoff")((decision: WorkDecisionHandoff) => store.decision(decision))
  const coordinatorHandoff = Effect.fn("HerdrWork.coordinatorHandoff")((sessionId: string) =>
    store.coordinatorHandoff(sessionId)
  )
  const decisions = Effect.fn("HerdrWork.decisions")((laneId: string) => store.decisions(laneId))
  return Effect.succeed(
    {
      agentBinding,
      activeGoalClaim,
      bindAgent,
      claim,
      coordinatorHandoff,
      currentClaim,
      decisions,
      handoff,
      record,
      recordMany,
      snapshots
    } satisfies WorkService
  )
})
