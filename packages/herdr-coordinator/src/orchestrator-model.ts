import { JobActor, JobIdentifier, JobPayload } from "@knpkv/herdr-fleet/model"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet/response"
import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256))
const Detail = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096))
const utf8 = new TextEncoder()
const utf8MaxBytes = (maximumBytes: number) =>
  Schema.makeFilter(
    (value: string) => utf8.encode(value).byteLength <= maximumBytes,
    { expected: `UTF-8 text no larger than ${maximumBytes} bytes` }
  )
export const OrchestratorResult = Schema.String.check(
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

const OrchestratorFailureEvent = Schema.Struct({
  ...orchestratorEventFields,
  type: Schema.Literals(["delivery_failed", "task_failed"]),
  detail: Detail,
  result: Schema.Null
})

export const OrchestratorEvent = Schema.Union([
  OrchestratorAcceptedEvent,
  OrchestratorQueuedEvent,
  OrchestratorRunningEvent,
  OrchestratorSettledEvent,
  OrchestratorFailureEvent
])
export type OrchestratorEvent = typeof OrchestratorEvent.Type

export const OrchestratorPendingDispatchStatus = Schema.Literals(["accepted", "queued"])
export type OrchestratorPendingDispatchStatus = typeof OrchestratorPendingDispatchStatus.Type

export const OrchestratorPendingDispatch = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  idempotencyKey: Identifier,
  activityIdempotencyKey: ActivityIdempotencyKey,
  command: OrchestratorCommand,
  acceptedAt: Timestamp,
  status: OrchestratorPendingDispatchStatus
})
export type OrchestratorPendingDispatch = typeof OrchestratorPendingDispatch.Type

export const OrchestratorReceipt = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  idempotencyKey: Identifier,
  acceptedAt: Timestamp,
  status: Schema.Literal("accepted")
})
export interface OrchestratorReceipt extends Schema.Schema.Type<typeof OrchestratorReceipt> {}
