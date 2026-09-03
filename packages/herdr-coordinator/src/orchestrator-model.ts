import { JobActor, JobIdentifier, JobPayload } from "@knpkv/herdr-fleet/model"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet/response"
import { Schema } from "effect"

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
const utf8 = new TextEncoder()
const utf8MaxBytes = (maximumBytes: number) =>
  Schema.makeFilter(
    (value: string) => utf8.encode(value).byteLength <= maximumBytes,
    { expected: `UTF-8 text no larger than ${maximumBytes} bytes` }
  )
const UnicodeScalarText = Schema.String.check(
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
export const OrchestratorEventDetail = UnicodeScalarText.check(
  Schema.isMaxLength(fleetResponseBodyMaxBytes),
  utf8MaxBytes(fleetResponseBodyMaxBytes)
)
export const OrchestratorResult = UnicodeScalarText.check(
  Schema.isMaxLength(fleetResponseBodyMaxBytes),
  utf8MaxBytes(fleetResponseBodyMaxBytes)
)
const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)

export const DispatchRequestId = JobIdentifier
export type DispatchRequestId = typeof DispatchRequestId.Type

export const ActivityIdempotencyKey = Identifier
export type ActivityIdempotencyKey = typeof ActivityIdempotencyKey.Type

export const OrchestratorIdempotencyKey = Identifier
export type OrchestratorIdempotencyKey = typeof OrchestratorIdempotencyKey.Type

/** The only command family accepted by the durable coordinator. */
export const OrchestratorCommand = Schema.Struct({
  kind: Schema.Literal("fleet.job"),
  actor: JobActor,
  activityIdempotencyKey: ActivityIdempotencyKey,
  payload: JobPayload
})
export interface OrchestratorCommand extends Schema.Schema.Type<typeof OrchestratorCommand> {}

export const OrchestratorEventType = Schema.Literals([
  "accepted",
  "queued",
  "running",
  "settled",
  "delivery_failed",
  "task_failed"
])
export type OrchestratorEventType = typeof OrchestratorEventType.Type

const orchestratorEventFields = {
  dispatchRequestId: DispatchRequestId,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  activityIdempotencyKey: ActivityIdempotencyKey,
  occurredAt: Timestamp
}

const OrchestratorAcceptedEvent = Schema.Struct({
  ...orchestratorEventFields,
  type: Schema.Literal("accepted"),
  detail: Schema.Null,
  result: Schema.Null
})

const OrchestratorQueuedEvent = Schema.Struct({
  ...orchestratorEventFields,
  type: Schema.Literal("queued"),
  detail: Schema.Null,
  result: Schema.Null
})

const OrchestratorRunningEvent = Schema.Struct({
  ...orchestratorEventFields,
  type: Schema.Literal("running"),
  detail: Schema.Null,
  result: Schema.Null
})

const OrchestratorSettledEvent = Schema.Struct({
  ...orchestratorEventFields,
  type: Schema.Literal("settled"),
  detail: Schema.Null,
  result: OrchestratorResult
})

const OrchestratorDeliveryFailedEvent = Schema.Struct({
  ...orchestratorEventFields,
  type: Schema.Literal("delivery_failed"),
  detail: OrchestratorEventDetail,
  result: Schema.Null
})

const OrchestratorTaskFailedEvent = Schema.Struct({
  ...orchestratorEventFields,
  type: Schema.Literal("task_failed"),
  detail: OrchestratorEventDetail,
  result: Schema.Null
})

export const OrchestratorEvent = Schema.Union([
  OrchestratorAcceptedEvent,
  OrchestratorQueuedEvent,
  OrchestratorRunningEvent,
  OrchestratorSettledEvent,
  OrchestratorDeliveryFailedEvent,
  OrchestratorTaskFailedEvent
])
export type OrchestratorEvent = typeof OrchestratorEvent.Type

export const OrchestratorPendingDispatchStatus = Schema.Literals(["accepted", "queued"])
export type OrchestratorPendingDispatchStatus = typeof OrchestratorPendingDispatchStatus.Type

const PendingPageLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 256 })
)
export const OrchestratorPendingCursor = Schema.Struct({
  acceptedAt: Timestamp,
  dispatchRequestId: DispatchRequestId
})
export type OrchestratorPendingCursor = typeof OrchestratorPendingCursor.Type

export const OrchestratorPendingQuery = Schema.Struct({
  limit: Schema.optional(PendingPageLimit),
  after: Schema.optional(OrchestratorPendingCursor)
})
export interface OrchestratorPendingQuery extends Schema.Schema.Type<typeof OrchestratorPendingQuery> {}

export const OrchestratorPendingDispatch = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  idempotencyKey: OrchestratorIdempotencyKey,
  activityIdempotencyKey: ActivityIdempotencyKey,
  command: OrchestratorCommand,
  acceptedAt: Timestamp,
  status: OrchestratorPendingDispatchStatus
}).check(
  Schema.makeFilter(
    ({ activityIdempotencyKey, command }) => activityIdempotencyKey === command.activityIdempotencyKey,
    { expected: "pending activity idempotency key equal to its command key" }
  )
)
export type OrchestratorPendingDispatch = typeof OrchestratorPendingDispatch.Type

export const OrchestratorReceipt = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  idempotencyKey: OrchestratorIdempotencyKey,
  acceptedAt: Timestamp,
  status: Schema.Literal("accepted")
})
export interface OrchestratorReceipt extends Schema.Schema.Type<typeof OrchestratorReceipt> {}
