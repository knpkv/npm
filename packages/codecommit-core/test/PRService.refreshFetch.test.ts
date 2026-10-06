/** @effect-diagnostics strictEffectProvide:skip-file */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { ApprovalEvaluationError } from "../src/AwsClient/getPullRequests.js"
import { AwsClient, type PullRequestRefreshItem } from "../src/AwsClient/index.js"
import { PullRequestDetail } from "../src/AwsClient/internal.js"
import { CacheError } from "../src/CacheService/CacheError.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { AccountConfig } from "../src/ConfigService/internal.js"
import { type AppState, type CallerIdentityState, PullRequest } from "../src/Domain.js"
import { AwsApiError } from "../src/Errors.js"
import { fetchAndUpsertPRs } from "../src/PRService/refreshFetch.js"
import { subscriptionKey } from "../src/PRService/refreshResolve.js"

/** A provider pull request as the refresh stream delivers it. */
const fetched = (pullRequest: PullRequest): PullRequestRefreshItem => ({ _tag: "Fetched", pullRequest })

describe("fetchAndUpsertPRs", () => {
  it.effect("marks the account's caller identity unresolved when its refresh fails authentication", () =>
    Effect.gen(function*() {
      const resolved: CallerIdentityState = {
        _tag: "Resolved",
        accountId: "123456789012",
        arn: "arn:aws:sts::123456789012:assumed-role/Reviewers/alice",
        username: "alice"
      }
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "loading",
        currentUser: "alice",
        callerIdentities: { "test-profile": resolved, "other-profile": resolved }
      })
      const expiredAccount = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequestRefresh: () => Stream.fail(new Error("ExpiredTokenException: the security token has expired"))
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
        Layer.mock(SubscriptionRepo, {})
      )

      yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [expiredAccount],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: "alice",
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      const { callerIdentities, currentUser } = yield* SubscriptionRef.get(state)
      expect(currentUser).toBeUndefined()
      expect(callerIdentities).toEqual({
        "test-profile": { _tag: "Unresolved", reason: { _tag: "RefreshAuthFailed" } },
        "other-profile": resolved
      })
    }))

  it.effect("keeps a stale cached PR when its re-read fails only on approval evaluation", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const deleteCalls = yield* Ref.make(0)
      const notifications = yield* Ref.make<Array<{ readonly type: string; readonly message: string }>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          // No open pull requests, so the scope succeeds and stale reconciliation runs.
          getPullRequestRefresh: () => Stream.empty,
          getPullRequest: () =>
            Effect.fail(
              new AwsApiError({
                operation: "getPullRequest",
                profile: account.profile,
                region: account.regions[0]!,
                cause: new ApprovalEvaluationError({
                  pullRequestId: staleOpenPR.id,
                  revisionId: "rev-1",
                  cause: new Error("not authorized to perform codecommit:EvaluatePullRequestApprovalRules")
                })
              })
            )
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          deleteOne: () => Ref.update(deleteCalls, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {
          addSystem: (notification) =>
            Ref.update(notifications, (all) => [...all, { type: notification.type, message: notification.message }])
        }),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      // An enrichment failure is not evidence the pull request is gone.
      expect(yield* Ref.get(deleteCalls)).toBe(0)
      expect(successfulScopes).toEqual([])
      // Kept, but not silently: the account says why its queue is stale.
      expect(yield* Ref.get(notifications)).toEqual([
        { type: "error", message: expect.stringContaining("EvaluatePullRequestApprovalRules") }
      ])
    }))

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
          getPullRequestRefresh: () => Stream.fromEffect(Effect.failCause(interruption))
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
          getPullRequestRefresh: ({ profile }) =>
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
          getPullRequestRefresh: () => Stream.empty,
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
          getPullRequestRefresh: () => Stream.empty
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
          getPullRequestRefresh: () => Stream.empty,
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
          getPullRequestRefresh: () => Stream.empty,
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
          getPullRequestRefresh: () => Stream.empty,
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
          getPullRequestRefresh: () => Stream.empty,
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
          getPullRequestRefresh: () => Stream.empty,
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
          getPullRequestRefresh: () => Stream.make(fetched(providerOpenPR)),
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
          getPullRequestRefresh: () => Stream.make(fetched(providerOpenPR))
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

  it.effect("refreshes the other pull requests when one fails approval evaluation, and reports the account as partial", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const upserted = yield* Ref.make<ReadonlyArray<string>>([])
      const notifications = yield* Ref.make<ReadonlyArray<string>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const openPR = (id: string) =>
        Schema.decodeSync(PullRequest)({ ...Schema.encodeSync(PullRequest)(providerOpenPR), id })
      const evaluationFailed: PullRequestRefreshItem = {
        _tag: "EvaluationFailed",
        pullRequestId: "36",
        repositoryName: "example-repository",
        error: new ApprovalEvaluationError({
          pullRequestId: "36",
          revisionId: "revision-36",
          cause: new Error("not authorized to perform codecommit:EvaluatePullRequestApprovalRules")
        })
      }
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequestRefresh: () => Stream.make(fetched(openPR("35")), evaluationFailed, fetched(openPR("37")))
        }),
        Layer.mock(PullRequestRepo, {
          upsert: (input) => Ref.update(upserted, (ids) => [...ids, input.id]),
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {
          addSystem: (notification) => Ref.update(notifications, (all) => [...all, notification.message])
        }),
        Layer.mock(SubscriptionRepo, {})
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      // The other two refreshed; the failed one kept its cached row (no upsert).
      expect(yield* Ref.get(upserted)).toEqual(["35", "37"])
      // Partial, not successful.
      expect(successfulScopes).toEqual([])
      const { unevaluatedPullRequests } = yield* SubscriptionRef.get(state)
      expect(unevaluatedPullRequests).toEqual([{
        profile: "test-profile",
        region: "us-east-1",
        pullRequestId: "36",
        repositoryName: "example-repository",
        message: expect.stringContaining("EvaluatePullRequestApprovalRules")
      }])
      expect(yield* Ref.get(notifications)).toEqual([expect.stringMatching(/^1 pull request couldn't be re-evaluated/)])
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
          getPullRequestRefresh: () => Stream.make(fetched(providerOpenPR))
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

  it.effect("diffs a uniquely attributable legacy subscription during bulk refresh", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set([subscriptionKey("123456789012", "35")]))
      const notificationCalls = yield* Ref.make(0)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, { getPullRequestRefresh: () => Stream.make(fetched(providerOpenPR)) }),
        Layer.mock(PullRequestRepo, {
          findByAccountAndId: () => Effect.succeed(Option.some(staleOpenPR)),
          findByCoordinates: () => Effect.succeed(Option.some(staleOpenPR)),
          findStaleOpen: () => Effect.succeed([]),
          upsert: () => Effect.void,
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {
          add: () => Ref.update(notificationCalls, (count) => count + 1)
        }),
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

      expect(yield* Ref.get(notificationCalls)).toBeGreaterThan(0)
    }))
})
