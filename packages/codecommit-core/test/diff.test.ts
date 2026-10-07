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
      makePR({ isApproved: 0, isMergeable: 0, approvalRules: [makeRule()] }),
      makePR({ isApproved: 1, isMergeable: 1, approvalRules: [makeRule()] }),
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

describe("diffPR approval without rules", () => {
  const pr = (isApproved: boolean, rules: number): DiffablePR => ({
    id: "44",
    title: "Fix",
    repositoryName: "repo",
    accountProfile: "dev",
    status: "OPEN",
    isApproved,
    approvalUnknownReason: null,
    approvalRules: Array.from({ length: rules }, () => makeRule()),
    isMergeable: true
  })
  const approvalChanges = (cached: DiffablePR, fresh: DiffablePR) =>
    diffPR(cached, fresh, "acc").filter((n) => n.type === "approval_changed")

  // With no rules CodeCommit evaluates "approved" though nobody signed off (AWS shows 0 approvals).
  it("announces no approval for a pull request with no rules, whatever its evaluation flips to", () => {
    expect(approvalChanges(pr(false, 0), pr(true, 0))).toEqual([])
    expect(approvalChanges(pr(true, 0), pr(false, 0))).toEqual([])
  })

  it("still announces a real sign-off on a pull request with rules", () => {
    expect(approvalChanges(pr(false, 1), pr(true, 1))).toHaveLength(1)
  })
})

describe("diffPR approval while unknown", () => {
  const pr = (isApproved: boolean, approvalUnknownReason: string | null): DiffablePR => ({
    id: "1",
    title: "Fix",
    repositoryName: "repo",
    accountProfile: "dev",
    status: "OPEN",
    isApproved,
    approvalUnknownReason,
    approvalRules: [makeRule()],
    isMergeable: true
  })
  const approvalChanges = (cached: DiffablePR, fresh: DiffablePR) =>
    diffPR(cached, fresh, "acc").filter((n) => n.type === "approval_changed")

  it("reports no transition into an unknown approval", () => {
    expect(approvalChanges(pr(true, null), pr(false, "NotPermitted"))).toEqual([])
  })

  // A pull request first seen while its evaluation fails is cached as not approved, a placeholder that
  // looks like a last known value. Recovery can't tell them apart, so it announces nothing: no false
  // "Approval granted", at the cost of not announcing a sign-off made while evaluation was failing.
  it("announces nothing when evaluation recovers, whatever the cached value", () => {
    expect(approvalChanges(pr(false, "NotPermitted"), pr(true, null))).toEqual([])
    expect(approvalChanges(pr(true, "NotPermitted"), pr(false, null))).toEqual([])
  })

  it("still announces a transition between two known evaluations", () => {
    expect(approvalChanges(pr(false, null), pr(true, null))).toHaveLength(1)
  })
})
