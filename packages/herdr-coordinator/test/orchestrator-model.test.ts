import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  ActivityIdempotencyKey,
  OrchestratorEvent,
  OrchestratorIdempotencyKey,
  OrchestratorPendingDispatch,
  OrchestratorPendingQuery
} from "../src/orchestrator-model.js"

const event = {
  activityIdempotencyKey: "activity:model",
  dispatchRequestId: "dispatch:model",
  occurredAt: 1,
  sequence: 0
}

describe("orchestrator event model", () => {
  it("accepts only Unicode scalar activity idempotency keys", () => {
    expect(Schema.decodeUnknownResult(ActivityIdempotencyKey)("\uD800")._tag).toBe("Failure")
    expect(Schema.decodeUnknownSync(ActivityIdempotencyKey)("activity-🦊")).toBe("activity-🦊")
    expect(Schema.decodeUnknownResult(OrchestratorIdempotencyKey)("\uDC00")._tag).toBe("Failure")
    expect(Schema.decodeUnknownSync(OrchestratorIdempotencyKey)("dispatch-🦊")).toBe("dispatch-🦊")
  })

  it("requires lifecycle-specific detail and result fields", () => {
    const valid = [
      { ...event, detail: null, result: null, type: "accepted" },
      { ...event, detail: null, result: null, type: "queued" },
      { ...event, detail: null, result: null, type: "running" },
      { ...event, detail: null, result: "done", type: "settled" },
      { ...event, detail: "delivery failed", result: null, type: "delivery_failed" },
      { ...event, detail: "", result: null, type: "delivery_failed" },
      { ...event, detail: "d".repeat(4_097), result: null, type: "delivery_failed" },
      { ...event, detail: "task failed", result: null, type: "task_failed" }
    ]
    for (const candidate of valid) {
      expect(Schema.decodeUnknownResult(OrchestratorEvent)(candidate)._tag).toBe("Success")
    }

    const invalid = [
      { ...event, detail: null, result: "unexpected", type: "accepted" },
      { ...event, detail: null, result: null, type: "settled" },
      { ...event, detail: null, result: null, type: "task_failed" },
      { ...event, detail: "\uD800", result: null, type: "task_failed" },
      { ...event, detail: null, result: "\uD800", type: "settled" }
    ]
    for (const candidate of invalid) {
      expect(Schema.decodeUnknownResult(OrchestratorEvent)(candidate)._tag).toBe("Failure")
    }
  })

  it("binds a pending activity key to its decoded command", () => {
    const pending = {
      acceptedAt: 1,
      activityIdempotencyKey: "activity:model",
      command: {
        activityIdempotencyKey: "activity:model",
        actor: "coordinator",
        kind: "fleet.job",
        payload: { kind: "nix.check" }
      },
      dispatchRequestId: "dispatch:model",
      idempotencyKey: "dispatch:model-key",
      status: "accepted"
    }
    expect(Schema.decodeUnknownResult(OrchestratorPendingDispatch)(pending)._tag).toBe("Success")
    expect(
      Schema.decodeUnknownResult(OrchestratorPendingDispatch)({
        ...pending,
        activityIdempotencyKey: "activity:other"
      })._tag
    ).toBe("Failure")
  })

  it("bounds pending recovery queries", () => {
    expect(Schema.decodeUnknownResult(OrchestratorPendingQuery)({ limit: 256 })._tag).toBe("Success")
    expect(Schema.decodeUnknownResult(OrchestratorPendingQuery)({ limit: 257 })._tag).toBe("Failure")
  })
})
