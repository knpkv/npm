import { Clock, Effect, Equal, Option, Schema } from "effect"
import { WorkPullRequestLinkError, WorkRecoveryContextError } from "./errors.js"
import type {
  WorkAdmissionConflictError,
  WorkAgentBindingAuthorityError,
  WorkAgentBindingConflictError,
  WorkCheckpointConflictError,
  WorkCoordinatorHandoffConflictError,
  WorkDecisionAuthorityConflictError,
  WorkDecisionHandoffConflictError,
  WorkDecisionRevisionConflictError,
  WorkGoalAbandonmentConflictError,
  WorkGoalAgentTargetConflictError,
  WorkGoalBindingRequiresAgentError,
  WorkGoalLaneActiveError,
  WorkGoalOwnerMismatchError,
  WorkGoalReassignmentConflictError,
  WorkGoalRevisionConflictError,
  WorkGoalTerminalError,
  WorkLaneClaimConflictError,
  WorkLaneGoalConflictError,
  WorkLaneOperationConflictError,
  WorkProjectionError,
  WorkStoreError,
  WorkTransactionConflictError
} from "./errors.js"
import { workHistoryError } from "./internal/history-validation.js"
import type {
  WorkAdmissionPreflight,
  WorkAdmissionTarget,
  WorkAgentBinding,
  WorkAgentBindingRequest,
  WorkDecisionHandoff,
  WorkExistingGoalRecovery,
  WorkExistingOwnerReconciliation,
  WorkGoalAbandoned,
  WorkGoalAbandonment,
  WorkGoalCheckpoint,
  WorkGoalReassigned,
  WorkGoalReassignment,
  WorkLaneClaim,
  WorkLaneClaimed,
  WorkObservationEnvelope,
  WorkObservedAdmission,
  WorkObserveReport,
  WorkProspectiveAdmission,
  WorkReconcileOutcome,
  WorkRecoveryContext,
  WorkRecoveryPreflight,
  WorkRecoveryTarget,
  WorkSnapshots
} from "./model.js"
import { isTerminalWorkState, WorkGoalId, WorkPullRequestLink, WorkPullRequestLinkRequest } from "./model.js"
import { withActivityProvenance, withObservedFacts, workSnapshotBudgetBytes } from "./observed.js"
import { projectWorkSnapshots } from "./projection.js"
import type { WorkStoreService } from "./store.js"

