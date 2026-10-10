import { describe, expect, it } from "@effect/vitest"
import { JobPayload } from "@knpkv/herdr-fleet/model"
import { WorkGoalLaneActiveError } from "@knpkv/herdr-work"
import type { WorkGoalAbandoned, WorkGoalAbandonment } from "@knpkv/herdr-work/model"
import { Effect, Schema } from "effect"
import { runWorkAbandon } from "../src/work-abandon.js"

const raw = {
  kind: "work.abandon",
  goalId: "fix-iphone-live-ui-polish",
  owner: { id: "agent-codex-owner", name: "Codex owner" },
  reason: "abandoned by Owner 2026-10-06: no PR, no branch, no owner",
  expectedGoalEventId: "goal-event-7",
  expectedGoalUpdatedAt: 500
}
const payload = Schema.decodeUnknownSync(JobPayload)(raw)
const approval = { approvedBy: "owner", approvedAt: 900, hash: "c".repeat(64) }

describe("work.abandon executor", () => {
  it.effect("submits the exact payload with the persisted approval provenance", () =>
    Effect.gen(function*() {
      if (payload.kind !== "work.abandon") return
      const requests: Array<WorkGoalAbandonment> = []
      const output = yield* runWorkAbandon(
        {
          abandon: (request) =>
            Effect.sync(() => {
              requests.push(request)
              const result: WorkGoalAbandoned = {
                abandonment: request,
                checkpoint: {
                  version: "herdr.work.event.v1",
                  eventId: request.approvalJobId,
                  occurredAt: 1_000,
                  goal: {
                    id: request.goalId,
                    title: "Polish live UI",
                    summary: "iPhone live UI polish",
                    detail: "Abandoned",
                    state: "abandoned",
                    owner: request.owner,
                    repository: { repository: "knpkv/npm", branch: "fix/ui" },
                    spend: null,
                    delivery: "local",
                    blocker: null,
                    connectTarget: null,
                    createdAt: 500,
                    updatedAt: 1_000
                  }
                }
              }
              return result
            })
        },
        payload,
        "job-abandon",
        "coord",
        approval
      )
      expect(requests).toEqual([{
        ...raw,
        approvalJobId: "job-abandon",
        approvalActor: "coord",
        approvalApprovedBy: "owner",
        approvalApprovedAt: 900,
        approvalHash: approval.hash
      }])
      expect(JSON.parse(output)).toEqual({ goalId: raw.goalId, eventId: "job-abandon", state: "abandoned" })
    }))

  it.effect("refuses to run without persisted approval and surfaces Work failures", () =>
    Effect.gen(function*() {
      if (payload.kind !== "work.abandon") return
      const unreachable = { abandon: () => Effect.die("abandon must not run without approval") }
      expect(yield* Effect.flip(runWorkAbandon(unreachable, payload, "job-abandon", "coord", null))).toMatchObject({
        _tag: "FleetOperationError",
        operation: "work.abandon"
      })
      const active = new WorkGoalLaneActiveError({ goalId: raw.goalId, laneId: "lane-ui" })
      expect(
        yield* Effect.flip(
          runWorkAbandon({ abandon: () => Effect.fail(active) }, payload, "job-abandon", "coord", approval)
        )
      ).toMatchObject({ _tag: "FleetOperationError", cause: active, detail: "WorkGoalLaneActiveError" })
    }))
})
