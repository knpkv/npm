import { JobActor, JobIdentifier, JobPayload } from "@knpkv/herdr-fleet/model"
import { fleetResponseBodyMaxBytes } from "@knpkv/herdr-fleet/response"
import { Schema } from "effect"
import { WorkStoreError } from "../errors.js"

const Identifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
const UnicodeScalarText = Schema.String.check(
  Schema.isPattern(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/)
)
const utf8 = new TextEncoder()
const EventText = UnicodeScalarText.check(
  Schema.isMaxLength(fleetResponseBodyMaxBytes),
  Schema.makeFilter(
    (value: string) => utf8.encode(value).byteLength <= fleetResponseBodyMaxBytes,
    { expected: `UTF-8 text no larger than ${fleetResponseBodyMaxBytes} bytes` }
  )
)
const Timestamp = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })
)
const Sequence = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const Status = Schema.Literals([
  "accepted",
  "queued",
  "running",
  "settled",
  "delivery_failed",
  "task_failed"
])
type Status = typeof Status.Type

const CoordinatorCommand = Schema.Struct({
  kind: Schema.Literal("fleet.job"),
  actor: JobActor,
  activityIdempotencyKey: Identifier,
  payload: JobPayload
})

export const CoordinatorLifecycleDispatchRow = Schema.Struct({
  activityIdempotencyKey: Identifier,
  acceptedAt: Timestamp,
  command: Schema.String,
  dispatchRequestId: JobIdentifier,
  status: Status
})
export type CoordinatorLifecycleDispatchRow = typeof CoordinatorLifecycleDispatchRow.Type

export const CoordinatorLifecycleEventRow = Schema.Struct({
  activityIdempotencyKey: Identifier,
  detail: Schema.NullOr(Schema.String),
  dispatchRequestId: JobIdentifier,
  occurredAt: Timestamp,
  result: Schema.NullOr(Schema.String),
  sequence: Sequence,
  type: Status
})
export type CoordinatorLifecycleEventRow = typeof CoordinatorLifecycleEventRow.Type

const eventFields = {
  activityIdempotencyKey: Identifier,
  dispatchRequestId: JobIdentifier,
  occurredAt: Timestamp,
  sequence: Sequence
}
const CoordinatorEvent = Schema.Union([
  Schema.Struct({
    ...eventFields,
    type: Schema.Literals(["accepted", "queued", "running"]),
    detail: Schema.Null,
    result: Schema.Null
  }),
  Schema.Struct({
    ...eventFields,
    type: Schema.Literals(["delivery_failed", "task_failed"]),
    detail: EventText,
    result: Schema.Null
  }),
  Schema.Struct({ ...eventFields, type: Schema.Literal("settled"), detail: Schema.Null, result: EventText })
])

const RouteReason = EventText.check(Schema.isNonEmpty())
const CoordinatorRoute = Schema.Union([
  Schema.Struct({
    protocol: Schema.Literal("hostd.coordinator.route.v1"),
    action: Schema.Literal("dispatch"),
    model: Schema.Literal("gpt-5.6-luna"),
    reasoningEffort: Schema.Literals(["low", "medium"]),
    reason: RouteReason,
    linkedRequestId: Schema.Null
  }),
  Schema.Struct({
    protocol: Schema.Literal("hostd.coordinator.route.v1"),
    action: Schema.Literal("dispatch"),
    model: Schema.Literal("gpt-5.6-sol"),
    reasoningEffort: Schema.Literal("high"),
    reason: RouteReason,
    linkedRequestId: Schema.NullOr(JobIdentifier)
  })
])

const validTransition = (from: Status, to: Status): boolean =>
  (from === "accepted" && to === "queued") ||
  (from === "queued" && (to === "running" || to === "delivery_failed")) ||
  (from === "running" && (to === "settled" || to === "delivery_failed" || to === "task_failed"))

/** Validates the bounded coordinator history that authorizes restoring a persisted Work revision. */
export const requireCoordinatorLifecycleAuthority = (
  dispatchRows: ReadonlyArray<CoordinatorLifecycleDispatchRow>,
  eventRows: ReadonlyArray<CoordinatorLifecycleEventRow>,
  expectedRunningAt: number,
  operation: string
): void => {
  try {
    const dispatch = dispatchRows[0]
    if (dispatchRows.length !== 1 || dispatch === undefined) {
      throw new WorkStoreError({ cause: { dispatchRows }, operation })
    }
    const command = Schema.decodeUnknownSync(CoordinatorCommand)(JSON.parse(dispatch.command))
    const events = eventRows.map((row) => Schema.decodeUnknownSync(CoordinatorEvent)(row))
    const first = events[0]
    if (
      first === undefined || first.sequence !== 0 || first.type !== "accepted" ||
      first.occurredAt !== dispatch.acceptedAt
    ) {
      throw new WorkStoreError({ cause: { dispatch, first }, operation })
    }
    let previousType: Status = first.type
    let previousOccurredAt = first.occurredAt
    let runningAtMatches = 0
    for (const [index, event] of events.entries()) {
      if (
        event.dispatchRequestId !== dispatch.dispatchRequestId ||
        event.activityIdempotencyKey !== dispatch.activityIdempotencyKey ||
        event.activityIdempotencyKey !== command.activityIdempotencyKey ||
        event.sequence !== index || event.occurredAt < previousOccurredAt ||
        (index > 0 && !validTransition(previousType, event.type))
      ) {
        throw new WorkStoreError({ cause: { dispatch, event, index, previousType }, operation })
      }
      if (event.type === "running" && event.occurredAt === expectedRunningAt) runningAtMatches += 1
      previousType = event.type
      previousOccurredAt = event.occurredAt
    }
    const last = events.at(-1)
    if (last === undefined || last.type !== dispatch.status || runningAtMatches !== 1) {
      throw new WorkStoreError({ cause: { dispatch, events, expectedRunningAt }, operation })
    }
  } catch (cause) {
    if (Schema.is(WorkStoreError)(cause)) throw cause
    throw new WorkStoreError({ cause, operation })
  }
}

/** Validates persisted route authority before a Work-link replica is upgraded. */
export const requireCoordinatorRouteAuthority = (
  routeText: string,
  lineage: ReadonlyArray<string>,
  operation: string
): void => {
  try {
    const route = Schema.decodeUnknownSync(CoordinatorRoute)(JSON.parse(routeText))
    if (
      route.model !== "gpt-5.6-sol" ||
      (route.linkedRequestId !== null && !lineage.includes(route.linkedRequestId))
    ) {
      throw new WorkStoreError({ cause: { lineage, route }, operation })
    }
  } catch (cause) {
    if (Schema.is(WorkStoreError)(cause)) throw cause
    throw new WorkStoreError({ cause, operation })
  }
}
