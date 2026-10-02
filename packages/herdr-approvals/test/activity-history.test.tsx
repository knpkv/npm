import { describe, expect, it } from "@effect/vitest"
import type { JobRecord } from "@knpkv/herdr-fleet/model"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ActivityHistory,
  activityItemsFor,
  activityNavigationIndex,
  filterActivityItems
} from "../src/activity-history.js"

const sensitivePrompt = "Deploy revision 0123456789abcdef0123456789abcdef01234567 with nonce private-nonce"
const sensitiveMessage = "Run internal command with approval hash private-hash"

const delegated: JobRecord = {
  actor: "local",
  approvalExpiresAt: null,
  approvalNonce: null,
  approvedAt: 3_000,
  approvedBy: "owner@example.com",
  connectTarget: {
    agentId: "agent-worker",
    host: "SER8",
    url: "/connect/?agent=agent-worker&host=SER8"
  },
  createdAt: 1_000,
  error: null,
  expiredAt: null,
  hash: "a".repeat(64),
  id: "job-delegated",
  payload: { kind: "agent.delegate", mode: "work", prompt: sensitivePrompt, repository: "/repo" },
  rejectedAt: null,
  rejectedBy: null,
  result: null,
  status: "running",
  updatedAt: 4_000,
  worker: {
    agentId: "agent-worker",
    host: "SER8",
    name: "package-worker",
    paneId: "w1:p1"
  },
  workerTerminalObservedAt: null
}

const failedMessage: JobRecord = {
  actor: "local",
  approvalExpiresAt: null,
  approvalNonce: null,
  approvedAt: 5_000,
  approvedBy: "owner@example.com",
  createdAt: 2_000,
  error: "raw terminal failure",
  expiredAt: null,
  hash: "b".repeat(64),
  id: "job-message",
  payload: { kind: "agent.message", message: sensitiveMessage, session: "host-coordinator" },
  rejectedAt: null,
  rejectedBy: null,
  result: null,
  status: "failed",
  updatedAt: 6_000
}

