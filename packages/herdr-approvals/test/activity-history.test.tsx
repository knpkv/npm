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
    expect(markup).toContain('aria-label="Filter activity"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain("24 visible · 30 matching · 30 jobs")
    expect(markup).toContain("Load earlier · 6 remaining")
    expect([...markup.matchAll(/data-activity-row=""/g)]).toHaveLength(24)
    expect(markup).not.toContain(sensitivePrompt)
  })
})
