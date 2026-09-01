/**
 * Unit tests for {@link diffApprovalPools}.
 *
 * Covers pool membership transitions (user added → approval_requested),
 * no-op cases (no user, already in pool, removed from pool, both empty),
 * multi-rule detection, and optional title/profile omission.
 */
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { type DiffablePR, diffApprovalPools, diffPR } from "../src/CacheService/diff.js"
import { ApprovalRule } from "../src/Domain.js"

const decodeApprovalRule = Schema.decodeSync(ApprovalRule)

const makeRule = (overrides: Partial<ApprovalRule> = {}): ApprovalRule =>
  decodeApprovalRule({
    ruleName: "Rule",
    requiredApprovals: 1,
    poolMembers: [],
    satisfied: false,
    ...overrides
  })

describe("diffApprovalPools", () => {
  it("returns empty when no currentUser", () => {
    const cached = [makeRule({ poolMembers: [] })]
    const fresh = [makeRule({ poolMembers: ["alice"] })]
    expect(diffApprovalPools(cached, fresh, undefined, "1", "acc")).toEqual([])
  })

  it("returns empty when user was already in pool", () => {
    const cached = [makeRule({ poolMembers: ["alice"] })]
    const fresh = [makeRule({ poolMembers: ["alice"] })]
    expect(diffApprovalPools(cached, fresh, "alice", "1", "acc")).toEqual([])
  })

  it("returns approval_requested when user newly added to pool", () => {
    const cached = [makeRule({ poolMembers: [] })]
    const fresh = [makeRule({ poolMembers: ["alice"] })]
    const result = diffApprovalPools(cached, fresh, "alice", "42", "acc", "Fix bug", "dev")
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("approval_requested")
    expect(result[0].pullRequestId).toBe("42")
    expect(result[0].awsAccountId).toBe("acc")
    expect(result[0].title).toBe("Fix bug")
    expect(result[0].profile).toBe("dev")
    expect(result[0].message).toContain("#42")
  })

  it("returns approval_changed when user removed from pool", () => {
    const cached = [makeRule({ poolMembers: ["alice"] })]
    const fresh = [makeRule({ poolMembers: [] })]
    const result = diffApprovalPools(cached, fresh, "alice", "1", "acc")
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("approval_changed")
    expect(result[0].message).toContain("no longer required")
  })

  it("returns empty when both cached and fresh are empty", () => {
    expect(diffApprovalPools([], [], "alice", "1", "acc")).toEqual([])
  })

  it("detects user added across multiple rules", () => {
    const cached = [makeRule({ ruleName: "R1", poolMembers: ["bob"] })]
    const fresh = [
      makeRule({ ruleName: "R1", poolMembers: ["bob"] }),
      makeRule({ ruleName: "R2", poolMembers: ["alice"] })
    ]
    const result = diffApprovalPools(cached, fresh, "alice", "1", "acc")
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("approval_requested")
  })

  it("omits title/profile when not provided", () => {
    const cached: Array<ApprovalRule> = []
    const fresh = [makeRule({ poolMembers: ["alice"] })]
    const result = diffApprovalPools(cached, fresh, "alice", "1", "acc")
    expect(result).toHaveLength(1)
    expect(result[0].title).toBeUndefined()
    expect(result[0].profile).toBeUndefined()
  })
})

describe("diffPR", () => {
  const makePR = (overrides: Partial<DiffablePR> = {}): DiffablePR => ({
    id: "42",
    title: "Fix bug",
    description: "details",
    repositoryName: "repo",
    accountProfile: "dev",
    accountRegion: "eu-west-1",
    status: "OPEN",
    isApproved: 0,
    isMergeable: 0,
    commentCount: 0,
    ...overrides
  })

  it("normalizes SQLite numeric approval and mergeability flags", () => {
    const notifications = diffPR(
      makePR({ isApproved: 0, isMergeable: 0 }),
      makePR({ isApproved: 1, isMergeable: 1 }),
      "account"
    )

    expect(notifications.map(({ message, type }) => ({ type, message }))).toEqual([
      { type: "approval_changed", message: "Approval granted on #42 Fix bug (repo)" },
      { type: "merge_changed", message: "#42 Fix bug (repo) is now mergeable" }
    ])
  })

  it("classifies a numeric non-mergeable closed PR as merged", () => {
    const notifications = diffPR(
      makePR({ status: "OPEN", isMergeable: 1 }),
      makePR({ status: "CLOSED", isMergeable: 0 }),
      "account"
    )

    expect(notifications.some(({ type }) => type === "pr_merged")).toBe(true)
    expect(notifications.some(({ type }) => type === "pr_closed")).toBe(false)
  })
})
