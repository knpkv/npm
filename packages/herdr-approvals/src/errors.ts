import { Schema } from "effect"

export class ApprovalAppStoreError extends Schema.TaggedError<ApprovalAppStoreError>()(
  "ApprovalAppStoreError",
  { cause: Schema.Defect(), detail: Schema.String, operation: Schema.String }
) {}

export class DashboardResponseBudgetError extends Schema.TaggedError<DashboardResponseBudgetError>()(
  "DashboardResponseBudgetError",
  { encodedBytes: Schema.Number, maximumBytes: Schema.Number }
) {}

export class PushDeliveryError extends Schema.TaggedError<PushDeliveryError>()(
  "PushDeliveryError",
  { cause: Schema.Defect(), operation: Schema.String, statusCode: Schema.NullOr(Schema.Number) }
) {}

export class PushEndpointNotAllowedError extends Schema.TaggedError<PushEndpointNotAllowedError>()(
  "PushEndpointNotAllowedError",
  { origin: Schema.String }
) {}

export class PushSubscriptionCleanupError extends Schema.TaggedError<PushSubscriptionCleanupError>()(
  "PushSubscriptionCleanupError",
  { cause: Schema.Defect() }
) {}

export class HostdOperationsCompositionError extends Schema.TaggedError<HostdOperationsCompositionError>()(
  "HostdOperationsCompositionError",
  { cause: Schema.Defect(), detail: Schema.String }
) {}
