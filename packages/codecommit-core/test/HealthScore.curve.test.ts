/**
 * The health curve (workers/arch2.L2-14-health.design.md, curve A, acked 2026-10-06) over the eight
 * open pull requests of a real CodeCommit account, sanitized to the inputs the score reads, plus
 * reference rows. Under the old linear curve every one of the eight scored 0.0.
 */
import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { PullRequest } from "../src/Domain.js"
import { calculateHealthScore, getScoreTier, healthUnknownReason } from "../src/HealthScore.js"

const now = new Date("2026-10-06T21:00:00.000Z")

interface Inputs {
  readonly lastModifiedDate: string
  readonly creationDate: string
  readonly commentCount: number | undefined
  readonly isMergeable: boolean
  readonly isApproved: boolean
  /** Number of approval rules; none means CodeCommit's approval needs no sign-off. */
  readonly rules: number
  readonly scoped: boolean
  readonly described: boolean
}

const pullRequest = (inputs: Inputs) =>
  Schema.decodeSync(PullRequest)({
    id: "1",
    title: inputs.scoped ? "feat(payments): change" : "Change",
    ...(inputs.described && { description: "What and why." }),
    author: "author",
    repositoryName: "repository",
    creationDate: new Date(inputs.creationDate),
    lastModifiedDate: new Date(inputs.lastModifiedDate),
    link: "https://example.invalid/pr/1",
    account: { profile: "dev", region: "eu-central-1" },
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: inputs.isMergeable,
    isApproved: inputs.isApproved,
    ...(inputs.commentCount !== undefined && { commentCount: inputs.commentCount }),
    approvedBy: [],
    commentedBy: [],
    approvalRules: Array.from({ length: inputs.rules }, (_, i) => ({
      ruleName: `rule-${i}`,
      requiredApprovals: 1,
      poolMembers: [],
      satisfied: inputs.isApproved
    }))
  })

const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

const table: ReadonlyArray<readonly [string, Inputs, number, "green" | "yellow" | "red"]> = [
  [
    "#14",
    {
      lastModifiedDate: "2025-07-27T16:45:12.430Z",
      creationDate: "2024-05-21T11:39:52.928Z",
      commentCount: 5,
      isMergeable: true,
      isApproved: false,
      rules: 1,
      scoped: true,
      described: true
    },
    2.5,
    "red"
  ],
  [
    "#24",
    {
      lastModifiedDate: "2025-06-15T10:49:35.933Z",
      creationDate: "2025-06-15T10:49:35.933Z",
      commentCount: 0,
      isMergeable: false,
      isApproved: true,
      rules: 0,
      scoped: true,
      described: true
    },
    0,
    "red"
  ],
  [
    "#25",
    {
      lastModifiedDate: "2025-06-15T14:46:51.874Z",
      creationDate: "2025-06-15T14:46:16.021Z",
      commentCount: 1,
      isMergeable: true,
      isApproved: true,
      rules: 0,
      scoped: true,
      described: true
    },
    2.5,
    "red"
  ],
  [
    "#31",
    {
      lastModifiedDate: "2025-11-09T17:35:46.106Z",
      creationDate: "2025-06-15T15:39:57.310Z",
      commentCount: 3,
      isMergeable: true,
      isApproved: true,
      rules: 0,
      scoped: true,
      described: false
    },
    3,
    "red"
  ],
  [
    "#32",
    {
      lastModifiedDate: "2026-08-09T13:50:32.858Z",
      creationDate: "2026-01-23T14:41:21.242Z",
      commentCount: 1,
      isMergeable: true,
      isApproved: false,
      rules: 1,
      scoped: false,
      described: false
    },
    0.6,
    "red"
  ],
  [
    "#35",
    {
      lastModifiedDate: "2026-08-15T22:18:47.290Z",
      creationDate: "2026-07-27T09:40:31.132Z",
      commentCount: 3,
      isMergeable: true,
      isApproved: true,
      rules: 0,
      scoped: false,
      described: true
    },
    3.8,
    "red"
  ],
  [
    "#36",
    {
      lastModifiedDate: "2026-08-09T19:47:09.067Z",
      creationDate: "2026-07-29T17:01:14.397Z",
      commentCount: 1,
      isMergeable: true,
      isApproved: true,
      rules: 0,
      scoped: false,
      described: true
    },
    2.7,
    "red"
  ],
  [
    "#44",
    {
      lastModifiedDate: "2026-07-31T08:07:00.236Z",
      creationDate: "2026-07-31T08:07:00.236Z",
      commentCount: 0,
      isMergeable: true,
      isApproved: true,
      rules: 0,
      scoped: false,
      described: true
    },
    2.2,
    "red"
  ],
  [
    "1d, 2 comments, approved",
    {
      lastModifiedDate: daysAgo(1),
      creationDate: daysAgo(1),
      commentCount: 2,
      isMergeable: true,
      isApproved: true,
      rules: 1,
      scoped: true,
      described: true
    },
    10,
    "green"
  ],
  [
    "1d, no comments, pending",
    {
      lastModifiedDate: daysAgo(1),
      creationDate: daysAgo(1),
      commentCount: 0,
      isMergeable: true,
      isApproved: false,
      rules: 1,
      scoped: true,
      described: true
    },
    8.6,
    "green"
  ],
  [
    "4d, 1 comment, pending",
    {
      lastModifiedDate: daysAgo(4),
      creationDate: daysAgo(5),
      commentCount: 1,
      isMergeable: true,
      isApproved: false,
      rules: 1,
      scoped: true,
      described: true
    },
    7.8,
    "green"
  ],
  [
    "10d, 1 comment, pending",
    {
      lastModifiedDate: daysAgo(10),
      creationDate: daysAgo(12),
      commentCount: 1,
      isMergeable: true,
      isApproved: false,
      rules: 1,
      scoped: true,
      described: true
    },
    6.1,
    "yellow"
  ],
  [
    "7d, conflict",
    {
      lastModifiedDate: daysAgo(7),
      creationDate: daysAgo(7),
      commentCount: 0,
      isMergeable: false,
      isApproved: false,
      rules: 1,
      scoped: true,
      described: true
    },
    3.4,
    "red"
  ]
]

