import { Schema } from "effect"

export class CoordinatorLifecycleMalformedError extends Schema.TaggedError<CoordinatorLifecycleMalformedError>()(
  "CoordinatorLifecycleMalformedError",
  { detail: Schema.String }
) {}

export class CoordinatorLifecycleMissingEventError extends Schema.TaggedError<CoordinatorLifecycleMissingEventError>()(
  "CoordinatorLifecycleMissingEventError",
  { event: Schema.Literals(["started", "completed"]) }
) {}

export class CoordinatorLifecycleConflictError extends Schema.TaggedError<CoordinatorLifecycleConflictError>()(
  "CoordinatorLifecycleConflictError",
  {
    reason: Schema.Literals([
      "duplicate_started",
      "duplicate_completed",
      "completed_before_started",
      "request_mismatch",
      "job_mismatch"
    ])
  }
) {}

export class ChatHistoryError extends Schema.TaggedError<ChatHistoryError>()(
  "ChatHistoryError",
  { cause: Schema.Defect(), detail: Schema.String, operation: Schema.String }
) {}
