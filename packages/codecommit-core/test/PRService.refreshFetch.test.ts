/** @effect-diagnostics strictEffectProvide:skip-file */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { PullRequestDetail } from "../src/AwsClient/internal.js"
import { CacheError } from "../src/CacheService/CacheError.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { AccountConfig } from "../src/ConfigService/internal.js"
import { type AppState, PullRequest } from "../src/Domain.js"
import { AwsApiError } from "../src/Errors.js"
import { fetchAndUpsertPRs } from "../src/PRService/refreshFetch.js"

describe("fetchAndUpsertPRs", () => {
  const staleOpenPR = Schema.decodeSync(CachedPullRequest)({
    id: "35",
    awsAccountId: "123456789012",
    repoAccountId: null,
    accountProfile: "test-profile",
    accountRegion: "us-east-1",
    title: "Keep cached PR after provider failure",
    description: null,
    author: "author",
    repositoryName: "example-repository",
    creationDate: "2026-08-01T00:00:00.000Z",
    lastModifiedDate: "2026-08-02T00:00:00.000Z",
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: 0,
    commentCount: null,
    healthScore: null,
    link: "https://example.invalid/pr/35",
    fetchedAt: "2026-08-02T00:00:00.000Z",
    filesAdded: null,
    filesModified: null,
    filesDeleted: null,
    closedAt: null,
    mergedBy: null,
    approvedBy: null,
    approvedByArns: null,
    commentedBy: null,
    approvalRules: null
  })
  const providerOpenPR = Schema.decodeSync(PullRequest)({
    id: "35",
    title: "Still open at provider",
    author: "author",
    repositoryName: "example-repository",
    creationDate: new Date("2026-08-01T00:00:00.000Z"),
    lastModifiedDate: new Date("2026-08-02T00:00:00.000Z"),
    link: "https://example.invalid/pr/35",
    account: { profile: "test-profile", region: "us-east-1", repoAccountId: "" },
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: true,
    isApproved: false,
    approvedBy: [],
    commentedBy: [],
    approvalRules: []
  })
  const providerOpenDetail = Schema.decodeSync(PullRequestDetail)({
    revisionId: "revision-35",
    sourceCommit: "a".repeat(40),
    title: "Still open at provider",
    author: "author",
    status: "OPEN",
    repositoryName: "example-repository",
    sourceBranch: "feature",
    destinationBranch: "main",
    creationDate: new Date("2026-08-01T00:00:00.000Z"),
    lastActivityDate: new Date("2026-08-02T00:00:00.000Z"),
    approvedBy: [],
    approvedByArns: [],
    approvalRules: []
  })
  const providerClosedDetail = new PullRequestDetail({ ...providerOpenDetail, status: "CLOSED" })

  it.effect("preserves the original interruption from an account stream", () =>
    Effect.gen(function*() {
      const interruption = Cause.interrupt(734)
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "loading"
      })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.fromEffect(Effect.failCause(interruption))
        }),
        Layer.mock(PullRequestRepo, {}),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const exit = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(
        Effect.provide(dependencies),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toEqual(interruption.reasons)
      }
    }))

  it.effect("preserves stale cached PRs when their account stream fails", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "loading"
      })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const deleteCalls = yield* Ref.make(0)
      const detailCalls = yield* Ref.make(0)
      const failedAccount = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const successfulAccount = Schema.decodeSync(AccountConfig)({
        profile: "other-profile",
        regions: ["eu-west-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: ({ profile }) =>
            profile === failedAccount.profile ? Stream.fail(new Error("provider unavailable")) : Stream.empty,
          getPullRequest: () =>
            Ref.update(detailCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("unexpected stale detail fetch"))
            )
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          deleteOne: () => Ref.update(deleteCalls, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {
          addSystem: () => Effect.void
        }),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [failedAccount, successfulAccount],
        accountIdMap: new Map([
          ["test-profile", "123456789012"],
          ["other-profile", "210987654321"]
        ]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(detailCalls)).toBe(0)
      expect(yield* Ref.get(deleteCalls)).toBe(0)
      expect(successfulScopes).toEqual([
        { profile: "other-profile", region: "eu-west-1", awsAccountId: "210987654321" }
      ])
    }))

  it.effect("does not reconcile a stale row through a profile now resolved to another AWS account", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty,
          getPullRequest: () => Effect.die("foreign-account stale row must not be reconciled")
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "210987654321"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([
        { profile: "test-profile", region: "us-east-1", awsAccountId: "210987654321" }
      ])
    }))

  it.effect("withholds scope success when stale-row discovery fails", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "loading"
      })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () =>
            Effect.fail(new CacheError({ operation: "find-stale-open", cause: new Error("database unavailable") })),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([])
    }))

  it.effect("withholds scope success when a stale row cannot be refreshed or removed", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty,
          getPullRequest: () =>
            Effect.fail(
              new AwsApiError({
                cause: new Error("provider unavailable"),
                operation: "getPullRequest",
                profile: account.profile,
                region: account.regions[0]!
              })
            )
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          deleteOne: () =>
            Effect.fail(new CacheError({ operation: "delete-pull-request", cause: new Error("database unavailable") })),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([])
    }))

  it.effect("withholds scope success when a failed stale read falls back to cache deletion", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const deleteCalls = yield* Ref.make(0)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty,
          getPullRequest: () =>
            Effect.fail(
              new AwsApiError({
                cause: new Error("provider unavailable"),
                operation: "getPullRequest",
                profile: account.profile,
                region: account.regions[0]!
              })
            )
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          deleteOne: () => Ref.update(deleteCalls, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(deleteCalls)).toBe(1)
      expect(successfulScopes).toEqual([])
    }))

  it.effect("publishes scope success while retaining a stale row authoritatively observed OPEN", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const deleteCalls = yield* Ref.make(0)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty,
          getPullRequest: () => Effect.succeed(providerOpenDetail)
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          deleteOne: () => Ref.update(deleteCalls, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(deleteCalls)).toBe(0)
      expect(successfulScopes).toEqual([
        { profile: "test-profile", region: "us-east-1", awsAccountId: "123456789012" }
      ])
    }))

  it.effect("publishes scope success after a stale row is authoritatively observed CLOSED", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const statusUpdates = yield* Ref.make(0)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty,
          getPullRequest: () => Effect.succeed(providerClosedDetail)
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          updateStatusAndClosedAt: () => Ref.update(statusUpdates, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(statusUpdates)).toBe(1)
      expect(successfulScopes).toEqual([
        { profile: "test-profile", region: "us-east-1", awsAccountId: "123456789012" }
      ])
    }))

  it.effect("does not transition a stale row when the provider returns another repository", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const statusUpdates = yield* Ref.make(0)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty,
          getPullRequest: () =>
            Effect.succeed(
              new PullRequestDetail({
                ...providerClosedDetail,
                repositoryName: "other-repository"
              })
            )
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          updateStatusAndClosedAt: () => Ref.update(statusUpdates, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(statusUpdates)).toBe(0)
    }))

  it.effect("withholds scope success when a listed PR cannot be upserted", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const deleteCalls = yield* Ref.make(0)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.make(providerOpenPR),
          getPullRequest: () => Effect.die("stale reconciliation must not run for an uncertified scope")
        }),
        Layer.mock(PullRequestRepo, {
          upsert: () =>
            Effect.fail(new CacheError({ operation: "upsert-pull-request", cause: new Error("database unavailable") })),
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          deleteOne: () => Ref.update(deleteCalls, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([])
      expect(yield* Ref.get(deleteCalls)).toBe(0)
    }))

  it.effect("withholds scope success when a listed PR has no resolved account identity", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.make(providerOpenPR)
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map(),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([])
    }))

  it.effect("publishes scope success after listed PR upsert and stale reconciliation succeed", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set<string>())
      const upsertedRepoAccountId = yield* Ref.make<string | null | undefined>(undefined)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.make(providerOpenPR)
        }),
        Layer.mock(PullRequestRepo, {
          upsert: (input) => Ref.set(upsertedRepoAccountId, input.repoAccountId),
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(upsertedRepoAccountId)).toBeNull()
      expect(successfulScopes).toEqual([
        { profile: "test-profile", region: "us-east-1", awsAccountId: "123456789012" }
      ])
    }))
})
