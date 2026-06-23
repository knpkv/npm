/**
 * `FilterService` orchestration tests.
 *
 * `FilterService` (in `src/FilterService.ts`) holds the cross-account `--filter`
 * fan-out that backs `pr list`: it resolves enabled targets from config, scans
 * each `{ profile, region }` for OPEN PRs, applies the preset + repo/author
 * predicates, and returns a structured `{ prs, failures, unresolvedProfiles }`.
 *
 * These tests drive the service through stub `AwsClient` and `ConfigService`
 * layers (no network, no real config file) so the orchestration — failure
 * collection, unresolved-identity tracking, and sort order — is verified
 * deterministically. PRs are built with `Schema.decodeSync(PullRequest)` so the
 * fixtures are real, branded domain objects (no casts).
 *
 * `bin.ts` is intentionally NOT imported — it boots the CLI/Bun runtime on load.
 */
import { describe, expect, it } from "@effect/vitest"
import { AwsClient, ConfigService, Errors } from "@knpkv/codecommit-core"
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import type { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { FilterService, FilterServiceLive, type FilterTarget } from "../src/FilterService.js"

// ── Fixtures ─────────────────────────────────────────────────────────

const NOW = new Date("2024-06-19T12:00:00Z")

interface PROverrides {
  readonly id?: string
  readonly profile?: string
  readonly region?: string
  readonly author?: string
  readonly repositoryName?: string
  readonly lastModifiedDate?: Date
  readonly isMergeable?: boolean
}

const mkPR = (o: PROverrides = {}): PullRequest =>
  Schema.decodeSync(PullRequest)({
    id: o.id ?? "123",
    title: "Add feature",
    author: o.author ?? "alice",
    repositoryName: o.repositoryName ?? "my-repo",
    creationDate: new Date("2024-06-01"),
    lastModifiedDate: o.lastModifiedDate ?? NOW,
    link: "https://console.aws.amazon.com",
    account: { profile: o.profile ?? "dev", region: o.region ?? "us-east-1" },
    status: "OPEN",
    sourceBranch: "feature/x",
    destinationBranch: "main",
    isMergeable: o.isMergeable ?? true,
    isApproved: false,
    approvedBy: [],
    commentedBy: [],
    approvalRules: []
  })

const target = (profile: string, region = "us-east-1"): FilterTarget => ({
  profile: profile as AwsProfileName,
  region: region as AwsRegion
})

const opts = { repo: Option.none<string>(), author: Option.none<string>() }

/** A key identifying an account target, for routing stub responses. */
const key = (a: { profile: string; region: string }) => `${a.profile}/${a.region}`

interface StubConfig {
  /** PRs returned per target key; absent → empty stream. */
  readonly prsByTarget?: Record<string, ReadonlyArray<PullRequest>>
  /** Target keys whose `getPullRequests` should fail with an AwsApiError. */
  readonly failTargets?: ReadonlyArray<string>
  /** Resolved caller username per profile; `null` → identity lookup fails. */
  readonly callerByProfile?: Record<string, string | null>
}

const awsStub = (cfg: StubConfig): Layer.Layer<AwsClient.AwsClient> =>
  Layer.succeed(
    AwsClient.AwsClient,
    AwsClient.AwsClient.of({
      getPullRequests: (account, _options) => {
        const k = key(account)
        if (cfg.failTargets?.includes(k)) {
          return Stream.fail(
            new Errors.AwsApiError({
              operation: "getPullRequests",
              profile: account.profile,
              region: account.region,
              cause: new Error("boom")
            })
          )
        }
        return Stream.fromIterable(cfg.prsByTarget?.[k] ?? [])
      },
      getCallerIdentity: (account) => {
        const username = cfg.callerByProfile?.[account.profile]
        if (username == null) {
          return Effect.fail(
            new Errors.AwsApiError({
              operation: "getCallerIdentity",
              profile: account.profile,
              region: account.region,
              cause: new Error("no identity")
            })
          )
        }
        return Effect.succeed({ username, accountId: "123456789012" })
      },
      // Unused by FilterService — fail loudly if ever called.
      createPullRequest: () => Effect.die("not implemented"),
      listBranches: () => Effect.die("not implemented"),
      getCommentsForPullRequest: () => Effect.die("not implemented"),
      updatePullRequestTitle: () => Effect.die("not implemented"),
      updatePullRequestDescription: () => Effect.die("not implemented"),
      getPullRequest: () => Effect.die("not implemented"),
      getDifferences: () => Effect.die("not implemented"),
      createApprovalRule: () => Effect.die("not implemented"),
      updateApprovalRule: () => Effect.die("not implemented"),
      deleteApprovalRule: () => Effect.die("not implemented")
    })
  )

interface AccountStub {
  readonly profile: string
  readonly regions: ReadonlyArray<string>
  readonly enabled: boolean
}

const configStub = (accounts: ReadonlyArray<AccountStub>): Layer.Layer<ConfigService.ConfigService> => {
  // Build a real, fully-defaulted TuiConfig via its Schema so the stub returns a
  // genuine domain object (no `as any` on the config shape).
  const config = Schema.decodeSync(ConfigService.TuiConfig)({
    accounts: accounts.map((a) => ({ profile: a.profile, regions: a.regions, enabled: a.enabled }))
  })
  return Layer.succeed(
    ConfigService.ConfigService,
    ConfigService.ConfigService.of({
      load: Effect.succeed(config),
      save: () => Effect.die("not implemented"),
      detectProfiles: Effect.die("not implemented"),
      getConfigPath: Effect.die("not implemented"),
      backup: Effect.die("not implemented"),
      reset: Effect.die("not implemented"),
      validate: Effect.die("not implemented")
    })
  )
}

const provide = (
  aws: Layer.Layer<AwsClient.AwsClient>,
  config: Layer.Layer<ConfigService.ConfigService>
): Layer.Layer<FilterService> =>
  FilterServiceLive.pipe(
    Layer.provide(Layer.mergeAll(aws, config)),
    Layer.orDie
  )

// ── resolveTargets ───────────────────────────────────────────────────

describe("FilterService / resolveTargets", () => {
  // Disabled accounts are dropped; enabled accounts expand to one target per region.
  it.effect("keeps only enabled accounts and flattens regions", () =>
    Effect.gen(function*() {
      const fs = yield* FilterService
      const targets = yield* fs.resolveTargets
      expect(targets.map(key)).toEqual([
        "dev/us-east-1",
        "dev/eu-west-1",
        "stage/us-east-1"
      ])
    }).pipe(
      Effect.provide(provide(
        awsStub({}),
        configStub([
          { profile: "dev", regions: ["us-east-1", "eu-west-1"], enabled: true },
          { profile: "prod", regions: ["us-east-1"], enabled: false },
          { profile: "stage", regions: ["us-east-1"], enabled: true }
        ])
      ))
    ))
})

// ── collect: preset matching ─────────────────────────────────────────

describe("FilterService / collect — preset matching", () => {
  // `conflicting` keeps only non-mergeable PRs.
  it.effect("filters by preset (conflicting)", () =>
    Effect.gen(function*() {
      const fs = yield* FilterService
      const { failures, prs, unresolvedProfiles } = yield* fs.collect(
        "conflicting",
        [target("dev")],
        opts,
        NOW
      )
      expect(prs.map((p) => p.id)).toEqual(["2"])
      expect(failures).toEqual([])
      expect(unresolvedProfiles).toEqual([])
    }).pipe(
      Effect.provide(provide(
        awsStub({
          prsByTarget: {
            "dev/us-east-1": [mkPR({ id: "1", isMergeable: true }), mkPR({ id: "2", isMergeable: false })]
          }
        }),
        configStub([{ profile: "dev", regions: ["us-east-1"], enabled: true }])
      ))
    ))

  // `mine` matches only PRs whose author equals the resolved caller for the profile.
  it.effect("filters by preset (mine) using resolved caller identity", () =>
    Effect.gen(function*() {
      const fs = yield* FilterService
      const { prs, unresolvedProfiles } = yield* fs.collect("mine", [target("dev")], opts, NOW)
      expect(prs.map((p) => p.id)).toEqual(["mine"])
      expect(unresolvedProfiles).toEqual([])
    }).pipe(
      Effect.provide(provide(
        awsStub({
          prsByTarget: {
            "dev/us-east-1": [mkPR({ id: "mine", author: "alice" }), mkPR({ id: "theirs", author: "bob" })]
          },
          callerByProfile: { dev: "alice" }
        }),
        configStub([{ profile: "dev", regions: ["us-east-1"], enabled: true }])
      ))
    ))
})

// ── collect: per-account failure collection ──────────────────────────

describe("FilterService / collect — failure collection", () => {
  // One account errors: it lands in `failures` with a profile/region prefix;
  // the other account's PRs are still returned.
  it.effect("collects per-account failures while returning healthy accounts", () =>
    Effect.gen(function*() {
      const fs = yield* FilterService
      const { failures, prs } = yield* fs.collect(
        "conflicting",
        [target("dev"), target("prod")],
        opts,
        NOW
      )
      expect(prs.map((p) => p.id)).toEqual(["ok"])
      expect(failures).toHaveLength(1)
      expect(failures[0]).toMatch(/^prod\/us-east-1: /)
    }).pipe(
      Effect.provide(provide(
        awsStub({
          prsByTarget: { "dev/us-east-1": [mkPR({ id: "ok", profile: "dev", isMergeable: false })] },
          failTargets: ["prod/us-east-1"]
        }),
        configStub([
          { profile: "dev", regions: ["us-east-1"], enabled: true },
          { profile: "prod", regions: ["us-east-1"], enabled: true }
        ])
      ))
    ))
})

// ── collect: unresolved-identity tracking ────────────────────────────

describe("FilterService / collect — unresolved identity", () => {
  // getCallerIdentity fails for `prod` → its profile appears in unresolvedProfiles,
  // the scan continues, and the profile with a resolved caller still matches.
  it.effect("tracks unresolved profiles and keeps scanning", () =>
    Effect.gen(function*() {
      const fs = yield* FilterService
      const { failures, prs, unresolvedProfiles } = yield* fs.collect(
        "mine",
        [target("dev"), target("prod")],
        opts,
        NOW
      )
      expect(prs.map((p) => p.id)).toEqual(["dev-mine"])
      expect(unresolvedProfiles).toEqual(["prod"])
      // The fetch itself did not fail — only identity resolution did.
      expect(failures).toEqual([])
    }).pipe(
      Effect.provide(provide(
        awsStub({
          prsByTarget: {
            "dev/us-east-1": [mkPR({ id: "dev-mine", profile: "dev", author: "alice" })],
            "prod/us-east-1": [mkPR({ id: "prod-pr", profile: "prod", author: "carol" })]
          },
          callerByProfile: { dev: "alice", prod: null }
        }),
        configStub([
          { profile: "dev", regions: ["us-east-1"], enabled: true },
          { profile: "prod", regions: ["us-east-1"], enabled: true }
        ])
      ))
    ))
})

// ── collect: sort order ──────────────────────────────────────────────

describe("FilterService / collect — sort order", () => {
  // Results are sorted by lastModifiedDate descending across all accounts.
  it.effect("sorts merged results by lastModifiedDate descending", () =>
    Effect.gen(function*() {
      const fs = yield* FilterService
      const { prs } = yield* fs.collect(
        "conflicting",
        [target("dev"), target("prod")],
        opts,
        NOW
      )
      expect(prs.map((p) => p.id)).toEqual(["newest", "middle", "oldest"])
    }).pipe(
      Effect.provide(provide(
        awsStub({
          prsByTarget: {
            "dev/us-east-1": [
              mkPR({ id: "oldest", profile: "dev", isMergeable: false, lastModifiedDate: new Date("2024-01-01") }),
              mkPR({ id: "newest", profile: "dev", isMergeable: false, lastModifiedDate: new Date("2024-06-01") })
            ],
            "prod/us-east-1": [
              mkPR({ id: "middle", profile: "prod", isMergeable: false, lastModifiedDate: new Date("2024-03-01") })
            ]
          }
        }),
        configStub([
          { profile: "dev", regions: ["us-east-1"], enabled: true },
          { profile: "prod", regions: ["us-east-1"], enabled: true }
        ])
      ))
    ))
})
