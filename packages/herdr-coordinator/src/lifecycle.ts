import type { AgentWorkerIdentity } from "@knpkv/herdr-fleet"
import { Effect, Schema } from "effect"
import {
  CoordinatorLifecycleConflictError,
  CoordinatorLifecycleMalformedError,
  CoordinatorLifecycleMissingEventError
} from "./errors.js"
import { CoordinatorLifecycleEvent } from "./model.js"

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const EventTag = Schema.Struct({ type: Schema.Literals(["started", "completed"]) })

const exactKeys = (
  value: typeof JsonObject.Type,
  expected: ReadonlyArray<string>
): boolean => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
}

const malformed = (detail: string) => new CoordinatorLifecycleMalformedError({ detail })

const decodeLine = Effect.fn("CoordinatorLifecycle.decodeLine")(function*(
  line: string
) {
  const json = yield* Effect.try({
    try: () => JSON.parse(line),
    catch: () => malformed("lifecycle event is not JSON")
  })
  const object = yield* Schema.decodeUnknownEffect(JsonObject)(json).pipe(
    Effect.mapError(() => malformed("lifecycle event is not an object"))
  )
  const tag = yield* Schema.decodeUnknownEffect(EventTag)(object).pipe(
    Effect.mapError(() => malformed("lifecycle event type is invalid"))
  )
  const expected = tag.type === "started"
    ? ["jobId", "protocol", "requestId", "type", "worker"]
    : ["jobId", "protocol", "reply", "requestId", "type"]
  if (!exactKeys(object, expected)) {
    return yield* malformed("lifecycle event contains unexpected fields")
  }
  if (tag.type === "started") {
    const worker = yield* Schema.decodeUnknownEffect(JsonObject)(object.worker).pipe(
      Effect.mapError(() => malformed("started worker payload is not an object"))
    )
    const workerKeys = Object.keys(worker)
    if (
      !exactKeys(worker, ["agentId", "host", "name", "paneId"]) &&
      !exactKeys(worker, ["agentId", "host", "name", "paneId", "relationship"])
    ) {
      return yield* malformed("started worker payload contains unexpected fields")
    }
    if (!workerKeys.includes("relationship")) {
      return yield* Schema.decodeUnknownEffect(CoordinatorLifecycleEvent)(object).pipe(
        Effect.mapError(() => malformed("lifecycle event fields are invalid"))
      )
    }
    const relationship = yield* Schema.decodeUnknownEffect(JsonObject)(
      worker.relationship
    ).pipe(
      Effect.mapError(() => malformed("started relationship payload is not an object"))
    )
    if (!exactKeys(relationship, ["parentAgentId", "relation"])) {
      return yield* malformed("started relationship payload contains unexpected fields")
    }
  }
  return yield* Schema.decodeUnknownEffect(CoordinatorLifecycleEvent)(object).pipe(
    Effect.mapError(() => malformed("lifecycle event fields are invalid"))
  )
})

export const makeCoordinatorLifecycle = <E, R>(
  expectedJobId: string,
  workerStarted: (
    identity: AgentWorkerIdentity
  ) => Effect.Effect<void, E, R>
) => {
  let identity: AgentWorkerIdentity | undefined
  let reply: string | undefined
  let requestId: string | undefined

  const accept = Effect.fn("CoordinatorLifecycle.accept")(function*(line: string) {
    const event = yield* decodeLine(line)
    if (event.jobId !== expectedJobId) {
      return yield* new CoordinatorLifecycleConflictError({
        reason: "job_mismatch"
      })
    }
    if (event.type === "started") {
      if (identity !== undefined) {
        return yield* new CoordinatorLifecycleConflictError({
          reason: "duplicate_started"
        })
      }
      if (reply !== undefined) {
        return yield* new CoordinatorLifecycleConflictError({
          reason: "completed_before_started"
        })
      }
      identity = event.worker
      requestId = event.requestId
      yield* workerStarted(event.worker)
      return
    }
    if (identity === undefined) {
      return yield* new CoordinatorLifecycleConflictError({
        reason: "completed_before_started"
      })
    }
    if (reply !== undefined) {
      return yield* new CoordinatorLifecycleConflictError({
        reason: "duplicate_completed"
      })
    }
    if (requestId !== event.requestId) {
      return yield* new CoordinatorLifecycleConflictError({
        reason: "request_mismatch"
      })
    }
    reply = event.reply
  })

  const finish = Effect.fn("CoordinatorLifecycle.finish")(function*() {
    if (identity === undefined) {
      return yield* new CoordinatorLifecycleMissingEventError({
        event: "started"
      })
    }
    if (reply === undefined) {
      return yield* new CoordinatorLifecycleMissingEventError({
        event: "completed"
      })
    }
    return { reply, worker: identity }
  })

  return { accept, finish }
}
