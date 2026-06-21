/**
 * Filter-preset matching unit tests.
 *
 * `matchesPreset` (in `src/filterPresets.ts`) decides whether a PR belongs to a named
 * `--filter` preset. It is pure given an injected `now` and a per-profile
 * caller-identity map, so we can exercise every preset deterministically:
 *
 * - `mine`             — author equals the resolved caller for the PR's profile
 * - `needs-my-review`  — caller is in an unsatisfied approval pool, not yet approved
 * - `stale`            — last activity strictly older than the 7-day boundary
 * - `conflicting`      — PR is not mergeable
 *
 * Fixtures are built with `Schema.decodeSync(PullRequest)` — the synchronous
 * decoder for the `PullRequest` Schema.Class — so they are real branded domain
 * objects (no casts), and `mkPR` is a plain synchronous helper.
 *
 * Uses `@effect/vitest` for consistency with the rest of the codebase.
 */
import { describe, expect, it } from "@effect/vitest"
import { identityMatches, PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { matchesPreset } from "../src/filterPresets.js"

// ── Fixtures ─────────────────────────────────────────────────────────

const NOW = new Date("2024-06-19T12:00:00Z")
const STALE_MS = 86_400_000

interface Overrides {
  readonly profile?: string
  readonly author?: string
  readonly lastModifiedDate?: Date
  readonly isMergeable?: boolean
  readonly approvedBy?: ReadonlyArray<string>
  readonly approvalRules?: ReadonlyArray<{
    readonly ruleName: string
    readonly requiredApprovals: number
    readonly poolMembers: ReadonlyArray<string>
    readonly satisfied: boolean
  }>
}

const mkPR = (o: Overrides = {}): PullRequest =>
  Schema.decodeSync(PullRequest)({
    id: "123",
    title: "Add feature",
    author: o.author ?? "alice",
    repositoryName: "my-repo",
    creationDate: new Date("2024-06-01"),
    lastModifiedDate: o.lastModifiedDate ?? NOW,
    link: "https://console.aws.amazon.com",
    account: { profile: o.profile ?? "dev", region: "us-east-1" },
    status: "OPEN",
    sourceBranch: "feature/x",
    destinationBranch: "main",
    isMergeable: o.isMergeable ?? true,
    isApproved: false,
    approvedBy: o.approvedBy ?? [],
    commentedBy: [],
    approvalRules: o.approvalRules ?? []
  })

const callers = (entries: ReadonlyArray<readonly [string, string]>) => new Map<string, string>(entries)

// ── mine ─────────────────────────────────────────────────────────────

describe("matchesPreset / mine", () => {
  // Author equals the resolved caller for the PR's profile → match.
  it("matches a PR authored by the resolved caller", () => {
    const pr = mkPR({ profile: "dev", author: "alice" })
    expect(matchesPreset("mine", pr, callers([["dev", "alice"]]), NOW)).toBe(true)
  })

  // Author differs from the caller → no match.
  it("does not match a PR authored by someone else", () => {
    const pr = mkPR({ profile: "dev", author: "bob" })
    expect(matchesPreset("mine", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
  })

  // No resolved caller for the PR's profile (e.g. identity lookup failed) → no match.
  it("does not match when the profile has no resolved caller", () => {
    const pr = mkPR({ profile: "prod", author: "alice" })
    expect(matchesPreset("mine", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
  })

  // SSO: caller resolved to a full assumed-role ARN whose session segment is the author → match.
  it("matches when the caller is an ARN whose final segment is the author (SSO)", () => {
    const pr = mkPR({ profile: "dev", author: "alice" })
    const me = "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc123/alice"
    expect(matchesPreset("mine", pr, callers([["dev", me]]), NOW)).toBe(true)
  })
})

// ── identityMatches (robust SSO/ARN comparison) ──────────────────────

describe("identityMatches", () => {
  // Exact match still works (superset of the original strict comparison).
  it("matches identical usernames", () => {
    expect(identityMatches("alice", "alice")).toBe(true)
  })

  // Case-insensitive: IAM/SSO identities differ only in case.
  it("matches case-insensitively", () => {
    expect(identityMatches("Alice", "alice")).toBe(true)
    expect(identityMatches("ALICE@CORP.COM", "alice@corp.com")).toBe(true)
  })

  // Caller is a full assumed-role ARN; author is the bare session-name/username.
  it("matches an ARN whose final segment equals the author", () => {
    expect(
      identityMatches("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice", "alice")
    ).toBe(true)
  })

  // Author is the AWSReservedSSO role-session form; caller is the bare username.
  it("matches when the author carries the role-session-name form", () => {
    expect(identityMatches("alice", "AWSReservedSSO_Admin_abc/alice")).toBe(true)
  })

  // A clearly-different user must NOT match, even with shared ARN structure.
  it("does not match a different user", () => {
    expect(identityMatches("alice", "bob")).toBe(false)
    expect(
      identityMatches("arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice", "bob")
    ).toBe(false)
  })

  // Empty inputs never match (guards against null/empty identity resolving to a match).
  it("does not match on empty inputs", () => {
    expect(identityMatches("", "alice")).toBe(false)
    expect(identityMatches("alice", "")).toBe(false)
  })
})

// ── needs-my-review ──────────────────────────────────────────────────

describe("matchesPreset / needs-my-review", () => {
  // Caller is in an unsatisfied approval pool and has not approved → match.
  it("matches when caller is in an unsatisfied approval pool", () => {
    const pr = mkPR({
      profile: "dev",
      approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
    })
    expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(true)
  })

  // Caller already approved → no match.
  it("does not match when caller already approved", () => {
    const pr = mkPR({
      profile: "dev",
      approvedBy: ["alice"],
      approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
    })
    expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
  })

  // Caller is not in any pool → no match.
  it("does not match when caller is not in any approval pool", () => {
    const pr = mkPR({
      profile: "dev",
      approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["bob"], satisfied: false }]
    })
    expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
  })

  // No resolved caller for the profile → no match (needsMyReview returns false for undefined).
  it("does not match when the profile has no resolved caller", () => {
    const pr = mkPR({
      profile: "prod",
      approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
    })
    expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
  })
})

// ── stale (7-day boundary) ───────────────────────────────────────────

describe("matchesPreset / stale", () => {
  // Just over 7 days (7 days + 1ms) of inactivity → stale.
  it("matches a PR just past the 7-day boundary", () => {
    const pr = mkPR({ lastModifiedDate: new Date(NOW.getTime() - (7 * STALE_MS + 1)) })
    expect(matchesPreset("stale", pr, callers([]), NOW)).toBe(true)
  })

  // Exactly 7 days is NOT stale — the predicate is strictly greater than 7.
  it("does not match a PR at exactly the 7-day boundary", () => {
    const pr = mkPR({ lastModifiedDate: new Date(NOW.getTime() - 7 * STALE_MS) })
    expect(matchesPreset("stale", pr, callers([]), NOW)).toBe(false)
  })

  // Recently modified → not stale.
  it("does not match a freshly modified PR", () => {
    const pr = mkPR({ lastModifiedDate: NOW })
    expect(matchesPreset("stale", pr, callers([]), NOW)).toBe(false)
  })
})

// ── conflicting ──────────────────────────────────────────────────────

describe("matchesPreset / conflicting", () => {
  // Not mergeable → conflicting.
  it("matches a non-mergeable PR", () => {
    const pr = mkPR({ isMergeable: false })
    expect(matchesPreset("conflicting", pr, callers([]), NOW)).toBe(true)
  })

  // Mergeable → not conflicting.
  it("does not match a mergeable PR", () => {
    const pr = mkPR({ isMergeable: true })
    expect(matchesPreset("conflicting", pr, callers([]), NOW)).toBe(false)
  })
})
