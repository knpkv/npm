import { describe, expect, it } from "@effect/vitest"
import { JobPayload } from "@knpkv/herdr-fleet/model"
import { WorkGoalOwnerMismatchError } from "@knpkv/herdr-work"
import type { WorkGoalReassigned, WorkGoalReassignment } from "@knpkv/herdr-work/model"
import { Effect, Schema } from "effect"
import { runWorkReassign } from "../src/work-reassign.js"

const raw = {
  kind: "work.reassign",
  goalId: "goal-ser8-control-surface",
  from: { id: "owner-host-coordinator", name: "Codex host coordinator" },
  to: { id: "agent-claude-coord", name: "Claude coordinator" },
  toAgent: { _tag: "keep" },
  reason: "Codex identities retired",
  expectedGoalEventId: "goal-event-7",
  expectedGoalUpdatedAt: 500
}
const payload = Schema.decodeUnknownSync(JobPayload)(raw)
const approval = { approvedBy: "andrey", approvedAt: 900, hash: "c".repeat(64) }

describe("work.reassign executor", () => {
  it.effect("submits the exact payload with the persisted approval provenance", () =>
    Effect.gen(function*() {
      if (payload.kind !== "work.reassign") return
      const requests: Array<WorkGoalReassignment> = []
      const output = yield* runWorkReassign(
        {
          reassign: (request) =>
            Effect.sync(() => {
              requests.push(request)
              const result: WorkGoalReassigned = {
                reassignment: request,
                checkpoint: {
                  version: "herdr.work.event.v1",
                  eventId: request.approvalJobId,
                  occurredAt: 1_000,
                  goal: {
                    id: request.goalId,
                    title: "Control surface",
                    summary: "SER8 control surface",
                    detail: "Deployed",
                    state: "deployed",
                    owner: request.to,
                    repository: { repository: "knpkv/npm", branch: "main" },
                    spend: null,
                    delivery: "deployed",
                    blocker: null,
                    connectTarget: null,
                    createdAt: 500,
                    updatedAt: 1_000
                  }
                },
                lane: null,
                binding: null
              }
              return result
            })
        },
        payload,
        "job-reassign",
        "coord",
        approval
      )
      expect(requests).toEqual([{
        ...raw,
        approvalJobId: "job-reassign",
        approvalActor: "coord",
        approvalApprovedBy: "andrey",
        approvalApprovedAt: 900,
        approvalHash: approval.hash
      }])
      expect(JSON.parse(output)).toEqual({
        goalId: raw.goalId,
        eventId: "job-reassign",
        owner: raw.to,
        laneId: null,
        laneRevision: null,
        bindingDispatchRequestId: null
      })
    }))

  it.effect("refuses to run without persisted approval and surfaces Work failures", () =>
    Effect.gen(function*() {
      if (payload.kind !== "work.reassign") return
      const unreachable = {
        reassign: () => Effect.die("reassign must not run without approval")
      }
      expect(yield* Effect.flip(runWorkReassign(unreachable, payload, "job-reassign", "coord", null))).toMatchObject({
        _tag: "FleetOperationError",
        operation: "work.reassign"
      })
      const mismatch = new WorkGoalOwnerMismatchError({
        goalId: raw.goalId,
        laneId: null,
        expectedOwner: raw.from,
        actualOwner: { id: "someone-else", name: "Someone else" }
      })
      expect(
        yield* Effect.flip(
          runWorkReassign({ reassign: () => Effect.fail(mismatch) }, payload, "job-reassign", "coord", approval)
        )
      ).toMatchObject({ _tag: "FleetOperationError", cause: mismatch, detail: "WorkGoalOwnerMismatchError" })
    }))
})
