import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  approvalTargetMatchesOrigin,
  type WorkApprovalTarget,
  WorkBoard,
  WorkGoal,
  type WorkGoalCheckpoint as WorkGoalCheckpointType,
  type WorkSnapshot,
  type WorkSnapshots
} from "../src/index.js"
import { projectWorkSnapshots } from "../src/projection.js"

const workGoalInput = {
  blocker: null,
  connectTarget: {
    agentId: "agent-work-owner",
    host: "SER8",
    url: "/connect/?agent=agent-work-owner&host=SER8"
  },
  agentHierarchy: {
    agent: {
      agentId: "agent-work-owner",
      host: "SER8",
      name: "Work owner",
      paneId: "w1:p2",
      relationship: {
        parentAgentId: "agent-coordinator",
        relation: "delegated"
      }
    }
  },
  activity: [
    {
      id: "activity-started",
      kind: "status",
      occurredAt: 2_000,
      summary: "Agent started the implementation"
    },
    {
      id: "activity-shipped",
      kind: "shipment",
      occurredAt: 3_000,
      summary: "Pull request opened"
    }
  ],
  blockers: [],
  createdAt: 1_000,
  delivery: "pull_request",
  detail: "Keep the daily fleet handoff visible in one place",
  goalFamily: {
    canonicalGoalId: "goal-work-control-app",
    role: "canonical"
  },
  id: "goal-work-control-app",
  owner: { id: "owner-coordinator", name: "Coordinator" },
  repository: { branch: "feat/herdr-work-control-app", repository: "npm" },
  requests: [
    {
      approvalTarget: {
        host: "SER8",
        jobId: "approval-job-42",
        url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
      },
      id: "request-review",
      requestedAt: 3_000,
      state: "open",
      summary: "Approve the package shipment"
    }
  ],
  review: {
    state: "requested",
    summary: "Waiting for the fresh package review",
    updatedAt: 3_000,
    url: "https://github.com/knpkv/npm/pull/400"
  },
  spend: null,
  state: "working",
  summary: "Track agent work through shipment",
  title: "Daily fleet Work",
  updatedAt: 3_000,
  approvalTarget: {
    host: "SER8",
    jobId: "approval-job-42",
    url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
  }
}

const workGoal = Schema.decodeUnknownSync(WorkGoal)(workGoalInput)

const snapshotFor = (window: WorkSnapshot["window"]): WorkSnapshot => ({
  asOf: 3_000,
  goals: [workGoal],
  observedAt: 3_000,
  window
})

const snapshots: WorkSnapshots = {
  day: snapshotFor("day"),
  month: snapshotFor("month"),
  now: snapshotFor("now"),
  observedAt: 3_000,
  week: snapshotFor("week")
}

