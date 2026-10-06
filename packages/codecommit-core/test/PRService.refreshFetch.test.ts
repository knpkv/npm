/** @effect-diagnostics strictEffectProvide:skip-file */

import * as AwsErrors from "@distilled.cloud/aws/Errors"
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
import { type AppState, type CallerIdentityState, PullRequest, signInState } from "../src/Domain.js"
import { AwsApiError, AwsCredentialError } from "../src/Errors.js"
import { fetchAndUpsertPRs } from "../src/PRService/refreshFetch.js"
import { subscriptionKey } from "../src/PRService/refreshResolve.js"

/** A provider pull request as the refresh stream delivers it. */
const fetched = (pullRequest: PullRequest): PullRequestRefreshItem => ({ _tag: "Fetched", pullRequest })

describe("fetchAndUpsertPRs", () => {
  it.effect("keeps an identity's earlier lookup failure when its refresh then fails authentication", () =>
    Effect.gen(function*() {
      const lookupFailed: CallerIdentityState = { _tag: "Unresolved", reason: { _tag: "CredentialsUnavailable" } }
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "loading",
        callerIdentities: { "test-profile": lookupFailed }
      })
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequestRefresh: () =>
            Stream.fail(
              new AwsCredentialError({ profile: account.profile, region: account.regions[0]!, cause: "expired" })
            )
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
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["test-profile"]).toEqual(lookupFailed)
    }))

  it.effect("does not let an older refresh's auth failure undo a login that landed meanwhile", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const freshLogin = {
        accountId: "123456789012",
        arn: "arn:aws:sts::123456789012:assumed-role/R/alice",
        username: "alice"
      }
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          // The login lands while this refresh is in flight, then the refresh's old session fails.
          getPullRequestRefresh: () =>
            Stream.fromEffect(SubscriptionRef.update(state, (s) => signInState(s, "test-profile", freshLogin))).pipe(
              Stream.flatMap(() =>
                Stream.fail(
                  new AwsCredentialError({ profile: account.profile, region: account.regions[0]!, cause: "expired" })
                )
              )
            )
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
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))
      const after = yield* SubscriptionRef.get(state)
      expect(after.currentUser).toBe("alice")
      expect(after.callerIdentities?.["test-profile"]).toEqual({ _tag: "Resolved", ...freshLogin })
    }))

  it.effect.each([
    ["another account's", "beta", "alice"],
    ["the current-user account's own", "alpha", undefined]
  ])(
    "clears currentUser on %s auth failure only when that account owns it",
    ([, failing, expectedUser]) =>
      Effect.gen(function*() {
        const identity = (accountId: string, name: string): CallerIdentityState => ({
          _tag: "Resolved",
          accountId,
          arn: `arn:aws:sts::${accountId}:assumed-role/R/${name}`,
          username: name
        })
        const state = yield* SubscriptionRef.make<AppState>({
          pullRequests: [],
          accounts: [],
          status: "loading",
          currentUser: "alice",
          callerIdentities: { alpha: identity("111111111111", "alice"), beta: identity("222222222222", "bob") }
        })
        const accounts = ["alpha", "beta"].map((profile) =>
          Schema.decodeSync(AccountConfig)({ profile, regions: ["us-east-1"], enabled: true })
        )
        const dependencies = Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequestRefresh: (account) =>
              account.profile === failing
                ? Stream.fail(
                  new AwsCredentialError({ profile: account.profile, region: account.region, cause: "expired" })
                )
                : Stream.empty
          }),
          Layer.mock(PullRequestRepo, {
            findStaleOpen: () => Effect.succeed([]),
            propagateRepoAccountId: () => Effect.void,
            upsertMany: () => Effect.void
          }),
          Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
          Layer.mock(SubscriptionRepo, {})
        )
        yield* fetchAndUpsertPRs({
          state,
          enabledAccounts: accounts,
          accountIdMap: new Map([["alpha", "111111111111"], ["beta", "222222222222"]]),
          subscribedRef: yield* Ref.make(new Set<string>()),
          currentUser: "alice",
          staleThreshold: "2026-08-03T00:00:00Z"
        }).pipe(Effect.provide(dependencies))
        const after = yield* SubscriptionRef.get(state)
        expect(after.currentUser).toBe(expectedUser)
        expect(after.callerIdentities?.[failing]).toEqual({ _tag: "Unresolved", reason: { _tag: "RefreshAuthFailed" } })
      })
  )

  it.effect.each([
    ["expired credentials", "expired", { _tag: "Unresolved", reason: { _tag: "RefreshAuthFailed" } }],
    ["a missing grant", "denied", "resolved"]
  ])("handles an approval evaluation that fails with %s", ([, kind, expected]) =>
    Effect.gen(function*() {
      const resolved: CallerIdentityState = {
        _tag: "Resolved",
        accountId: "123456789012",
        arn: "arn:aws:sts::123456789012:assumed-role/R/alice",
        username: "alice"
      }
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "loading",
        currentUser: "alice",
        callerIdentities: { "test-profile": resolved }
      })
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequestRefresh: () =>
            Stream.make({
              _tag: "EvaluationFailed",
              pullRequestId: "36",
              repositoryName: "example-repository",
              error: new ApprovalEvaluationError({
                pullRequestId: "36",
                revisionId: "revision-36",
                cause: kind === "expired"
                  ? new AwsErrors.ExpiredTokenException({
                    message: "The security token included in the request is expired"
                  })
                  : new AwsErrors.AccessDeniedException({ message: "not authorized" })
              })
            })
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
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: "alice",
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["test-profile"])
        .toEqual(expected === "resolved" ? resolved : expected)
    }))

  // Production refresh failures are typed: an expired credential, or a provider auth error wrapped in AwsApiError.
  it.effect.each([
    ["an AwsCredentialError", "credential"],
    ["an AwsApiError carrying ExpiredTokenException", "expired"],
    ["an AwsApiError carrying an unknown wire ExpiredTokenException", "unknown-expired"],
    ["an AwsApiError carrying AccessDeniedException (authorization, not authentication)", "denied"],
    ["an AwsApiError carrying OptInRequired (service opt-in, credentials fine)", "opt-in"],
    ["an AwsApiError carrying NotAuthorized (a missing grant, credentials fine)", "not-authorized"],
    ["an AwsApiError carrying an unrelated provider error", "unrelated"]
  ])("handles a refresh that fails with %s", ([, kind]) =>
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
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const failure = kind === "credential"
        ? new AwsCredentialError({
          profile: account.profile,
          region: account.regions[0]!,
          cause: "sso session expired"
        })
        : new AwsApiError({
          operation: "getPullRequests",
          profile: account.profile,
          region: account.regions[0]!,
          cause: kind === "expired"
            ? new AwsErrors.ExpiredTokenException({ message: "The security token included in the request is expired" })
            : kind === "denied"
            ? new AwsErrors.AccessDeniedException({ message: "not authorized to perform codecommit:ListPullRequests" })
            : kind === "unknown-expired"
            ? new AwsErrors.UnknownAwsError({
              errorTag: "ExpiredTokenException",
              errorData: undefined,
              message: "The security token is expired"
            })
            : kind === "opt-in"
            ? new AwsErrors.OptInRequired({ message: "subscription required" })
            : kind === "not-authorized"
            ? new AwsErrors.NotAuthorized({ message: "not authorized" })
            : { _tag: "InternalFailure", message: "provider error" }
        })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, { getPullRequestRefresh: () => Stream.fail(failure) }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
        Layer.mock(SubscriptionRepo, {})
      )

      yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: "alice",
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      const { callerIdentities } = yield* SubscriptionRef.get(state)
      expect(callerIdentities?.["other-profile"]).toEqual(resolved)
      expect(callerIdentities?.["test-profile"]).toEqual(
        ["unrelated", "denied", "opt-in", "not-authorized"].includes(kind ?? "")
          ? resolved
          : { _tag: "Unresolved", reason: { _tag: "RefreshAuthFailed" } }
      )
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
      const { unevaluatedPullRequests } = yield* SubscriptionRef.get(state)
      expect(unevaluatedPullRequests?.map(({ pullRequestId }) => pullRequestId)).toEqual([staleOpenPR.id])
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

  it.effect("still reconciles an unrelated closed row when another pull request fails evaluation", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const statusUpdates = yield* Ref.make(0)
      const detailReads = yield* Ref.make<ReadonlyArray<string>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      // PR 36 is listed open but fails evaluation, and its cached row is stale too.
      const failedRow = Schema.decodeSync(CachedPullRequest)({
        ...Schema.encodeSync(CachedPullRequest)(staleOpenPR),
        id: "36"
      })
      const failed: PullRequestRefreshItem = {
        _tag: "EvaluationFailed",
        pullRequestId: "36",
        repositoryName: failedRow.repositoryName,
        error: new ApprovalEvaluationError({
          pullRequestId: "36",
          revisionId: "revision-36",
          cause: new Error("denied")
        })
      }
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequestRefresh: () => Stream.make(failed),
          getPullRequest: ({ pullRequestId }) =>
            Ref.update(detailReads, (ids) => [...ids, pullRequestId]).pipe(Effect.as(providerClosedDetail))
        }),
        Layer.mock(PullRequestRepo, {
          // PR 35 closed at the provider; PR 36 is the one that failed evaluation.
          findStaleOpen: () => Effect.succeed([staleOpenPR, failedRow]),
          updateStatusAndClosedAt: () => Ref.update(statusUpdates, (count) => count + 1),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
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

      // The listing completed, so the unrelated closed row reconciles; the listed-open PR 36 is not re-read.
      expect(yield* Ref.get(detailReads)).toEqual([staleOpenPR.id])
      expect(yield* Ref.get(statusUpdates)).toBe(1)
      // Still partial: one pull request could not be re-evaluated.
      expect(successfulScopes).toEqual([])
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
      expect(yield* Ref.get(notifications)).toEqual([
        expect.stringMatching(/^1 pull request in us-east-1 couldn't be re-evaluated/)
      ])
    }))

  it.effect("sends one notification per profile, naming every region with unevaluated pull requests", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const notifications = yield* Ref.make<ReadonlyArray<{ readonly title: string; readonly message: string }>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1", "eu-west-1"],
        enabled: true
      })
      const failedIn = (id: string): PullRequestRefreshItem => ({
        _tag: "EvaluationFailed",
        pullRequestId: id,
        repositoryName: "example-repository",
        error: new ApprovalEvaluationError({
          pullRequestId: id,
          revisionId: `revision-${id}`,
          cause: new Error("denied")
        })
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequestRefresh: ({ region }) => Stream.make(failedIn(region === "us-east-1" ? "40" : "41"))
        }),
        Layer.mock(PullRequestRepo, {
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {
          addSystem: (notification) =>
            Ref.update(notifications, (all) => [...all, { title: notification.title, message: notification.message }])
        }),
        Layer.mock(SubscriptionRepo, {})
      )

      yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        currentUser: undefined,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      const sent = yield* Ref.get(notifications)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.title).toBe("test-profile: approval evaluation")
      expect(sent[0]?.message).toMatch(
        /^2 pull requests in (us-east-1, eu-west-1|eu-west-1, us-east-1) couldn't be re-evaluated/
      )
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
