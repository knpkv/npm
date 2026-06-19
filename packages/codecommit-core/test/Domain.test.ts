/**
 * Unit tests for Domain schemas and logic.
 *
 * Covers Account, PullRequest, PRComment decode/encode, ApprovalRule
 * encode/decode (optional fromTemplate, roundtrip with poolMemberArns),
 * and needsMyReview edge cases (no user, not in pool, already approved,
 * all rules satisfied, no rules, approvalRules defaults to []).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Account, ApprovalRule, identityMatches, needsMyReview, PRComment, PullRequest } from "../src/Domain.js"

describe("Domain", () => {
  describe("Account", () => {
    // Schema.Class decode must enforce branded AwsProfileName on id field
    it.effect("decodes valid account", () =>
      Effect.gen(function*() {
        const account = yield* Schema.decode(Account)({ profile: "dev", region: "us-east-1" })
        expect(account.profile).toBe("dev")
        expect(account.region).toBe("us-east-1")
      }))
  })

  describe("PullRequest", () => {
    const validPR = {
      id: "123",
      title: "Add feature",
      author: "john",
      repositoryName: "my-repo",
      creationDate: new Date("2024-01-15"),
      lastModifiedDate: new Date("2024-01-16"),
      link: "https://console.aws.amazon.com",
      account: { profile: "dev", region: "us-east-1" },
      status: "OPEN" as const,
      sourceBranch: "feature/x",
      destinationBranch: "main",
      isMergeable: true,
      isApproved: false,
      approvedBy: [],
      commentedBy: []
    }

    // Ensures Schema.Class roundtrips and all fields are preserved
    it.effect("decodes valid pull request with all fields", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(validPR)
        expect(pr.id).toBe("123")
        expect(pr.title).toBe("Add feature")
        expect(pr.status).toBe("OPEN")
        expect(pr.isMergeable).toBe(true)
      }))

    // consoleUrl getter must construct correct AWS Console deep-link
    it.effect("computes consoleUrl from account region and PR id", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(validPR)
        expect(pr.consoleUrl).toContain("us-east-1.console.aws.amazon.com")
        expect(pr.consoleUrl).toContain("/pull-requests/123")
        expect(pr.consoleUrl).toContain("my-repo")
      }))

    // description is optional — must accept absent value
    it.effect("allows missing description", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(validPR)
        expect(pr.description).toBeUndefined()
      }))

    // Status must only accept OPEN or CLOSED literals
    it.effect("rejects invalid status", () =>
      Effect.gen(function*() {
        const result = yield* Schema.decode(PullRequest)({ ...validPR, status: "INVALID" }).pipe(
          Effect.flip
        )
        expect(result).toBeDefined()
      }))
  })

  describe("ApprovalRule", () => {
    it.effect("decodes valid approval rule", () =>
      Effect.gen(function*() {
        const rule = yield* Schema.decode(ApprovalRule)({
          ruleName: "Require 2 approvers",
          requiredApprovals: 2,
          poolMembers: ["alice", "bob"],
          satisfied: false
        })
        expect(rule.ruleName).toBe("Require 2 approvers")
        expect(rule.requiredApprovals).toBe(2)
        expect(rule.poolMembers).toEqual(["alice", "bob"])
        expect(rule.satisfied).toBe(false)
        expect(rule.fromTemplate).toBeUndefined()
      }))

    it.effect("decodes with optional fromTemplate", () =>
      Effect.gen(function*() {
        const rule = yield* Schema.decode(ApprovalRule)({
          ruleName: "Template rule",
          requiredApprovals: 1,
          poolMembers: ["alice"],
          satisfied: true,
          fromTemplate: "default-template"
        })
        expect(rule.fromTemplate).toBe("default-template")
      }))

    it.effect("roundtrips through encode/decode", () =>
      Effect.gen(function*() {
        const input = {
          ruleName: "Rule",
          requiredApprovals: 1,
          poolMembers: ["alice"],
          poolMemberArns: ["arn:aws:iam::123:user/alice"],
          satisfied: false
        }
        const decoded = yield* Schema.decode(ApprovalRule)(input)
        const encoded = yield* Schema.encode(ApprovalRule)(decoded)
        expect(encoded).toEqual(input)
      }))
  })

  describe("PullRequest.needsMyReview", () => {
    const basePR = {
      id: "123",
      title: "Feature",
      author: "john",
      repositoryName: "repo",
      creationDate: new Date("2024-01-15"),
      lastModifiedDate: new Date("2024-01-16"),
      link: "https://console.aws.amazon.com",
      account: { profile: "dev", region: "us-east-1" },
      status: "OPEN" as const,
      sourceBranch: "feature/x",
      destinationBranch: "main",
      isMergeable: true,
      isApproved: false,
      approvedBy: [] as Array<string>,
      commentedBy: [] as Array<string>
    }

    it.effect("returns false when no currentUser", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
        })
        expect(needsMyReview(pr, undefined)).toBe(false)
      }))

    it.effect("returns false when user not in any pool", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
        })
        expect(needsMyReview(pr, "bob")).toBe(false)
      }))

    it.effect("returns true when user is in unsatisfied rule pool", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice", "bob"], satisfied: false }]
        })
        expect(needsMyReview(pr, "alice")).toBe(true)
      }))

    it.effect("returns false when user already approved", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvedBy: ["alice"],
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
        })
        expect(needsMyReview(pr, "alice")).toBe(false)
      }))

    it.effect("returns false when all rules satisfied", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: true }]
        })
        expect(needsMyReview(pr, "alice")).toBe(false)
      }))

    it.effect("returns false when no approval rules", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(basePR)
        expect(needsMyReview(pr, "alice")).toBe(false)
      }))

    it.effect("defaults approvalRules to empty array", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)(basePR)
        expect(pr.approvalRules).toEqual([])
      }))

    // SSO/ARN robustness: caller identity differs from the pool member only by
    // case — must still match (identityMatches is a superset of exact match).
    it.effect("matches a pool member differing only by case", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["Alice"], satisfied: false }]
        })
        expect(needsMyReview(pr, "alice")).toBe(true)
      }))

    // Caller is a full assumed-role ARN whose final segment is the bare pool member.
    it.effect("matches when the caller is an ARN whose final segment is the pool member", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
        })
        const me = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice"
        expect(needsMyReview(pr, me)).toBe(true)
      }))

    // Pool member carries the AWSReservedSSO role-session form; caller is the bare username.
    it.effect("matches when the pool member carries the role-session-name form", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{
            ruleName: "R1",
            requiredApprovals: 1,
            poolMembers: ["AWSReservedSSO_Admin_abc/alice"],
            satisfied: false
          }]
        })
        expect(needsMyReview(pr, "alice")).toBe(true)
      }))

    // Already approved under a divergent identity form → no match.
    it.effect("returns false when caller already approved under an ARN form", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvedBy: ["arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice"],
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
        })
        expect(needsMyReview(pr, "alice")).toBe(false)
      }))

    // A clearly-different user must NOT match, even with shared ARN structure.
    it.effect("does not match an unrelated user sharing ARN structure", () =>
      Effect.gen(function*() {
        const pr = yield* Schema.decode(PullRequest)({
          ...basePR,
          approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["bob"], satisfied: false }]
        })
        const me = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice"
        expect(needsMyReview(pr, me)).toBe(false)
      }))
  })

  describe("identityMatches", () => {
    it("matches identical usernames", () => {
      expect(identityMatches("alice", "alice")).toBe(true)
    })

    it("matches case-insensitively", () => {
      expect(identityMatches("Alice", "alice")).toBe(true)
    })

    it("matches an ARN whose final segment equals the other side", () => {
      expect(
        identityMatches("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice", "alice")
      ).toBe(true)
    })

    it("matches the role-session-name form against a bare username", () => {
      expect(identityMatches("alice", "AWSReservedSSO_Admin_abc/alice")).toBe(true)
    })

    it("does not match a different user", () => {
      expect(identityMatches("alice", "bob")).toBe(false)
    })

    it("does not match on empty inputs", () => {
      expect(identityMatches("", "alice")).toBe(false)
      expect(identityMatches("alice", "")).toBe(false)
    })
  })

  describe("PRComment", () => {
    // Verifies Schema.Class decode with branded CommentId
    it.effect("decodes valid comment", () =>
      Effect.gen(function*() {
        const comment = yield* Schema.decode(PRComment)({
          id: "c-1",
          content: "Looks good",
          author: "jane",
          creationDate: new Date("2024-01-15"),
          deleted: false
        })
        expect(comment.id).toBe("c-1")
        expect(comment.content).toBe("Looks good")
      }))

    // Optional fields (inReplyTo, filePath, lineNumber) must be absent-safe
    it.effect("allows optional fields to be absent", () =>
      Effect.gen(function*() {
        const comment = yield* Schema.decode(PRComment)({
          id: "c-2",
          content: "LGTM",
          author: "bob",
          creationDate: new Date(),
          deleted: false
        })
        expect(comment.inReplyTo).toBeUndefined()
        expect(comment.filePath).toBeUndefined()
        expect(comment.lineNumber).toBeUndefined()
      }))
  })
})