export interface WorkService {
  /** Exact durable checkpoint facts, not recovery eligibility or approval authority. */
  readonly recoveryContext: (
    goalId: string
  ) => Effect.Effect<WorkRecoveryContext, WorkRecoveryContextError | WorkProjectionError | WorkStoreError>
  readonly recoveryPreflight: (
    target: WorkRecoveryTarget
  ) => Effect.Effect<WorkRecoveryPreflight, WorkProjectionError | WorkStoreError>
  readonly recoverExistingGoal: (
    request: WorkExistingGoalRecovery
  ) => Effect.Effect<WorkPullRequestLink, WorkAdmissionConflictError | WorkProjectionError | WorkStoreError>
  /** Approval-bound owner transfer; replaying the same approval job returns the prior result. */
  readonly reassign: (
    request: WorkGoalReassignment
  ) => Effect.Effect<
    WorkGoalReassigned,
    | WorkGoalAgentTargetConflictError
    | WorkGoalBindingRequiresAgentError
    | WorkGoalOwnerMismatchError
    | WorkGoalReassignmentConflictError
    | WorkGoalRevisionConflictError
    | WorkProjectionError
    | WorkStoreError
  >
  /**
   * Approval-bound move of a goal to `abandoned`; refuses a goal with an active
   * lane or one already finished. Replaying the same approval job returns the
   * prior result.
   */
  readonly abandon: (
    request: WorkGoalAbandonment
  ) => Effect.Effect<
    WorkGoalAbandoned,
    | WorkGoalAbandonmentConflictError
    | WorkGoalLaneActiveError
    | WorkGoalOwnerMismatchError
    | WorkGoalRevisionConflictError
    | WorkGoalTerminalError
    | WorkProjectionError
    | WorkStoreError
  >
  readonly admissionPreflight: (
    target: WorkAdmissionTarget
  ) => Effect.Effect<WorkAdmissionPreflight, WorkProjectionError | WorkStoreError>
  readonly admitExistingOwner: (
    request: WorkProspectiveAdmission
  ) => Effect.Effect<WorkPullRequestLink, WorkAdmissionConflictError | WorkProjectionError | WorkStoreError>
  /**
   * Admits a worker the reconciler observed, without an approval: the same
   * write as `admitExistingOwner`, credited to the observation. The caller has
   * checked the pane's host, lineage and worktree; the store re-checks the
   * absence evidence.
   */
  readonly admitObserved: (
    request: WorkObservedAdmission
  ) => Effect.Effect<WorkPullRequestLink, WorkAdmissionConflictError | WorkProjectionError | WorkStoreError>
  readonly inspectPullRequest: (
    request: WorkPullRequestLinkRequest
  ) => Effect.Effect<WorkPullRequestLink, WorkPullRequestLinkError | WorkProjectionError | WorkStoreError>
  readonly reconcileExistingOwner: (
    request: WorkExistingOwnerReconciliation
  ) => Effect.Effect<
    WorkLaneClaimed,
    | WorkPullRequestLinkError
    | WorkLaneClaimConflictError
    | WorkLaneGoalConflictError
    | WorkLaneOperationConflictError
    | WorkProjectionError
    | WorkStoreError
  >
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
   * Records goals whose pull request is observed merged or closed as completed
   * or abandoned. Run it after `observe`; it never writes anything else.
   */
  readonly reconcile: () => Effect.Effect<
    ReadonlyArray<WorkReconcileOutcome>,
    WorkCheckpointConflictError | WorkProjectionError | WorkStoreError
  >
  /**
   * Stores observed facts (a pull request's state, an agent's status) for the
   * Work tab. Facts are not goal history and never change an approval token.
   */
  readonly observe: (
    envelopes: ReadonlyArray<WorkObservationEnvelope>
  ) => Effect.Effect<WorkObserveReport, WorkStoreError>
  /**
   * Projects history at an explicit timestamp, or at the later of the current
   * clock and the coordinator-owned logical timestamp when none is given. The
   * `now` window also carries each goal's observed facts.
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
    | WorkPullRequestLinkError
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
  const recoveryContext = Effect.fn("HerdrWork.recoveryContext")(function*(goalId: string) {
    const id = yield* Schema.decodeUnknownEffect(WorkGoalId)(goalId).pipe(
      Effect.mapError(() => new WorkRecoveryContextError({ goalId, reason: "invalid_goal_id" }))
    )
    const source = yield* store.snapshotInput()
    const error = workHistoryError(source.events)
    if (error !== undefined) return yield* error
    const latest = source.events.filter(({ goal }) => goal.id === id).at(-1)
    if (latest === undefined) {
      return yield* new WorkRecoveryContextError({
        goalId: id,
        reason: "missing_goal"
      })
    }
    return {
      goalId: id,
      expectedGoalEventId: latest.eventId,
      expectedGoalUpdatedAt: latest.goal.updatedAt
    } satisfies WorkRecoveryContext
  })
  const recoveryPreflight = Effect.fn("HerdrWork.recoveryPreflight")((target: WorkRecoveryTarget) =>
    store.recoveryPreflight(target)
  )
  const recoverExistingGoal = Effect.fn("HerdrWork.recoverExistingGoal")((request: WorkExistingGoalRecovery) =>
    store.recoverExistingGoal(request)
  )
  const reassign = Effect.fn("HerdrWork.reassign")((request: WorkGoalReassignment) => store.reassign(request))
  const abandon = Effect.fn("HerdrWork.abandon")((request: WorkGoalAbandonment) => store.abandon(request))
  const admissionPreflight = Effect.fn("HerdrWork.admissionPreflight")((target: WorkAdmissionTarget) =>
    store.admissionPreflight(target)
  )
  const admitExistingOwner = Effect.fn("HerdrWork.admitExistingOwner")((request: WorkProspectiveAdmission) =>
    store.admitExistingOwner(request)
  )
  const admitObserved = Effect.fn("HerdrWork.admitObserved")((request: WorkObservedAdmission) =>
    store.admitObserved(request)
  )
  const linkError = (request: WorkPullRequestLinkRequest, reason: WorkPullRequestLinkError["reason"]) =>
    new WorkPullRequestLinkError({ goalId: request.goalId, laneId: request.laneId, reason })
  const inspectPullRequest = Effect.fn("HerdrWork.inspectPullRequest")(function*(request: WorkPullRequestLinkRequest) {
    const decoded = yield* Schema.decodeUnknownEffect(WorkPullRequestLinkRequest)(request).pipe(
      Effect.mapError(() => linkError(request, "identity_mismatch"))
    )
    const source = yield* store.snapshotInput()
    const observedAt = Math.max(yield* Clock.currentTimeMillis, source.logicalObservedAt ?? 0)
    const snapshot = yield* projectWorkSnapshots(source.events, observedAt)
    const goal = snapshot.now.goals.find(({ id }) => id === decoded.goalId)
    if (goal === undefined) {
      return yield* linkError(decoded, "missing_provenance")
    }
    if (
      goal.review?.url !== `https://github.com/${decoded.repository}/pull/${decoded.pullRequest}` ||
      goal.goalFamily?.role !== "canonical" || goal.goalFamily.canonicalGoalId !== goal.id
    ) {
      return yield* linkError(decoded, "missing_provenance")
    }
    if (isTerminalWorkState(goal.state)) {
      return yield* linkError(decoded, "terminal_goal")
    }
    const goalEvent = source.events.filter(({ goal: candidate }) => candidate.id === goal.id).at(-1)
    if (goalEvent === undefined || !Equal.equals(goalEvent.goal, goal)) {
      return yield* linkError(decoded, "missing_provenance")
    }
    const lane = yield* store.currentClaim(decoded.laneId)
    if (Option.isNone(lane) || lane.value.goalId !== goal.id || lane.value.phase === "shipped") {
      return yield* linkError(decoded, "missing_lane")
    }
    const bindingIds = yield* store.bindingDispatchesForLane(decoded.laneId)
    const bindingId = bindingIds[0]
    if (bindingId === undefined) {
      return yield* linkError(decoded, "missing_binding")
    }
    const binding = yield* store.agentBinding(bindingId)
    if (Option.isNone(binding)) {
      return yield* linkError(decoded, "missing_binding")
    }
    const after = yield* store.snapshotInput()
    const afterEvent = after.events.filter(({ goal: candidate }) => candidate.id === goal.id).at(-1)
    const afterLane = yield* store.currentClaim(decoded.laneId)
    if (
      afterEvent?.eventId !== goalEvent.eventId || Option.isNone(afterLane) ||
      afterLane.value.revision !== lane.value.revision
    ) {
      return yield* linkError(decoded, "stale_revision")
    }
    return yield* Schema.decodeUnknownEffect(WorkPullRequestLink)({
      request: decoded,
      goalEventId: goalEvent.eventId,
      goal,
      lane: lane.value,
      binding: binding.value
    }).pipe(Effect.mapError(() => linkError(decoded, "identity_mismatch")))
  })
  const reconcileExistingOwner = Effect.fn("HerdrWork.reconcileExistingOwner")(function*(
    request: WorkExistingOwnerReconciliation
  ) {
    const lane = yield* store.currentClaim(request.laneId)
    if (Option.isNone(lane)) return yield* linkError(request, "missing_lane")
    return yield* store.claim({
      operationId: request.operationId,
      goalId: request.goalId,
      laneId: request.laneId,
      worktree: request.worktree,
      branch: request.branch,
      head: request.newHead,
      owner: request.expectedOwner,
      parent: lane.value.parent,
      phase: lane.value.phase,
      expectedRevision: request.expectedRevision,
      reconciliation: {
        repository: request.repository,
        pullRequest: request.pullRequest,
        expectedHead: request.expectedHead,
        expectedOwner: request.expectedOwner,
        expectedGoalEventId: request.expectedGoalEventId,
        bindingDispatchRequestId: request.bindingDispatchRequestId,
        sessionId: request.sessionId,
        worker: request.worker
      }
    })
  })
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
    // Provenance first: an unknown author is worse than a missing observation.
    return withObservedFacts(
      withActivityProvenance(
        yield* projectWorkSnapshots(source.events, timestamp),
        source.approvals,
        [...source.reconcilerEvents, ...source.observedAdmissions],
        source.activityOrigins,
        workSnapshotBudgetBytes
      ),
      source.facts,
      source.failures,
      workSnapshotBudgetBytes
    )
  })
  const observe = Effect.fn("HerdrWork.observe")((envelopes: ReadonlyArray<WorkObservationEnvelope>) =>
    store.observe(envelopes)
  )
  const reconcile = Effect.fn("HerdrWork.reconcile")(() => store.reconcile())
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
      recoveryContext,
      recoveryPreflight,
      recoverExistingGoal,
      reassign,
      abandon,
      admissionPreflight,
      admitExistingOwner,
      admitObserved,
      agentBinding,
      inspectPullRequest,
      reconcileExistingOwner,
      activeGoalClaim,
      bindAgent,
      claim,
      coordinatorHandoff,
      currentClaim,
      decisions,
      handoff,
      observe,
      reconcile,
      record,
      recordMany,
      snapshots
    } satisfies WorkService
  )
})