describe("Work control app", () => {
  it("decodes the authoritative hierarchy and exact handoff links", () => {
    expect(workGoal.agentHierarchy?.agent.host).toBe("SER8")
    expect(workGoal.agentHierarchy?.agent.relationship?.parentAgentId).toBe("agent-coordinator")
    expect(workGoal.connectTarget?.url).toBe("/connect/?agent=agent-work-owner&host=SER8")
    expect(workGoal.approvalTarget?.jobId).toBe("approval-job-42")
    expect(workGoal.approvalTarget?.url).toBe(
      "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
    )
  })

  it("binds approval targets to the origin resolved by the approvals boundary", () => {
    const target: WorkApprovalTarget = {
      host: "SER8",
      jobId: "approval-job-42",
      url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
    }

    expect(approvalTargetMatchesOrigin(target, "https://ser8.example.test")).toBe(true)
    expect(approvalTargetMatchesOrigin(target, "https://evil.example.test")).toBe(false)
  })

  it("rejects a Connect target that diverges from the authoritative agent", () => {
    const malformed = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      connectTarget: {
        agentId: "agent-other",
        host: "SER8",
        url: "/connect/?agent=agent-other&host=SER8"
      }
    })
    expect(malformed._tag).toBe("Failure")
  })

  it("requires every approval target to identify its approval", () => {
    const generic = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      approvalTarget: { host: "SER8", jobId: "approval-job-42", url: "https://ser8.example.test/?tab=approvals" }
    })
    const mismatched = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      requests: [{
        ...workGoalInput.requests[0],
        approvalTarget: {
          host: "SER8",
          jobId: "approval-job-42",
          url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-other"
        }
      }]
    })
    const wrongPath = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      approvalTarget: {
        host: "SER8",
        jobId: "approval-job-42",
        url: "https://ser8.example.test/not-found?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42"
      }
    })

    expect(generic._tag).toBe("Failure")
    expect(mismatched._tag).toBe("Failure")
    expect(wrongPath._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(WorkGoal)(workGoalInput)._tag).toBe("Success")
  })

  it("rejects approval targets with extra query data or fragments", () => {
    const secretQuery = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      approvalTarget: {
        host: "SER8",
        jobId: "approval-job-42",
        url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42&secret=leak"
      }
    })
    const fragment = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      approvalTarget: {
        host: "SER8",
        jobId: "approval-job-42",
        url: "https://ser8.example.test/?tab=approvals&approvalHost=SER8&approvalJob=approval-job-42#secret"
      }
    })

    expect(secretQuery._tag).toBe("Failure")
    expect(fragment._tag).toBe("Failure")
  })

  it("accepts approval host identifiers supported by the approvals app", () => {
    const supported = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      approvalTarget: {
        host: "PI 5",
        jobId: "job/7",
        url: "https://ser8.example.test/?tab=approvals&approvalHost=PI+5&approvalJob=job%2F7"
      }
    })

    expect(supported._tag).toBe("Success")
  })

  it("rejects a self-parenting agent hierarchy", () => {
    const selfParent = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      agentHierarchy: {
        agent: {
          ...workGoalInput.agentHierarchy.agent,
          relationship: {
            ...workGoalInput.agentHierarchy.agent.relationship,
            parentAgentId: "agent-work-owner"
          }
        }
      }
    })

    expect(selfParent._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(WorkGoal)(workGoalInput)._tag).toBe("Success")
  })

  it("binds a goal-family role to the canonical goal identity", () => {
    const canonicalOther = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      goalFamily: {
        canonicalGoalId: "goal-other",
        role: "canonical"
      }
    })
    const supersededSelf = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      goalFamily: {
        canonicalGoalId: workGoalInput.id,
        role: "superseded"
      }
    })

    expect(canonicalOther._tag).toBe("Failure")
    expect(supersededSelf._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(WorkGoal)(workGoalInput)._tag).toBe("Success")
  })

  it("rejects future detail timestamps and accepts a detail at the goal update", () => {
    const futureActivity = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      activity: [{ ...workGoalInput.activity[0], occurredAt: 3_001 }]
    })
    const futureRequest = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      requests: [{ ...workGoalInput.requests[0], requestedAt: 3_001 }]
    })
    const futureReview = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      review: { ...workGoalInput.review, updatedAt: 3_001 }
    })
    const detailAtUpdate = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      activity: [{ ...workGoalInput.activity[0], occurredAt: workGoalInput.updatedAt }]
    })

    expect(futureActivity._tag).toBe("Failure")
    expect(futureRequest._tag).toBe("Failure")
    expect(futureReview._tag).toBe("Failure")
    expect(detailAtUpdate._tag).toBe("Success")
  })

  it("rejects future blockers and accepts a blocker at the goal update", () => {
    const futureBlocker = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      blocker: null,
      blockers: [{ since: 3_001, summary: "Future blocker" }],
      state: "blocked"
    })
    const blockerAtUpdate = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      blocker: null,
      blockers: [{ since: workGoalInput.updatedAt, summary: "Current blocker" }],
      state: "blocked"
    })

    expect(futureBlocker._tag).toBe("Failure")
    expect(blockerAtUpdate._tag).toBe("Success")
  })

  it("rejects detail timestamps before goal creation and accepts creation-time details", () => {
    const preGoalActivity = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      activity: [{ ...workGoalInput.activity[0], occurredAt: workGoalInput.createdAt - 1 }]
    })
    const preGoalRequest = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      requests: [{ ...workGoalInput.requests[0], requestedAt: workGoalInput.createdAt - 1 }]
    })
    const preGoalReview = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      review: { ...workGoalInput.review, updatedAt: workGoalInput.createdAt - 1 }
    })
    const preGoalBlockers = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      blocker: null,
      blockers: [{ since: workGoalInput.createdAt - 1, summary: "Pre-goal blocker" }],
      state: "blocked"
    })
    const { blockers: _blockers, ...workGoalWithoutBlockers } = workGoalInput
    const preGoalLegacyBlocker = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalWithoutBlockers,
      blocker: { since: workGoalInput.createdAt - 1, summary: "Pre-goal blocker" },
      state: "blocked"
    })
    const atCreationLegacyBlocker = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalWithoutBlockers,
      blocker: { since: workGoalInput.createdAt, summary: "Creation-time blocker" },
      state: "blocked"
    })
    const atCreation = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      activity: [{ ...workGoalInput.activity[0], occurredAt: workGoalInput.createdAt }],
      blocker: null,
      blockers: [{ since: workGoalInput.createdAt, summary: "Creation-time blocker" }],
      requests: [{ ...workGoalInput.requests[0], requestedAt: workGoalInput.createdAt }],
      review: { ...workGoalInput.review, updatedAt: workGoalInput.createdAt },
      state: "blocked"
    })

    expect(preGoalActivity._tag).toBe("Failure")
    expect(preGoalRequest._tag).toBe("Failure")
    expect(preGoalReview._tag).toBe("Failure")
    expect(preGoalBlockers._tag).toBe("Failure")
    expect(preGoalLegacyBlocker._tag).toBe("Failure")
    expect(atCreation._tag).toBe("Success")
    expect(atCreationLegacyBlocker._tag).toBe("Success")
  })

  it("rejects duplicate activity and request identities", () => {
    const duplicateActivity = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      activity: [workGoalInput.activity[0], { ...workGoalInput.activity[0], summary: "same identity, changed summary" }]
    })
    const duplicateRequest = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      requests: [workGoalInput.requests[0], { ...workGoalInput.requests[0], summary: "same identity, changed summary" }]
    })
    const duplicateBlocker = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      blockers: [
        { since: 2_000, summary: "same blocker" },
        { since: 2_000, summary: "same blocker" }
      ],
      state: "blocked"
    })
    const distinctBlockers = Schema.decodeUnknownResult(WorkGoal)({
      ...workGoalInput,
      blockers: [
        { since: 2_000, summary: "first blocker" },
        { since: 2_500, summary: "second blocker" }
      ],
      state: "blocked"
    })

    expect(duplicateActivity._tag).toBe("Failure")
    expect(duplicateRequest._tag).toBe("Failure")
    expect(duplicateBlocker._tag).toBe("Failure")
    expect(distinctBlockers._tag).toBe("Success")
  })

  it("renders activity, requests, review, shipment, and exact links beside the hierarchy", () => {
    const markup = renderToStaticMarkup(createElement(WorkBoard, { snapshots }))
    expect(markup).toContain("Daily fleet Work")
    expect(markup).toContain("SER8 / Work owner")
    expect(markup).toContain("agent-coordinator")
    expect(markup).toContain("Activity")
    expect(markup).toContain("Approve the package shipment")
    expect(markup).toContain("Waiting for the fresh package review")
    expect(markup).toContain("Shipment path")
    expect(markup).toContain("href=\"/connect/?agent=agent-work-owner&amp;host=SER8\"")
    expect(markup).toContain(
      "href=\"https://ser8.example.test/?tab=approvals&amp;approvalHost=SER8&amp;approvalJob=approval-job-42\""
    )
  })

  it("renders a compact superseded history affordance for the canonical Work goal", async () => {
    const makeGoal = (
      id: string,
      title: string,
      state: "blocked" | "working",
      blockerSummary: string | null
    ): WorkGoalCheckpointType => ({
      eventId: `event-${id}`,
      occurredAt: 0,
      version: "herdr.work.event.v1",
      goal: {
        blocker: blockerSummary === null ? null : { since: 0, summary: blockerSummary },
        connectTarget: null,
        createdAt: 0,
        delivery: "local",
        detail: `Durable ${title}`,
        id,
        owner: { id: "owner-connect", name: "Coordinator" },
        repository: { branch: "feat/connect-terminal-special-keys", repository: "npm" },
        spend: null,
        state,
        summary: title,
        title,
        updatedAt: 0
      }
    })
    const v1 = makeGoal("goal-connect-v1", "Connect terminal special keys v1", "blocked", "V1 blocker")
    const v2 = makeGoal("goal-connect-v2", "Connect terminal special keys v2", "blocked", "V2 blocker")
    const v3 = makeGoal("goal-connect-v3", "Connect terminal special keys v3", "working", null)
    const relationAt = 1_000
    const events = [
      v1,
      v2,
      v3,
      {
        ...v3,
        eventId: "event-v3-canonical",
        occurredAt: relationAt,
        goal: {
          ...v3.goal,
          goalFamily: { canonicalGoalId: "goal-connect-v3", role: "canonical" },
          updatedAt: relationAt
        }
      },
      {
        ...v1,
        eventId: "event-v1-superseded",
        occurredAt: relationAt,
        goal: {
          ...v1.goal,
          goalFamily: { canonicalGoalId: "goal-connect-v3", role: "superseded" },
          updatedAt: relationAt
        }
      },
      {
        ...v2,
        eventId: "event-v2-superseded",
        occurredAt: relationAt,
        goal: {
          ...v2.goal,
          goalFamily: { canonicalGoalId: "goal-connect-v3", role: "superseded" },
          updatedAt: relationAt
        }
      }
    ]
    const snapshotsValue = await Effect.runPromise(
      projectWorkSnapshots(events, relationAt + 1)
    )
    const markup = renderToStaticMarkup(createElement(WorkBoard, { snapshots: snapshotsValue }))
    expect(snapshotsValue.now.goals.map(({ id }) => id)).toEqual(["goal-connect-v3"])
    expect(snapshotsValue.now.families?.[0]?.superseded).toHaveLength(2)
    expect(markup).toContain("goal-connect-v3")
    expect(markup).not.toContain("goal-connect-v1\"")
    expect(markup).toContain("2 superseded")
    expect(markup).toContain("Superseded history")
    expect(markup).toContain("Show 2 superseded")
    expect(markup).toContain("V1 blocker")
    expect(markup).toContain("V2 blocker")
    expect(markup).toContain("Connect terminal special keys v1")
    expect(markup).toContain("Connect terminal special keys v2")
  })
})
