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
  { operation: Schema.String, cause: Schema.Unknown }
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

export type OrchestratorError =
  | OrchestratorValidationError
  | OrchestratorStorageError
  | OrchestratorConflictError
  | OrchestratorNotFoundError
  | OrchestratorTransitionError
