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
 * PRs are built via `Schema.decode(PullRequest)` (the canonical constructor)
 * so the fixtures are real, branded domain objects — no `as any`.
 *
 * Uses `@effect/vitest` for consistency with the rest of the codebase.
 */
import { describe, expect, it } from "@effect/vitest"
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Effect, Schema } from "effect"
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

const mkPR = (o: Overrides = {}): Effect.Effect<PullRequest> =>
  Schema.decode(PullRequest)({
    id: "123",
    title: "Add feature",
    author: o.author ?? "alice",
    repositoryName: "my-repo",
    creationDate: new Date("2024-06-01"),
    lastModifiedDate: o.lastModifiedDate ?? NOW,
    link: "https://console.aws.amazon.com",
    account: { profile: o.profile ?? "dev", region: "us-east-1" },
    status: "OPEN" as const,
    sourceBranch: "feature/x",
    destinationBranch: "main",
    isMergeable: o.isMergeable ?? true,
    isApproved: false,
    approvedBy: o.approvedBy ?? [],
    commentedBy: [],
    approvalRules: o.approvalRules ?? []
  }) as Effect.Effect<PullRequest>

const callers = (entries: ReadonlyArray<readonly [string, string]>) => new Map<string, string>(entries)

// ── mine ─────────────────────────────────────────────────────────────

describe("matchesPreset / mine", () => {
  // Author equals the resolved caller for the PR's profile → match.
  it.effect("matches a PR authored by the resolved caller", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ profile: "dev", author: "alice" })
      expect(matchesPreset("mine", pr, callers([["dev", "alice"]]), NOW)).toBe(true)
    }))

  // Author differs from the caller → no match.
  it.effect("does not match a PR authored by someone else", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ profile: "dev", author: "bob" })
      expect(matchesPreset("mine", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
    }))

  // No resolved caller for the PR's profile (e.g. identity lookup failed) → no match.
  it.effect("does not match when the profile has no resolved caller", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ profile: "prod", author: "alice" })
      expect(matchesPreset("mine", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
    }))
})

// ── needs-my-review ──────────────────────────────────────────────────

describe("matchesPreset / needs-my-review", () => {
  // Caller is in an unsatisfied approval pool and has not approved → match.
  it.effect("matches when caller is in an unsatisfied approval pool", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({
        profile: "dev",
        approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
      })
      expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(true)
    }))

  // Caller already approved → no match.
  it.effect("does not match when caller already approved", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({
        profile: "dev",
        approvedBy: ["alice"],
        approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
      })
      expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
    }))

  // Caller is not in any pool → no match.
  it.effect("does not match when caller is not in any approval pool", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({
        profile: "dev",
        approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["bob"], satisfied: false }]
      })
      expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
    }))

  // No resolved caller for the profile → no match (needsMyReview returns false for undefined).
  it.effect("does not match when the profile has no resolved caller", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({
        profile: "prod",
        approvalRules: [{ ruleName: "R1", requiredApprovals: 1, poolMembers: ["alice"], satisfied: false }]
      })
      expect(matchesPreset("needs-my-review", pr, callers([["dev", "alice"]]), NOW)).toBe(false)
    }))
})

// ── stale (7-day boundary) ───────────────────────────────────────────

describe("matchesPreset / stale", () => {
  // Just over 7 days (7 days + 1ms) of inactivity → stale.
  it.effect("matches a PR just past the 7-day boundary", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ lastModifiedDate: new Date(NOW.getTime() - (7 * STALE_MS + 1)) })
      expect(matchesPreset("stale", pr, callers([]), NOW)).toBe(true)
    }))

  // Exactly 7 days is NOT stale — the predicate is strictly greater than 7.
  it.effect("does not match a PR at exactly the 7-day boundary", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ lastModifiedDate: new Date(NOW.getTime() - 7 * STALE_MS) })
      expect(matchesPreset("stale", pr, callers([]), NOW)).toBe(false)
    }))

  // Recently modified → not stale.
  it.effect("does not match a freshly modified PR", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ lastModifiedDate: NOW })
      expect(matchesPreset("stale", pr, callers([]), NOW)).toBe(false)
    }))
})

// ── conflicting ──────────────────────────────────────────────────────

describe("matchesPreset / conflicting", () => {
  // Not mergeable → conflicting.
  it.effect("matches a non-mergeable PR", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ isMergeable: false })
      expect(matchesPreset("conflicting", pr, callers([]), NOW)).toBe(true)
    }))

  // Mergeable → not conflicting.
  it.effect("does not match a mergeable PR", () =>
    Effect.gen(function*() {
      const pr = yield* mkPR({ isMergeable: true })
      expect(matchesPreset("conflicting", pr, callers([]), NOW)).toBe(false)
    }))
})