const total = (inputs: Inputs) => Option.map(calculateHealthScore(pullRequest(inputs), now), (score) => score.total)

describe("health curve A", () => {
  it.each(table)("%s scores as designed", (_, inputs, expected, tier) => {
    expect(total(inputs)).toEqual(Option.some(expected))
    expect(getScoreTier(expected)).toBe(tier)
  })

  it("is Unknown when CodeCommit gave no activity date", () => {
    const base = table[0]![1]
    expect(total({ ...base, lastModifiedDate: new Date(0).toISOString() })).toEqual(Option.none())
    expect(total({ ...base, creationDate: new Date(0).toISOString() })).toEqual(Option.none())
  })

  it("names the date CodeCommit left out when the score is Unknown", () => {
    const base = table[0]![1]
    const epoch = new Date(0).toISOString()
    expect(healthUnknownReason(pullRequest({ ...base, lastModifiedDate: epoch }))).toEqual(
      Option.some("CodeCommit gave no last-activity date")
    )
    expect(healthUnknownReason(pullRequest({ ...base, creationDate: epoch }))).toEqual(
      Option.some("CodeCommit gave no creation date")
    )
    expect(healthUnknownReason(pullRequest({ ...base, creationDate: epoch, lastModifiedDate: epoch }))).toEqual(
      Option.some("CodeCommit gave no creation or last-activity date")
    )
    // Missing comments still score, as a lower bound.
    expect(healthUnknownReason(pullRequest({ ...base, commentCount: undefined }))).toEqual(Option.none())
  })

  it("scores missing comments as a lower bound and says so", () => {
    const inputs = { ...table[10]![1], commentCount: undefined }
    const score = Option.getOrThrow(calculateHealthScore(pullRequest(inputs), now))
    expect(score.total).toBeLessThanOrEqual(Option.getOrThrow(total(table[10]![1])))
    expect(score.categories.find((category) => category.label === "Engagement")?.description)
      .toBe("Comments not loaded yet")
  })

  it("never rises with more idle days, and never falls with more comments", () => {
    const base = table[11]![1]
    const idle = [0, 1, 3, 7, 14, 30, 90, 400].map((days) =>
      Option.getOrThrow(total({ ...base, lastModifiedDate: daysAgo(days) }))
    )
    expect(idle).toEqual([...idle].sort((a, b) => b - a))
    const comments = [0, 1, 2, 3, 10].map((count) => Option.getOrThrow(total({ ...base, commentCount: count })))
    expect(comments).toEqual([...comments].sort((a, b) => a - b))
  })
})
