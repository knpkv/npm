import { Schema } from "effect"

export class WorkRecoveryContextError extends Schema.TaggedError<WorkRecoveryContextError>()(
  "WorkRecoveryContextError",
  {
    goalId: Schema.String,
    reason: Schema.Literals(["invalid_goal_id", "missing_goal"])
  }
) {}

export class WorkProjectionError extends Schema.TaggedError<WorkProjectionError>()(
  "WorkProjectionError",
  {
    cause: Schema.Defect(),
    detail: Schema.String,
    reason: Schema.Literals([
      "malformed",
      "duplicate_event",
      "ambiguous_checkpoint",
      "inconsistent_history",
      "capacity_exceeded"
    ])
  }
) {}

export class WorkStoreError extends Schema.TaggedError<WorkStoreError>()(
  "WorkStoreError",
  { cause: Schema.Defect(), operation: Schema.String }
) {}

export class WorkCheckpointConflictError extends Schema.TaggedError<WorkCheckpointConflictError>()(
  "WorkCheckpointConflictError",
  {
    eventId: Schema.String,
    goalId: Schema.String,
    occurredAt: Schema.Number
  }
) {}

export class WorkTransactionConflictError extends Schema.TaggedError<WorkTransactionConflictError>()(
  "WorkTransactionConflictError",
  { transactionId: Schema.String }
) {}

export class WorkLaneClaimConflictError extends Schema.TaggedError<WorkLaneClaimConflictError>()(
  "WorkLaneClaimConflictError",
  {
    laneId: Schema.String,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number
  }
) {}

export class WorkLaneOperationConflictError extends Schema.TaggedError<WorkLaneOperationConflictError>()(
  "WorkLaneOperationConflictError",
  { operationId: Schema.String }
) {}

export class WorkLaneGoalConflictError extends Schema.TaggedError<WorkLaneGoalConflictError>()(
  "WorkLaneGoalConflictError",
  { goalId: Schema.String, laneId: Schema.String, activeLaneId: Schema.String }
) {}

export class WorkDecisionHandoffConflictError extends Schema.TaggedError<WorkDecisionHandoffConflictError>()(
  "WorkDecisionHandoffConflictError",
  { handoffId: Schema.String }
) {}

export class WorkDecisionAuthorityConflictError extends Schema.TaggedError<WorkDecisionAuthorityConflictError>()(
  "WorkDecisionAuthorityConflictError",
  { goalId: Schema.String, laneId: Schema.String }
) {}

export class WorkDecisionRevisionConflictError extends Schema.TaggedError<WorkDecisionRevisionConflictError>()(
  "WorkDecisionRevisionConflictError",
  { laneId: Schema.String, expectedRevision: Schema.Number, actualRevision: Schema.Number }
) {}

export class WorkCoordinatorHandoffConflictError extends Schema.TaggedError<WorkCoordinatorHandoffConflictError>()(
  "WorkCoordinatorHandoffConflictError",
  { sessionId: Schema.String }
) {}

export class WorkDispatchHandoffConflictError extends Schema.TaggedError<WorkDispatchHandoffConflictError>()(
  "WorkDispatchHandoffConflictError",
  { dispatchRequestId: Schema.String, handoffId: Schema.String }
) {}

export class WorkAgentBindingConflictError extends Schema.TaggedError<WorkAgentBindingConflictError>()(
  "WorkAgentBindingConflictError",
  { dispatchRequestId: Schema.String }
) {}

export class WorkAgentBindingAuthorityError extends Schema.TaggedError<WorkAgentBindingAuthorityError>()(
  "WorkAgentBindingAuthorityError",
  {
    laneId: Schema.String,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
    reason: Schema.Literals(["missing_lane", "stale_revision", "shipped_lane", "missing_goal", "terminal_goal"])
  }
) {}

export class WorkPullRequestLinkError extends Schema.TaggedError<WorkPullRequestLinkError>()(
  "WorkPullRequestLinkError",
  {
    goalId: Schema.String,
    laneId: Schema.String,
    reason: Schema.Literals([
      "missing_provenance",
      "missing_goal",
      "missing_lane",
      "missing_binding",
      "stale_revision",
      "head_mismatch",
      "owner_mismatch",
      "session_mismatch",
      "identity_mismatch",
      "terminal_goal",
      "operation_conflict",
      "ambiguous_binding"
    ])
  }
) {}

export class WorkAdmissionConflictError extends Schema.TaggedError<WorkAdmissionConflictError>()(
  "WorkAdmissionConflictError",
  { goalId: Schema.String, laneId: Schema.String, reason: Schema.String }
) {}

/** The goal, or its active lane when `laneId` is set, is not owned by the approved source owner. */
export class WorkGoalOwnerMismatchError extends Schema.TaggedError<WorkGoalOwnerMismatchError>()(
  "WorkGoalOwnerMismatchError",
  {
    goalId: Schema.String,
    laneId: Schema.NullOr(Schema.String),
    expectedOwner: Schema.Struct({ id: Schema.String, name: Schema.String }),
    actualOwner: Schema.Struct({ id: Schema.String, name: Schema.String })
  }
) {}

/** The goal's durable head is not the approved expected event; `actual*` is null when the goal is absent. */
export class WorkGoalRevisionConflictError extends Schema.TaggedError<WorkGoalRevisionConflictError>()(
  "WorkGoalRevisionConflictError",
  {
    goalId: Schema.String,
    expectedEventId: Schema.String,
    expectedUpdatedAt: Schema.Number,
    actualEventId: Schema.NullOr(Schema.String),
    actualUpdatedAt: Schema.NullOr(Schema.Number)
  }
) {}

/** The approval job id already names a different reassignment or another durable record. */
export class WorkGoalReassignmentConflictError extends Schema.TaggedError<WorkGoalReassignmentConflictError>()(
  "WorkGoalReassignmentConflictError",
  {
    approvalJobId: Schema.String,
    reason: Schema.Literals(["payload_mismatch", "identifier_in_use"])
  }
) {}

/** The goal's active lane has a started-worker binding, so a reassignment must name the agent that takes it over. */
export class WorkGoalBindingRequiresAgentError extends Schema.TaggedError<WorkGoalBindingRequiresAgentError>()(
  "WorkGoalBindingRequiresAgentError",
  { goalId: Schema.String, laneId: Schema.String, dispatchRequestId: Schema.String }
) {}

/**
 * The requested agent target cannot be written. `keep_existing_target`: keeping
 * would leave the previous owner's agent on the goal (`holderId` is that goal).
 * `held_by_other_goal` / `held_by_other_lane`: the new agent is already the
 * current target of another goal, or the authoritative binding of another
 * goal's lane (`holderId` is that goal or lane).
 */
export class WorkGoalAgentTargetConflictError extends Schema.TaggedError<WorkGoalAgentTargetConflictError>()(
  "WorkGoalAgentTargetConflictError",
  {
    goalId: Schema.String,
    agentId: Schema.String,
    reason: Schema.Literals(["keep_existing_target", "held_by_other_goal", "held_by_other_lane"]),
    holderId: Schema.String
  }
) {}
