import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  ActivityIdempotencyKey,
  OrchestratorEvent,
  OrchestratorIdempotencyKey,
  OrchestratorLinkedSolDispatchReference,
  OrchestratorPendingDispatch,
  OrchestratorPendingQuery,
  OrchestratorRequest,
  OrchestratorSolEscalationSubmission,
  OrchestratorWorkLink
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

  it("binds a request activity key to its decoded command", () => {
    const request = {
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
      route: null,
      status: "accepted",
      workLink: null
    }
    expect(Schema.decodeUnknownResult(OrchestratorRequest)(request)._tag).toBe("Success")
    expect(
      Schema.decodeUnknownResult(OrchestratorRequest)({ ...request, activityIdempotencyKey: "activity:other" })._tag
    ).toBe("Failure")
  })

  it("bounds pending recovery queries", () => {
    expect(Schema.decodeUnknownResult(OrchestratorPendingQuery)({})._tag).toBe("Success")
    expect(Schema.decodeUnknownResult(OrchestratorPendingQuery)({ limit: 256 })._tag).toBe("Success")
    expect(Schema.decodeUnknownResult(OrchestratorPendingQuery)({ limit: 257 })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(OrchestratorPendingQuery)({ limit: undefined })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(OrchestratorPendingQuery)({ after: undefined })._tag).toBe("Failure")
  })

  it("binds Work lineage to the handoff dispatch IDs", () => {
    const link = {
      handoff: {
        blockers: [],
        contextDelta: "Escalate failed work",
        decision: "handoff",
        dispatchIds: ["dispatch:parent", "dispatch:earlier"],
        evidenceRefs: [],
        expectedRevision: 1,
        goalId: "goal:model",
        id: "handoff:model",
        laneId: "lane:model",
        occurredAt: 1,
        owner: { id: "owner:model", name: "Coordinator" },
        sessionId: "session:model",
        summary: "Escalate failed work",
        version: "herdr.work.decision.v2"
      },
      lineage: ["dispatch:parent"]
    }
    expect(Schema.decodeUnknownResult(OrchestratorWorkLink)(link)._tag).toBe("Success")
    expect(
      Schema.decodeUnknownResult(OrchestratorLinkedSolDispatchReference)({
        failedLunaRequestId: "dispatch:parent",
        workLink: link
      })._tag
    ).toBe("Success")
    expect(
      Schema.decodeUnknownResult(OrchestratorLinkedSolDispatchReference)({
        failedLunaRequestId: "dispatch:unrelated",
        workLink: link
      })._tag
    ).toBe("Failure")
    expect(
      Schema.decodeUnknownResult(OrchestratorWorkLink)({ ...link, lineage: ["dispatch:unrelated"] })._tag
    ).toBe("Failure")
  })

  it("accepts only review and work commands for linked Sol escalation", () => {
    const reference = {
      failedLunaRequestId: "dispatch:parent",
      workLink: {
        handoff: {
          blockers: [],
          contextDelta: "Escalate failed work",
          decision: "handoff",
          dispatchIds: ["dispatch:parent"],
          evidenceRefs: [],
          expectedRevision: 1,
          goalId: "goal:model",
          id: "handoff:model",
          laneId: "lane:model",
          occurredAt: 1,
          owner: { id: "owner:model", name: "Coordinator" },
          sessionId: "session:model",
          summary: "Escalate failed work",
          version: "herdr.work.decision.v2"
        },
        lineage: ["dispatch:parent"]
      }
    }
    const submission = {
      command: {
        activityIdempotencyKey: "activity:sol",
        actor: "coordinator",
        kind: "fleet.job",
        payload: {
          kind: "agent.delegate",
          mode: "work",
          prompt: "Continue with Sol",
          repository: "/repo"
        }
      },
      idempotencyKey: "dispatch:sol",
      reason: "Escalate failed Luna work",
      reference
    }

    for (const mode of ["review", "work"]) {
      expect(
        Schema.decodeUnknownResult(OrchestratorSolEscalationSubmission)({
          ...submission,
          command: { ...submission.command, payload: { ...submission.command.payload, mode } }
        })._tag
      ).toBe("Success")
    }
    for (
      const payload of [
        { kind: "nix.check" },
        { kind: "agent.delegate", mode: "consult", prompt: "consult", repository: "/repo" },
        { kind: "agent.delegate", mode: "transition_summary", prompt: "summarize", repository: "/repo" }
      ]
    ) {
      expect(
        Schema.decodeUnknownResult(OrchestratorSolEscalationSubmission)({
          ...submission,
          command: { ...submission.command, payload }
        })._tag
      )
        .toBe("Failure")
    }
  })
})
