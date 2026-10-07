import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { PullRequest } from "../src/Domain.js"
import { calculateHealthScore, getScoreTier } from "../src/HealthScore.js"

const makePR = (overrides: Partial<{
  creationDate: Date
  lastModifiedDate: Date
  isApproved: boolean
  approvalUnknown: { readonly _tag: "NotPermitted" }
  isMergeable: boolean
  commentCount: number
  title: string
  description: string
}> = {}) =>
  Schema.decodeUnknownSync(PullRequest)({
    id: "1",
    title: overrides.title ?? "Test PR",
    description: overrides.description,
    author: "alice",
    repositoryName: "repo",
    creationDate: overrides.creationDate ?? new Date("2024-01-01"),
    lastModifiedDate: overrides.lastModifiedDate ?? new Date("2024-01-01"),
    link: "https://example.com",
    account: { profile: "dev", region: "us-east-1" },
    status: "OPEN",
    sourceBranch: "feature/x",
    destinationBranch: "main",
    isMergeable: overrides.isMergeable ?? true,
    isApproved: overrides.isApproved ?? false,
    ...(overrides.approvalUnknown !== undefined && { approvalUnknown: overrides.approvalUnknown }),
    commentCount: overrides.commentCount,
    approvedBy: [],
    commentedBy: [],
    // One rule, so an approval is a real sign-off (with no rules CodeCommit reads "approved" too).
    approvalRules: [{
      ruleName: "reviewers",
      requiredApprovals: 1,
      poolMembers: [],
      satisfied: overrides.isApproved ?? false
    }]
  })

