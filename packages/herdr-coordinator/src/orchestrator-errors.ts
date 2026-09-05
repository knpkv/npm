import { Schema } from "effect"

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)

export class OrchestratorValidationError extends Schema.TaggedError<OrchestratorValidationError>()(
  "OrchestratorValidationError",
  { detail: Schema.String }
) {}

export class OrchestratorStorageError extends Schema.TaggedError<OrchestratorStorageError>()(
  "OrchestratorStorageError",
  { operation: Schema.String, cause: Schema.Defect() }
) {}

export class OrchestratorConflictError extends Schema.TaggedError<OrchestratorConflictError>()(
  "OrchestratorConflictError",
  { idempotencyKey: Identifier, detail: Schema.String }
) {}

export class OrchestratorNotFoundError extends Schema.TaggedError<OrchestratorNotFoundError>()(
  "OrchestratorNotFoundError",
  { dispatchRequestId: Identifier }
) {}

export class OrchestratorTransitionError extends Schema.TaggedError<OrchestratorTransitionError>()(
  "OrchestratorTransitionError",
  { dispatchRequestId: Identifier, from: Schema.String, to: Schema.String }
) {}

export class OrchestratorWorkerBindingConflictError
  extends Schema.TaggedError<OrchestratorWorkerBindingConflictError>()(
    "OrchestratorWorkerBindingConflictError",
    { dispatchRequestId: Identifier }
  )
{}

/** The accepted Work handoff no longer owns the lane revision needed for dispatch. */
export class OrchestratorWorkRevisionConflictError extends Schema.TaggedError<OrchestratorWorkRevisionConflictError>()(
  "OrchestratorWorkRevisionConflictError",
  {
    laneId: Identifier,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number
  }
) {}

export class OrchestratorWorkerStartAuthorityError extends Schema.TaggedError<OrchestratorWorkerStartAuthorityError>()(
  "OrchestratorWorkerStartAuthorityError",
  {
    laneId: Identifier,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
    reason: Schema.Literals([
      "accepted_revision_mismatch",
      "missing_lane",
      "stale_revision",
      "shipped_lane",
      "missing_goal",
      "terminal_goal"
    ])
  }
) {}

export type OrchestratorError =
  | OrchestratorValidationError
  | OrchestratorStorageError
  | OrchestratorConflictError
  | OrchestratorNotFoundError
  | OrchestratorTransitionError
  | OrchestratorWorkRevisionConflictError
  | OrchestratorWorkerBindingConflictError
  | OrchestratorWorkerStartAuthorityError
