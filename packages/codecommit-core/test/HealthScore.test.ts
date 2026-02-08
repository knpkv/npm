import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { PullRequest } from "../src/Domain.js"
import { calculateHealthScore, getScoreTier } from "../src/HealthScore.js"

const makePR = (overrides: Partial<{
  creationDate: Date
  lastModifiedDate: Date
  isApproved: boolean
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
    account: { id: "dev", region: "us-east-1" },
    status: "OPEN" as const,
    sourceBranch: "feature/x",
    destinationBranch: "main",
    isMergeable: overrides.isMergeable ?? true,
    isApproved: overrides.isApproved ?? false,
    commentCount: overrides.commentCount
  })

describe("HealthScore", () => {
  describe("calculateHealthScore", () => {
    it("brand new PR scores 10", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, commentCount: 0 })
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(10)
    })

    it("time decay: -1 per day since last activity", () => {
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        commentCount: 0
      })
      const now = new Date("2024-01-04") // 3 days later
      // 10 - 3*1.0 (time) - 3*0.5 (age) = 5.5
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(5.5)
    })

    it("age penalty: -0.5 per day since creation", () => {
      const now = new Date("2024-01-05")
      const pr = makePR({ creationDate: new Date("2024-01-01"), lastModifiedDate: now, commentCount: 0 })
      // 10 - 0 (time) - 4*0.5 (age) = 8
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(8)
    })

    it("comment bonus: +1 per comment", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, commentCount: 3 })
      // 10 + 3 = 13, capped at 10
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(10)
    })

    it("approval bonus: +2 when approved", () => {
      const now = new Date("2024-01-06")
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        isApproved: true,
        commentCount: 0
      })
      // 10 - 5 - 2.5 + 2 = 4.5
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(4.5)
    })

    it("conflict penalty: -3 when not mergeable", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, isMergeable: false, commentCount: 0 })
      // 10 - 3 = 7
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(7)
    })

    it("caps at 10", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now, commentCount: 50, isApproved: true })
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(10)
    })

    it("floors at 0", () => {
      const now = new Date("2024-06-01") // ~150 days later
      const pr = makePR({
        creationDate: new Date("2024-01-01"),
        lastModifiedDate: new Date("2024-01-01"),
        commentCount: 0
      })
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(0)
    })

    it("returns none without commentCount", () => {
      const now = new Date("2024-01-01")
      const pr = makePR({ creationDate: now, lastModifiedDate: now })
      expect(Option.isNone(calculateHealthScore(pr, now))).toBe(true)
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
      // 10 - 5 (time) - 5 (age) + 5 (comments) + 2 (approved) - 3 (conflicts) = 4
      expect(Option.getOrThrow(calculateHealthScore(pr, now)).total).toBe(4)
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
