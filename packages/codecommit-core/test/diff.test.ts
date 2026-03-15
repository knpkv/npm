/**
 * Unit tests for {@link diffApprovalPools}.
 *
 * Covers pool membership transitions (user added → approval_requested),
 * no-op cases (no user, already in pool, removed from pool, both empty),
 * multi-rule detection, and optional title/profile omission.
 */
import { describe, expect, it } from "@effect/vitest"
import { diffApprovalPools } from "../src/CacheService/diff.js"
import type { ApprovalRule } from "../src/Domain.js"

const makeRule = (overrides: Partial<ApprovalRule> = {}): ApprovalRule =>
  ({
    ruleName: "Rule",
    requiredApprovals: 1,
    poolMembers: [],
    satisfied: false,
    ...overrides
  }) as ApprovalRule

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
