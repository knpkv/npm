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