describe("activity history", () => {
  it("keeps approved existing-owner reconciliation in Work and approval activity", () => {
    const reconciled: JobRecord = {
      ...delegated,
      connectTarget: undefined,
      id: "job-reconcile",
      payload: {
        kind: "work.reconcile",
        repository: "knpkv/npm",
        pullRequest: 433,
        goalId: "goal-433",
        laneId: "lane-433",
        operationId: "operation-433",
        expectedRevision: 2,
        expectedHead: "0123456789abcdef0123456789abcdef01234567",
        newHead: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        expectedOwner: { id: "owner-1", name: "Owner" },
        expectedGoalEventId: "event-433",
        bindingDispatchRequestId: "dispatch-433",
        sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
        expectedWork: "feat/guided-review-rly",
        worker: { agentId: "agent-433", host: "SER8", name: "Owner", paneId: "w1:p3" },
        worktree: "/worktrees/npm/feat/guided-review-rly",
        branch: "feat/guided-review-rly"
      },
      worker: undefined
    }
    const items = activityItemsFor([reconciled])
    expect(items[0]).toMatchObject({
      title: "Reconcile existing Work owner",
      summary: "Reconciled the existing owner for knpkv/npm#433."
    })
    expect(filterActivityItems(items, "work", "")).toHaveLength(1)
    expect(filterActivityItems(items, "approvals", "")).toHaveLength(1)
  })

  it("keeps approved goal reassignment in Work and approval activity", () => {
    const reassigned: JobRecord = {
      ...delegated,
      connectTarget: undefined,
      id: "job-reassign",
      payload: {
        kind: "work.reassign",
        goalId: "goal-ser8-control-surface",
        from: { id: "owner-host-coordinator", name: "Codex host coordinator" },
        to: { id: "agent-claude-coord", name: "Claude coordinator" },
        toAgent: {
          _tag: "set",
          agent: {
            host: "SER8",
            agentId: "agent-claude-coord",
            name: "coord",
            paneId: "w1J:p9",
            relationship: { parentAgentId: "agent-lead", relation: "delegated" }
          }
        },
        reason: "Codex identities retired",
        expectedGoalEventId: "goal-event-7",
        expectedGoalUpdatedAt: 500
      },
      worker: undefined
    }
    const items = activityItemsFor([reassigned])
    expect(items[0]).toMatchObject({
      title: "Reassign Work goal owner",
      summary: "Reassigned goal-ser8-control-surface from Codex host coordinator to Claude coordinator."
    })
    expect(filterActivityItems(items, "work", "")).toHaveLength(1)
    expect(filterActivityItems(items, "approvals", "")).toHaveLength(1)
  })

  it("projects one sanitized row per job", () => {
    const items = activityItemsFor([delegated, failedMessage])
    const projection = JSON.stringify(items)
    expect(items).toHaveLength(2)
    expect(projection).toContain("package-worker")
    expect(projection).toContain("host-coordinator")
    expect(projection).not.toContain(sensitivePrompt)
    expect(projection).not.toContain(sensitiveMessage)
    expect(projection).not.toContain("private-nonce")
    expect(projection).not.toContain("private-hash")
    expect(projection).not.toContain("raw terminal failure")
  })

  it("projects transition summaries distinctly from consultations and delegated work", () => {
    const items = activityItemsFor([
      {
        ...delegated,
        connectTarget: undefined,
        id: "job-transition-summary",
        payload: {
          kind: "agent.delegate",
          mode: "transition_summary",
          prompt: sensitivePrompt,
          repository: "/repo"
        },
        status: "succeeded",
        worker: undefined
      }
    ])
    expect(items).toMatchObject([
      {
        approvalRequest: null,
        summary: "Requested a bounded transition summary.",
        title: "Summarize a transition"
      }
    ])
  })

  it("filters exceptions, human decisions, work, and search text independently", () => {
    const items = activityItemsFor([delegated, failedMessage])
    expect(filterActivityItems(items, "exceptions", "").map((item) => item.id)).toEqual(["job-message"])
    expect(filterActivityItems(items, "human", "")).toHaveLength(2)
    expect(filterActivityItems(items, "work", "package-worker").map((item) => item.id)).toEqual(["job-delegated"])
    expect(filterActivityItems(items, "deployments", "")).toHaveLength(0)
  })

  it("moves through visible rows with list-navigation keys", () => {
    expect(activityNavigationIndex({ current: -1, key: "j", total: 3 })).toBe(0)
    expect(activityNavigationIndex({ current: 0, key: "ArrowDown", total: 3 })).toBe(1)
    expect(activityNavigationIndex({ current: 1, key: "k", total: 3 })).toBe(0)
    expect(activityNavigationIndex({ current: 0, key: "End", total: 3 })).toBe(2)
    expect(activityNavigationIndex({ current: 2, key: "Home", total: 3 })).toBe(0)
    expect(activityNavigationIndex({ current: 0, key: "x", total: 3 })).toBeNull()
  })

  it("renders filters, search, expandable rows, and bounded loading", () => {
    const records = Array.from({ length: 30 }, (_, index): JobRecord => ({
      ...delegated,
      id: `job-${String(index)}`,
      updatedAt: delegated.updatedAt + index
    }))
    const markup = renderToStaticMarkup(<ActivityHistory records={records} />)
    expect(markup).toContain('aria-label="Search activity"')
    expect(markup).toContain('id="work-activity-search"')
    expect(markup).toContain('name="activity-search"')
    expect(markup).toContain('aria-label="Filter activity"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain("24 visible · 30 matching · 30 jobs")
    expect(markup).toContain("Load earlier · 6 remaining")
    expect([...markup.matchAll(/data-activity-row=""/g)]).toHaveLength(24)
    expect(markup).not.toContain(sensitivePrompt)
  })
})
