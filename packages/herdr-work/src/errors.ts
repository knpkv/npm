import { Schema } from "effect"

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

export class WorkDecisionHandoffConflictError extends Schema.TaggedError<WorkDecisionHandoffConflictError>()(
  "WorkDecisionHandoffConflictError",
  { handoffId: Schema.String }
) {}
