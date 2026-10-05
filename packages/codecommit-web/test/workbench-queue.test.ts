import { describe, expect, it } from "@effect/vitest"
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"

import { formatSpan, ruleProgress, workbenchQueue } from "../src/client/components/workbench-queue.js"

const NOW = new Date("2026-10-05T15:30:00Z")
const HOUR = 3_600_000
const DAY = 24 * HOUR

const make = (overrides: Partial<Parameters<typeof decode>[0]> & { readonly id: string }) =>
  decode({
    account: { profile: "platform-prod", region: "eu-west-1" },
    approvalRules: [],
    approvedBy: [],
    author: "ana",
    commentedBy: [],
    creationDate: new Date(NOW.getTime() - DAY),
    destinationBranch: "main",
    isApproved: false,
    isMergeable: true,
    lastModifiedDate: new Date(NOW.getTime() - HOUR),
    link: "https://example.invalid/pr",
    repositoryName: "infra-core",
    sourceBranch: "feature",
    status: "OPEN",
    title: "RLY-142: rotate keys",
    ...overrides
  })
const decode = Schema.decodeSync(PullRequest)

const rule = (ruleName: string, requiredApprovals: number, poolMembers: ReadonlyArray<string>, satisfied: boolean) => ({
  poolMembers,
  requiredApprovals,
  ruleName,
  satisfied
})

describe("workbenchQueue", () => {
  it("puts a PR in Needs your review when the user is in an unsatisfied pool and has not approved", () => {
    const queue = workbenchQueue(
      [make({ approvalRules: [rule("Two maintainers", 2, ["andrey", "jonas"], false)], id: "1" })],
      "andrey",
      NOW
    )
    expect(queue.rows.map((row) => [row.pullRequest.id, row.group])).toEqual([["1", "review"]])
    expect(queue.summary._tag).toBe("Waiting")
  })

  it("groups own PRs as Yours and commented PRs as Watching, and drops unrelated or closed ones", () => {
    const queue = workbenchQueue(
      [
        make({ author: "andrey", id: "own" }),
        make({ commentedBy: ["andrey"], id: "watched" }),
        make({ id: "unrelated" }),
        make({ author: "andrey", id: "merged", status: "MERGED" })
      ],
      "andrey",
      NOW
    )
    expect(queue.rows.map((row) => [row.pullRequest.id, row.group])).toEqual([["own", "yours"], [
      "watched",
      "watching"
    ]])
  })

  it("reports Unknown, not an empty queue, when no caller identity resolved", () => {
    const queue = workbenchQueue([make({ id: "1" }), make({ id: "2" })], undefined, NOW)
    expect(queue.summary).toEqual({ _tag: "Unknown" })
    expect(queue.rows).toHaveLength(2)
  })

  it("is Clear when nothing waits on the user, naming the user's oldest own PR next", () => {
    const queue = workbenchQueue(
      [
        make({ author: "andrey", creationDate: new Date(NOW.getTime() - 2 * DAY), id: "older" }),
        make({ author: "andrey", id: "newer" })
      ],
      "andrey",
      NOW
    )
    expect(queue.summary._tag).toBe("Clear")
    expect(queue.summary._tag === "Clear" ? queue.summary.next?.pullRequest.id : undefined).toBe("older")
  })

  it("orders by group, then longest open first", () => {
    const pool = [rule("Approvals", 1, ["andrey"], false)]
    const queue = workbenchQueue(
      [
        make({ author: "andrey", id: "yours" }),
        make({ approvalRules: pool, creationDate: new Date(NOW.getTime() - HOUR), id: "fresh" }),
        make({ approvalRules: pool, creationDate: new Date(NOW.getTime() - 3 * DAY), id: "old" })
      ],
      "andrey",
      NOW
    )
    expect(queue.rows.map((row) => row.pullRequest.id)).toEqual(["old", "fresh", "yours"])
    expect(queue.summary._tag === "Waiting" ? formatSpan(queue.summary.oldest.openMs) : "").toBe("3d")
  })

  it("names the worst reason an own PR is stuck: conflicts before quiet before approvals", () => {
    const stuck = (overrides: Parameters<typeof make>[0]) =>
      workbenchQueue([make({ author: "andrey", ...overrides })], "andrey", NOW).rows[0]?.stuck
    expect(stuck({ id: "c", isMergeable: false, lastModifiedDate: new Date(NOW.getTime() - 9 * DAY) })).toBe(
      "conflicts"
    )
    expect(stuck({ id: "q", lastModifiedDate: new Date(NOW.getTime() - 9 * DAY) })).toBe("quiet")
    expect(stuck({ approvalRules: [rule("Approvals", 2, ["ana", "jonas"], false)], id: "a" })).toBe("approvals")
    expect(stuck({ approvalRules: [rule("Approvals", 1, ["ana"], true)], id: "r", isApproved: true })).toBe("ready")
  })
})

describe("ruleProgress", () => {
  it("reports the least-satisfied unsatisfied rule, counting only approvals from that rule's pool", () => {
    const pullRequest = make({
      approvalRules: [
        rule("Security", 1, ["sec-review"], true),
        rule("Two maintainers", 2, ["andrey", "jonas", "mira"], false)
      ],
      approvedBy: ["sec-review", "mira"],
      id: "1"
    })
    expect(ruleProgress(pullRequest)).toEqual({ approved: 1, name: "Two maintainers", required: 2 })
  })

  it("is undefined when the PR has no approval rules", () => {
    expect(ruleProgress(make({ id: "1" }))).toBeUndefined()
  })
})

describe("formatSpan", () => {
  it("uses two units at most and never rounds minutes up", () => {
    expect(formatSpan(2 * DAY + 6 * HOUR + 59 * 60_000)).toBe("2d 6h")
    expect(formatSpan(5 * HOUR)).toBe("5h")
    expect(formatSpan(40 * 60_000 + 59_000)).toBe("40m")
  })
})
