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

export const OrchestratorEvent = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  type: OrchestratorEventType,
  activityIdempotencyKey: ActivityIdempotencyKey,
  occurredAt: Timestamp,
  detail: Schema.NullOr(Detail),
  result: Schema.NullOr(OrchestratorResult)
})
export interface OrchestratorEvent extends Schema.Schema.Type<typeof OrchestratorEvent> {}

export const OrchestratorReceipt = Schema.Struct({
  dispatchRequestId: DispatchRequestId,
  idempotencyKey: Identifier,
  acceptedAt: Timestamp,
  status: Schema.Literal("accepted")
})
export interface OrchestratorReceipt extends Schema.Schema.Type<typeof OrchestratorReceipt> {}
