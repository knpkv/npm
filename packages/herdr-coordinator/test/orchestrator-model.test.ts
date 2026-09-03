import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { OrchestratorEvent } from "../src/orchestrator-model.js"

const event = {
  activityIdempotencyKey: "activity:model",
  dispatchRequestId: "dispatch:model",
  occurredAt: 1,
  sequence: 0
}

describe("orchestrator event model", () => {
  it("requires lifecycle-specific detail and result fields", () => {
    const valid = [
      { ...event, detail: null, result: null, type: "accepted" },
      { ...event, detail: null, result: null, type: "queued" },
      { ...event, detail: null, result: null, type: "running" },
      { ...event, detail: null, result: "done", type: "settled" },
      { ...event, detail: "delivery failed", result: null, type: "delivery_failed" },
      { ...event, detail: "task failed", result: null, type: "task_failed" }
    ]
    for (const candidate of valid) {
      expect(Schema.decodeUnknownResult(OrchestratorEvent)(candidate)._tag).toBe("Success")
    }

    const invalid = [
      { ...event, detail: null, result: "unexpected", type: "accepted" },
      { ...event, detail: null, result: null, type: "settled" },
      { ...event, detail: null, result: null, type: "task_failed" }
    ]
    for (const candidate of invalid) {
      expect(Schema.decodeUnknownResult(OrchestratorEvent)(candidate)._tag).toBe("Failure")
    }
  })
})