describe("HealthScore", () => {
  describe("calculateHealthScore", () => {
    it("brand new PR with nothing earned yet scores the base 8", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, commentCount: 0 })
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(8)
    })

    it("time decay: saturating, up to -6 for idleness", () => {
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        commentCount: 0
      })
      const now = new Date("2024-01-04") // 3 days later
      // 8 - 6(1 - e^(-3/14)) - 2(1 - e^(-3/60)) = 6.7
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(6.7)
    })

    it("age penalty: saturating, up to -2 for age", () => {
      const now = new Date("2024-01-05")
      const pr = makePR({ creationDate: new Date("2024-01-01"), lastModifiedDate: now, commentCount: 0 })
      // 8 - 2(1 - e^(-4/60)) = 7.9
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(7.9)
    })

    it("comment bonus: +0.5 per comment, counting up to 3", () => {
      const now = new Date("2024-01-01")
      const score = (commentCount: number) =>
        Option.getOrThrow(calculateHealthScore(makePR({ creationDate: now, lastModifiedDate: now, commentCount }), now))
          .total
      expect(score(3)).toBe(9.5)
      expect(score(40)).toBe(9.5)
    })

    it("no approval bonus while approval is unknown, even with a last known approval", () => {
      const now = new Date("2024-01-01")
      const score = Option.getOrThrow(
        calculateHealthScore(makePR({ isApproved: true, approvalUnknown: { _tag: "NotPermitted" } }), now)
      )
      expect(score.breakdown.find((b) => b.label === "Approval")?.value).toBe(0)
      expect(score.categories.find((c) => c.label === "Approval")).toMatchObject({
        status: "neutral",
        statusLabel: "UNKNOWN",
        description: expect.stringContaining("Approval unknown")
      })
    })

    it("approval bonus: +2 when approved", () => {
      const now = new Date("2024-01-06")
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        isApproved: true,
        commentCount: 0
      })
      // 8 - 6(1 - e^(-5/14)) - 2(1 - e^(-5/60)) + 2 = 8.0
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(8)
    })

    it("conflict penalty: -3 when not mergeable", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, isMergeable: false, commentCount: 0 })
      // 8 - 3 = 5
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(5)
    })

    it("caps at 10", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({
        creationDate: now,
        lastModifiedDate: now,
        commentCount: 50,
        isApproved: true,
        title: "feat(x): y",
        description: "why"
      })
      // 8 + 1.5 + 2 + 0.5 + 0.5 = 12.5, capped at 10
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(10)
    })

    it("floors at 0", () => {
      const now = new Date("2024-06-01") // ~150 days later
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        commentCount: 0,
        isMergeable: false
      })
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(0)
    })

    it("treats missing commentCount as 0: a lower bound", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now })
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(8)
    })

    it("combined: approved + conflicts + comments + age", () => {
      const now = new Date("2024-01-11")
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-06"),
        isApproved: true,
        isMergeable: false,
        commentCount: 5
      })
      // 8 - 6(1 - e^(-5/14)) - 2(1 - e^(-10/60)) + 1.5 (3 comments counted) + 2 (approved) - 3 = 6.4
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(6.4)
    })

    it("breakdown contains all factors", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, commentCount: 0 })
      const labels = Option.getOrThrow(calculateHealthScore(pr, now)).breakdown.map((b) => b.label)
      expect(labels).toEqual(["Base", "Time decay", "Age", "Comments", "Approval", "Conflicts", "Scope", "Description"])
    })
  })

  describe("categories", () => {
    it("brand new PR: all positive except engagement", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, isApproved: true, commentCount: 5 })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Activity")).toMatchObject({ status: "positive", statusLabel: "ACTIVE" })
      expect(cats.find((c) => c.label === "Age")).toMatchObject({ status: "positive", statusLabel: "FRESH" })
      expect(cats.find((c) => c.label === "Engagement")).toMatchObject({ status: "positive", statusLabel: "ACTIVE" })
      expect(cats.find((c) => c.label === "Approval")).toMatchObject({ status: "positive", statusLabel: "APPROVED" })
      expect(cats.find((c) => c.label === "Mergeable")).toMatchObject({ status: "positive", statusLabel: "CLEAN" })
    })

    it("stale PR: negative activity, old age, silent engagement", () => {
      const now = new Date("2024-02-01")
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        commentCount: 0
      })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Activity")).toMatchObject({ status: "negative", statusLabel: "STALE" })
      expect(cats.find((c) => c.label === "Age")).toMatchObject({ status: "negative", statusLabel: "OLD" })
      expect(cats.find((c) => c.label === "Engagement")).toMatchObject({ status: "negative", statusLabel: "SILENT" })
    })

    it("slowing activity: 3 days since last activity", () => {
      const now = new Date("2024-01-04")
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        commentCount: 0
      })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Activity")).toMatchObject({ status: "neutral", statusLabel: "SLOWING" })
    })

    it("conflict shows negative MERGEABLE", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, isMergeable: false, commentCount: 0 })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Mergeable")).toMatchObject({ status: "negative", statusLabel: "CONFLICT" })
    })

    it("contains all 7 categories", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, commentCount: 0 })
      const labels = Option.getOrThrow(calculateHealthScore(pr, now)).categories.map((c) => c.label)
      expect(labels).toEqual(["Activity", "Age", "Engagement", "Approval", "Mergeable", "Scope", "Description"])
    })

    it("scope detected for conventional commit title", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, title: "feat(auth): add login", commentCount: 0 })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Scope")).toMatchObject({ status: "positive", statusLabel: "DETECTED" })
    })

    it("scope missing for plain title", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, title: "Add login feature", commentCount: 0 })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Scope")).toMatchObject({ status: "negative", statusLabel: "MISSING" })
    })

    it("description provided", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({
        creationDate: now,
        lastModifiedDate: now,
        description: "This PR adds login",
        commentCount: 0
      })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Description")).toMatchObject({ status: "positive", statusLabel: "PROVIDED" })
    })

    it("description missing", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, commentCount: 0 })
      const cats = Option.getOrThrow(calculateHealthScore(pr, now)).categories
      expect(cats.find((c) => c.label === "Description")).toMatchObject({ status: "negative", statusLabel: "MISSING" })
    })
  })

  describe("getScoreTier", () => {
    it("green for 7-10", () => {
      expect(getScoreTier(10)).toBe("green")
      expect(getScoreTier(7)).toBe("green")
      expect(getScoreTier(7.5)).toBe("green")
    })

    it("yellow for 4-6.9", () => {
      expect(getScoreTier(6.9)).toBe("yellow")
      expect(getScoreTier(4)).toBe("yellow")
      expect(getScoreTier(5.5)).toBe("yellow")
    })

    it("red for 0-3.9", () => {
      expect(getScoreTier(3.9)).toBe("red")
      expect(getScoreTier(0)).toBe("red")
      expect(getScoreTier(1.5)).toBe("red")
    })
  })
})
