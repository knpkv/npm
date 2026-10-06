import { describe, expect, it } from "@effect/vitest"
import { type CallerIdentityState, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"

import {
  type Caller,
  formatSpan,
  globMatches,
  poolEntryMatches,
  ruleProgress,
  workbenchQueue,
  yourReviewCount
} from "../src/client/components/workbench-queue.js"

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

/** A caller known only by user name: today's state until the server publishes identities. */
const byName = (username: string | undefined): Caller => ({ identities: undefined, username })

const rule = (
  ruleName: string,
  requiredApprovals: number,
  poolMembers: ReadonlyArray<string>,
  satisfied: boolean,
  poolMemberArns: ReadonlyArray<string> = []
) => ({ poolMemberArns, poolMembers, requiredApprovals, ruleName, satisfied })

describe("workbenchQueue", () => {
  it("puts a PR in Needs your review when the user is in an unsatisfied pool and has not approved", () => {
    const queue = workbenchQueue(
      [make({ approvalRules: [rule("Two maintainers", 2, ["andrey", "jonas"], false)], id: "1" })],
      byName("andrey"),
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
      byName("andrey"),
      NOW
    )
    expect(queue.rows.map((row) => [row.pullRequest.id, row.group])).toEqual([
      ["own", "yours"],
      ["watched", "watching"]
    ])
  })

  it("reports Unknown, not an empty queue, when no caller identity resolved", () => {
    const queue = workbenchQueue([make({ id: "1" }), make({ id: "2" })], byName(undefined), NOW)
    expect(queue.summary._tag).toBe("Unknown")
    expect(queue.rows).toHaveLength(2)
  })

  it("never presents an unknown identity's pull requests as needing review", () => {
    const pool = [rule("Approvals", 1, ["andrey"], false)]
    const queue = workbenchQueue(
      [make({ approvalRules: pool, id: "1" }), make({ author: "andrey", id: "2" })],
      byName(""),
      NOW
    )
    expect(queue.rows.map((row) => row.group)).toEqual(["unsorted", "unsorted"])
  })

  it("is Clear when nothing waits on the user, naming the user's oldest own PR next", () => {
    const queue = workbenchQueue(
      [
        make({ author: "andrey", creationDate: new Date(NOW.getTime() - 2 * DAY), id: "older" }),
        make({ author: "andrey", id: "newer" })
      ],
      byName("andrey"),
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
      byName("andrey"),
      NOW
    )
    expect(queue.rows.map((row) => row.pullRequest.id)).toEqual(["old", "fresh", "yours"])
    expect(queue.summary._tag === "Waiting" ? formatSpan(queue.summary.oldest.openMs) : "").toBe("3d")
  })

  it("names the worst reason an own PR is stuck: conflicts before quiet before approvals", () => {
    const stuck = (overrides: Parameters<typeof make>[0]) =>
      workbenchQueue([make({ author: "andrey", ...overrides })], byName("andrey"), NOW).rows[0]?.stuck
    expect(stuck({ id: "c", isMergeable: false, lastModifiedDate: new Date(NOW.getTime() - 9 * DAY) })).toBe(
      "conflicts"
    )
    expect(stuck({ id: "q", lastModifiedDate: new Date(NOW.getTime() - 9 * DAY) })).toBe("quiet")
    expect(stuck({ approvalRules: [rule("Approvals", 2, ["ana", "jonas"], false)], id: "a" })).toBe("approvals")
    expect(stuck({ approvalRules: [rule("Approvals", 1, ["ana"], true)], id: "r", isApproved: true })).toBe("ready")
    expect(stuck({ id: "n" })).toBe("ready")
  })

  it("does not claim missing approvals when every rule is satisfied but approval was not evaluated", () => {
    const row = workbenchQueue(
      [make({ approvalRules: [rule("Approvals", 1, ["ana"], true)], author: "andrey", id: "u", isApproved: false })],
      byName("andrey"),
      NOW
    ).rows[0]
    expect(row?.stuck).toBe("unverified")
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

  it("breaks equal shares by the number of approvals still missing", () => {
    const pullRequest = make({
      approvalRules: [
        rule("Security", 1, ["sec-review"], false),
        rule("Two maintainers", 2, ["andrey", "jonas"], false)
      ],
      id: "1"
    })
    expect(ruleProgress(pullRequest)).toEqual({ approved: 0, name: "Two maintainers", required: 2 })
  })

  it("counts every approver toward a rule without a pool", () => {
    const pullRequest = make({ approvalRules: [rule("Any two", 3, [], false)], approvedBy: ["ana", "jonas"], id: "1" })
    expect(ruleProgress(pullRequest)).toEqual({ approved: 2, name: "Any two", required: 3 })
  })

  it("matches wildcard pool ARNs against approver ARNs and ignores approvers from other roles", () => {
    const reviewers = "arn:aws:sts::111122223333:assumed-role/CodeCommitReview/*"
    const pullRequest = make({
      approvalRules: [rule("Reviewers", 3, ["*"], false, [reviewers])],
      approvedBy: ["ana", "jonas", "ops"],
      approvedByArns: [
        "arn:aws:sts::111122223333:assumed-role/CodeCommitReview/ana",
        "arn:aws:sts::111122223333:assumed-role/CodeCommitReview/jonas",
        "arn:aws:sts::111122223333:assumed-role/Operations/ops"
      ],
      id: "1"
    })
    expect(ruleProgress(pullRequest)).toEqual({ approved: 2, name: "Reviewers", required: 3 })
  })

  it("lets ARNs decide over shared names: another role's alice does not count, the pool's alice does", () => {
    const pool = [
      "arn:aws:sts::111122223333:assumed-role/Reviewers/alice",
      "arn:aws:sts::111122223333:assumed-role/Reviewers/bob"
    ]
    const otherRole = make({
      approvalRules: [rule("Reviewers", 2, ["alice", "bob"], false, pool)],
      approvedBy: ["alice"],
      approvedByArns: ["arn:aws:sts::111122223333:assumed-role/Operations/alice"],
      id: "1"
    })
    expect(ruleProgress(otherRole)).toEqual({ approved: 0, name: "Reviewers", required: 2 })
    const sameRole = make({
      approvalRules: [rule("Reviewers", 2, ["alice", "bob"], false, pool)],
      approvedBy: ["alice"],
      approvedByArns: [pool[0] ?? ""],
      id: "2"
    })
    expect(ruleProgress(sameRole)).toEqual({ approved: 1, name: "Reviewers", required: 2 })
  })

  it("reports a satisfied rule as complete", () => {
    const pullRequest = make({ approvalRules: [rule("Reviewers", 2, ["*"], true)], id: "1" })
    expect(ruleProgress(pullRequest)).toEqual({ approved: 2, name: "Reviewers", required: 2 })
  })

  it("is undefined when the PR has no approval rules", () => {
    expect(ruleProgress(make({ id: "1" }))).toBeUndefined()
  })
})

describe("poolEntryMatches", () => {
  const user = "arn:aws:iam::111122223333:user/alice"
  const federated = "arn:aws:sts::111122223333:federated-user/alice"
  const session = "arn:aws:sts::111122223333:assumed-role/Reviewers/alice"

  it("matches the CodeCommitApprovers shorthand to an IAM or federated user of that name in that account", () => {
    expect([user, federated].map((arn) => poolEntryMatches("CodeCommitApprovers:111122223333:alice", arn))).toEqual([
      true,
      true
    ])
    expect(poolEntryMatches("CodeCommitApprovers:444455556666:alice", user)).toBe(false)
  })

  it("reaches a role session through the shorthand only with a wildcard or the role name", () => {
    expect(poolEntryMatches("CodeCommitApprovers:111122223333:alice", session)).toBe(false)
    expect(poolEntryMatches("CodeCommitApprovers:111122223333:*alice", session)).toBe(true)
    expect(poolEntryMatches("CodeCommitApprovers:111122223333:Reviewers/alice", session)).toBe(true)
  })

  it("matches a role-only assumed-role ARN to every session of that role", () => {
    expect(poolEntryMatches("arn:aws:sts::111122223333:assumed-role/Reviewers", session)).toBe(true)
    expect(
      poolEntryMatches("arn:aws:sts::111122223333:assumed-role/Reviewers", session.replace("Reviewers", "Operations"))
    ).toBe(false)
  })

  it("matches wildcards anywhere in a fully qualified ARN, and nothing else", () => {
    expect(poolEntryMatches("arn:aws:sts::111122223333:assumed-role/Review*/alice", session)).toBe(true)
    expect(poolEntryMatches("arn:aws:sts::111122223333:assumed-role/Review*/*", session)).toBe(true)
    expect(
      poolEntryMatches(
        "arn:aws:sts::111122223333:assumed-role/Review*/alice",
        session.replace("Reviewers", "Operations")
      )
    ).toBe(false)
    expect(poolEntryMatches("arn:aws:sts::111122223333:assumed-role/Reviewers/alice", session)).toBe(true)
    expect(poolEntryMatches("arn:aws:sts::111122223333:assumed-role/Reviewers.alice", session)).toBe(false)
  })

  it("matches many-wildcard patterns in linear time instead of backtracking", () => {
    const started = performance.now()
    expect(globMatches("*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(200))).toBe(false)
    expect(performance.now() - started).toBeLessThan(250)
    expect(globMatches("a*b*c", "aXbYc")).toBe(true)
    expect(globMatches("a*b*c", "aXbY")).toBe(false)
  })

  it("never counts a name-only approval against a raw wildcard entry, but still does for legacy names", () => {
    const wildcard = make({
      approvalRules: [rule("Reviewers", 2, ["alice"], false, ["arn:aws:sts::111122223333:assumed-role/Review*/alice"])],
      approvedBy: ["alice"],
      id: "1"
    })
    expect(ruleProgress(wildcard)).toEqual({ approved: 0, name: "Reviewers", required: 2 })
    const legacy = make({ approvalRules: [rule("Reviewers", 2, ["alice"], false)], approvedBy: ["alice"], id: "2" })
    expect(ruleProgress(legacy)).toEqual({ approved: 1, name: "Reviewers", required: 2 })
  })

  it("counts a shorthand pool approval in rule progress", () => {
    const pullRequest = make({
      approvalRules: [
        rule("Two", 2, ["alice", "bob"], false, [
          "CodeCommitApprovers:111122223333:alice",
          "CodeCommitApprovers:111122223333:bob"
        ])
      ],
      approvedBy: ["alice"],
      approvedByArns: [user],
      id: "1"
    })
    expect(ruleProgress(pullRequest)).toEqual({ approved: 1, name: "Two", required: 2 })
  })
})

describe("workbenchQueue with role pools", () => {
  const reviewers = rule("Reviewers", 1, ["*"], false, ["arn:aws:sts::111122223333:assumed-role/Reviewers/*"])

  it("lists a PR waiting on a wildcard pool as open to a role pool, and does not report Clear as empty", () => {
    const queue = workbenchQueue([make({ approvalRules: [reviewers], id: "1" })], byName("andrey"), NOW)
    expect(queue.rows.map((row) => [row.pullRequest.id, row.group])).toEqual([["1", "pool"]])
    expect(queue.summary).toMatchObject({ _tag: "Clear", pooled: 1 })
  })

  it("leaves it out once the user approved, the rule is satisfied, or the user wrote it", () => {
    const queue = workbenchQueue(
      [
        make({ approvalRules: [reviewers], approvedBy: ["andrey"], id: "approved" }),
        make({ approvalRules: [{ ...reviewers, satisfied: true }], id: "satisfied" })
      ],
      byName("andrey"),
      NOW
    )
    expect(queue.rows).toEqual([])
    const own = workbenchQueue(
      [make({ approvalRules: [reviewers], author: "andrey", id: "own" })],
      byName("andrey"),
      NOW
    )
    expect(own.rows.map((row) => row.group)).toEqual(["yours"])
  })

  it("treats a role wildcard ending in the user's name as a maybe, not a certain membership", () => {
    const roleWildcard = rule("Reviewers", 1, ["andrey"], false, [
      "arn:aws:sts::111122223333:assumed-role/Review*/andrey"
    ])
    const queue = workbenchQueue([make({ approvalRules: [roleWildcard], id: "1" })], byName("andrey"), NOW)
    expect(queue.rows.map((row) => row.group)).toEqual(["pool"])
    expect(queue.summary).toMatchObject({ _tag: "Clear", pooled: 1 })
    const named = rule("Maintainers", 1, ["andrey"], false, ["CodeCommitApprovers:111122223333:andrey"])
    const both = workbenchQueue([make({ approvalRules: [roleWildcard, named], id: "2" })], byName("andrey"), NOW)
    expect(both.rows.map((row) => row.group)).toEqual(["review"])
  })

  it("leaves out wildcard entries whose fixed name part cannot be the user", () => {
    const groupFor = (entry: string) =>
      workbenchQueue(
        [make({ approvalRules: [rule("Pool", 1, ["x"], false, [entry])], id: "1" })],
        byName("alice"),
        NOW
      ).rows.map((row) => row.group)
    expect(groupFor("arn:aws:sts::111122223333:assumed-role/Review*/bob")).toEqual([])
    expect(groupFor("arn:aws:sts::111122223333:assumed-role/Reviewers/b*")).toEqual([])
    expect(groupFor("arn:aws:sts::111122223333:assumed-role/Reviewers/a*")).toEqual(["pool"])
    expect(groupFor("arn:aws:sts::111122223333:assumed-role/Rev*")).toEqual(["pool"])
    expect(groupFor("CodeCommitApprovers:111122223333:*alice")).toEqual(["pool"])
    expect(groupFor("CodeCommitApprovers:111122223333:Reviewers/*")).toEqual(["pool"])
    expect(groupFor("arn:aws:iam::111122223333:user/team/ali*")).toEqual(["pool"])
    expect(groupFor("arn:aws:iam::111122223333:user/team/bo*")).toEqual(["pool"])
    expect(groupFor("arn:aws:sts::111122223333:federated-user/b*")).toEqual([])
  })

  it("lists a role-only pool as open to a role pool and counts its sessions' approvals", () => {
    const roleOnly = rule("Reviewers", 2, ["Reviewers"], false, ["arn:aws:sts::111122223333:assumed-role/Reviewers"])
    const pullRequest = make({
      approvalRules: [roleOnly],
      approvedBy: ["jonas"],
      approvedByArns: ["arn:aws:sts::111122223333:assumed-role/Reviewers/jonas"],
      id: "1"
    })
    expect(ruleProgress(pullRequest)).toEqual({ approved: 1, name: "Reviewers", required: 2 })
    expect(workbenchQueue([pullRequest], byName("alice"), NOW).rows.map((row) => row.group)).toEqual(["pool"])
  })

  it("keeps a pool open when the user's same-name approval came from a role the pool does not count", () => {
    const reviewers = rule("Reviewers", 1, ["*"], false, ["arn:aws:sts::111122223333:assumed-role/Reviewers/*"])
    const groupWith = (approvalArn: string) =>
      workbenchQueue(
        [make({ approvalRules: [reviewers], approvedBy: ["alice"], approvedByArns: [approvalArn], id: "1" })],
        byName("alice"),
        NOW
      ).rows.map((row) => row.group)
    expect(groupWith("arn:aws:sts::111122223333:assumed-role/Operations/alice")).toEqual(["pool"])
    expect(groupWith("arn:aws:sts::111122223333:assumed-role/Reviewers/alice")).toEqual([])
  })

  it("puts an unsatisfied rule without a pool in Needs your review, since any approval counts", () => {
    const queue = workbenchQueue(
      [
        make({ approvalRules: [rule("Any one", 1, [], false)], id: "open" }),
        make({ approvalRules: [rule("Any one", 1, [], true)], id: "met" }),
        make({ approvalRules: [rule("Any one", 1, [], false)], approvedBy: ["andrey"], id: "approved" }),
        make({ approvalRules: [rule("Any one", 1, [], false)], author: "andrey", id: "own" })
      ],
      byName("andrey"),
      NOW
    )
    expect(queue.rows.map((row) => [row.pullRequest.id, row.group])).toEqual([
      ["open", "review"],
      ["own", "yours"]
    ])
    expect(queue.summary._tag).toBe("Waiting")
  })

  it("keeps a named pool membership in Needs your review ahead of role pools", () => {
    const queue = workbenchQueue(
      [
        make({ approvalRules: [reviewers], id: "pooled" }),
        make({ approvalRules: [rule("Maintainers", 1, ["andrey"], false)], id: "named" })
      ],
      byName("andrey"),
      NOW
    )
    expect(queue.rows.map((row) => row.group)).toEqual(["review", "pool"])
    expect(queue.summary._tag).toBe("Waiting")
  })
})

describe("formatSpan", () => {
  it("uses two units at most and never rounds minutes up", () => {
    expect(formatSpan(2 * DAY + 6 * HOUR + 59 * 60_000)).toBe("2d 6h")
    expect(formatSpan(5 * HOUR)).toBe("5h")
    expect(formatSpan(40 * 60_000 + 59_000)).toBe("40m")
  })
})

describe("yourReviewCount", () => {
  it("counts exactly what the rail lists under Needs your review, so the header badge agrees", () => {
    const prs = [
      make({ approvalRules: [rule("Maintainers", 1, ["andrey"], false)], id: "named" }),
      make({ approvalRules: [rule("Any one", 1, [], false)], id: "open-rule" }),
      make({
        approvalRules: [rule("Reviewers", 1, ["*"], false, ["arn:aws:sts::111122223333:assumed-role/Reviewers/*"])],
        id: "role-pool"
      }),
      make({ approvalRules: [rule("Maintainers", 1, ["andrey"], false)], approvedBy: ["andrey"], id: "approved" }),
      make({ approvalRules: [rule("Maintainers", 1, ["andrey"], false)], id: "merged", status: "MERGED" }),
      make({ approvalRules: [rule("Maintainers", 1, ["andrey"], false)], author: "andrey", id: "own" })
    ]
    const queue = workbenchQueue(prs, byName("andrey"), NOW)
    expect(queue.summary).toMatchObject({ _tag: "Waiting", count: 2 })
    expect(yourReviewCount(prs, byName("andrey"))).toBe(2)
    expect(yourReviewCount(prs, byName(undefined))).toBe(0)
  })
})

describe("workbenchQueue with the caller's resolved identity", () => {
  const me = "arn:aws:sts::111122223333:assumed-role/Reviewers/andrey"
  const reviewers = rule("Reviewers", 1, ["*"], false, ["arn:aws:sts::111122223333:assumed-role/Reviewers/*"])
  const caller = (identity: CallerIdentityState | undefined): Caller => ({
    identities: identity === undefined ? {} : { "platform-prod": identity },
    username: "andrey"
  })
  const groups = (pullRequests: ReadonlyArray<ReturnType<typeof make>>, who: Caller) =>
    workbenchQueue(pullRequests, who, NOW).rows.map((row) => [row.pullRequest.id, row.group])

  it("decides a wildcard pool exactly once the account's identity resolved", () => {
    const pr = make({ approvalRules: [reviewers], id: "1" })
    expect(groups([pr], caller({ _tag: "Resolved", accountId: "111122223333", arn: me, username: "andrey" }))).toEqual([
      ["1", "review"]
    ])
    const operator = "arn:aws:sts::111122223333:assumed-role/Operations/andrey"
    expect(groups([pr], caller({ _tag: "Resolved", accountId: "111122223333", arn: operator, username: "andrey" })))
      .toEqual([])
  })

  it("keeps the name fallback, never out, while the identity is absent, missing or unresolved", () => {
    const pr = make({ approvalRules: [reviewers], id: "1" })
    expect(groups([pr], byName("andrey"))).toEqual([["1", "pool"]])
    expect(groups([pr], caller(undefined))).toEqual([["1", "pool"]])
    expect(groups([pr], caller({ _tag: "Unresolved", reason: { _tag: "StsRejected" } }))).toEqual([["1", "pool"]])
  })

  it("decides each account on its own identity", () => {
    const who: Caller = {
      identities: {
        "platform-prod": { _tag: "Resolved", accountId: "111122223333", arn: me, username: "andrey" },
        staging: { _tag: "Unresolved", reason: { _tag: "StsRejected" } }
      },
      username: "andrey"
    }
    const prod = make({ approvalRules: [reviewers], id: "prod" })
    const staging = make({
      account: { profile: "staging", region: "eu-west-1" },
      approvalRules: [reviewers],
      id: "stg"
    })
    expect(groups([prod, staging], who)).toEqual([["prod", "review"], ["stg", "pool"]])
  })

  it("does not count another session of the same role as the caller's approval", () => {
    const two = { ...reviewers, requiredApprovals: 2 }
    const other = "arn:aws:sts::111122223333:assumed-role/Reviewers/andrey-ci"
    const resolved = caller({ _tag: "Resolved", accountId: "111122223333", arn: me, username: "andrey" })
    const byOther = make({ approvalRules: [two], approvedBy: ["andrey-ci"], approvedByArns: [other], id: "1" })
    expect(groups([byOther], resolved)).toEqual([["1", "review"]])
    const byMe = make({ approvalRules: [two], approvedBy: ["andrey"], approvedByArns: [me], id: "2" })
    expect(groups([byMe], resolved)).toEqual([])
  })

  it("decides by a resolved identity even without an app-wide user name", () => {
    const nameless: Caller = {
      identities: {
        "platform-prod": { _tag: "Resolved", accountId: "111122223333", arn: me, username: "andrey" },
        staging: { _tag: "Unresolved", reason: { _tag: "StsRejected" } }
      },
      username: undefined
    }
    const prod = make({ approvalRules: [reviewers], id: "prod" })
    const staging = make({
      account: { profile: "staging", region: "eu-west-1" },
      approvalRules: [reviewers],
      id: "stg"
    })
    const queue = workbenchQueue([prod, staging], nameless, NOW)
    expect(queue.rows.map((row) => [row.pullRequest.id, row.group])).toEqual([["prod", "review"], ["stg", "unsorted"]])
    expect(queue.summary._tag).toBe("Waiting")
    expect(yourReviewCount([prod, staging], nameless)).toBe(1)
    expect(workbenchQueue([prod], { identities: undefined, username: undefined }, NOW).summary._tag).toBe("Unknown")
  })

  it("counts the badge with the same identity as the queue", () => {
    const resolved = caller({ _tag: "Resolved", accountId: "111122223333", arn: me, username: "andrey" })
    const pullRequests = [make({ approvalRules: [reviewers], id: "1" })]
    expect(yourReviewCount(pullRequests, resolved)).toBe(1)
    expect(yourReviewCount(pullRequests, byName("andrey"))).toBe(0)
  })
})
