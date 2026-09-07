import { Schema } from "effect"

export class FleetValidationError extends Schema.TaggedError<FleetValidationError>()(
  "FleetValidationError",
  { detail: Schema.String }
) {}

export class FleetAuthorizationError extends Schema.TaggedError<FleetAuthorizationError>()(
  "FleetAuthorizationError",
  { actor: Schema.String }
) {}

export class FleetStoreError extends Schema.TaggedError<FleetStoreError>()(
  "FleetStoreError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect()
  }
) {}

export class FleetTransitionConflictError extends Schema.TaggedError<FleetTransitionConflictError>()(
  "FleetTransitionConflictError",
  { jobId: Schema.String }
) {}

export class FleetJobConflictError extends Schema.TaggedError<FleetJobConflictError>()(
  "FleetJobConflictError",
  { jobId: Schema.String }
) {}

export class FleetJobNotFoundError extends Schema.TaggedError<FleetJobNotFoundError>()(
  "FleetJobNotFoundError",
  { jobId: Schema.String }
) {}

export class FleetApprovalError extends Schema.TaggedError<FleetApprovalError>()(
  "FleetApprovalError",
  { jobId: Schema.String, detail: Schema.String }
) {}

export class FleetOperationError extends Schema.TaggedError<FleetOperationError>()(
  "FleetOperationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect()
  }
) {}

export class FleetResponseBodyError extends Schema.TaggedError<FleetResponseBodyError>()(
  "FleetResponseBodyError",
  {
    cause: Schema.Defect(),
    detail: Schema.String,
    reason: Schema.Literals(["decode", "too_large", "transport"])
  }
) {}

export class PeerPendingTransportError extends Schema.TaggedError<PeerPendingTransportError>()(
  "PeerPendingTransportError",
  {
    host: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect()
  }
) {}

export class PeerPendingStatusError extends Schema.TaggedError<PeerPendingStatusError>()(
  "PeerPendingStatusError",
  { host: Schema.String, status: Schema.Number }
) {}

export class PeerPendingDecodeError extends Schema.TaggedError<PeerPendingDecodeError>()(
  "PeerPendingDecodeError",
  {
    host: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect()
  }
) {}

export class PeerPendingHostMismatchError extends Schema.TaggedError<PeerPendingHostMismatchError>()(
  "PeerPendingHostMismatchError",
  { expectedHost: Schema.String, receivedHost: Schema.String }
) {}

export class PeerPendingTimeoutError extends Schema.TaggedError<PeerPendingTimeoutError>()(
  "PeerPendingTimeoutError",
  { host: Schema.String, timeoutMs: Schema.Number }
) {}

export class PeerPendingUnavailableError extends Schema.TaggedError<PeerPendingUnavailableError>()(
  "PeerPendingUnavailableError",
  {
    host: Schema.String,
    reason: Schema.Literals(["offline", "unavailable"])
  }
) {}
