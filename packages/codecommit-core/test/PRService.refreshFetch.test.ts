/** @effect-diagnostics strictEffectProvide:skip-file */

import * as AwsErrors from "@distilled.cloud/aws/Errors"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Option, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { ApprovalEvaluationError } from "../src/AwsClient/getPullRequests.js"
import { AwsClient } from "../src/AwsClient/index.js"
import { PullRequestDetail } from "../src/AwsClient/internal.js"
import { CacheError } from "../src/CacheService/CacheError.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { AccountConfig } from "../src/ConfigService/internal.js"
import {
  approvalUnknownReasonText,
  type AppState,
  type CallerIdentityState,
  type CallerIdentityUnresolvedReason,
  PullRequest
} from "../src/Domain.js"
import { AwsApiError, AwsCredentialError } from "../src/Errors.js"
import {
  applyIdentityEvent,
  IdentityEvent,
  type LookupFailureReason,
  signInState,
  startRefresh
} from "../src/IdentityLifecycle.js"
import { fetchAndUpsertPRs } from "../src/PRService/refreshFetch.js"
import { subscriptionKey } from "../src/PRService/refreshResolve.js"

const lookupReason = (reason: CallerIdentityUnresolvedReason): LookupFailureReason | undefined =>
  reason._tag === "CredentialsUnavailable" || reason._tag === "StsRejected" || reason._tag === "Throttled"
    ? reason
    : undefined

/**
 * State after a refresh at generation 1 resolved these identities, reached through the lifecycle's own
 * events. The first profile is the owner, so it decides `currentUser`.
 */
const seeded = (identities: Readonly<Record<string, CallerIdentityState>>): AppState => {
  const [generation, started] = startRefresh(
    { pullRequests: [], accounts: [], status: "loading" },
    Object.keys(identities)
  )
  return Object.entries(identities).reduce((state, [profile, identity]) => {
    if (identity._tag === "Resolved") {
      return applyIdentityEvent(state, IdentityEvent.LookupSucceeded({ generation, profile, identity }))
    }
    const reason = lookupReason(identity.reason)
    return reason === undefined
      ? state
      : applyIdentityEvent(state, IdentityEvent.LookupFailed({ generation, profile, reason }))
  }, started)
}

describe("fetchAndUpsertPRs", () => {
  it.effect("keeps an identity's earlier lookup failure when its refresh then fails authentication", () =>
    Effect.gen(function*() {
      const lookupFailed: CallerIdentityState = { _tag: "Unresolved", reason: { _tag: "CredentialsUnavailable" } }
      const state = yield* SubscriptionRef.make<AppState>(seeded({ "test-profile": lookupFailed }))
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () =>
            Stream.fail(
              new AwsCredentialError({ profile: account.profile, region: account.regions[0]!, cause: "expired" })
            )
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["test-profile"]).toEqual(lookupFailed)
    }))

  it.effect("does not let an older refresh's auth failure undo a login that landed meanwhile", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>(seeded({
        "test-profile": {
          _tag: "Resolved",
          accountId: "123456789012",
          arn: "arn:aws:sts::123456789012:assumed-role/R/bob",
          username: "bob"
        }
      }))
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
          getPullRequests: () =>
            Stream.fromEffect(SubscriptionRef.update(state, (s) => signInState(s, "test-profile", freshLogin))).pipe(
              Stream.flatMap(() =>
                Stream.fail(
                  new AwsCredentialError({ profile: account.profile, region: account.regions[0]!, cause: "expired" })
                )
              )
            )
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
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
        const state = yield* SubscriptionRef.make<AppState>(
          seeded({ alpha: identity("111111111111", "alice"), beta: identity("222222222222", "bob") })
        )
        const accounts = ["alpha", "beta"].map((profile) =>
          Schema.decodeSync(AccountConfig)({ profile, regions: ["us-east-1"], enabled: true })
        )
        const dependencies = Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequests: (account) =>
              account.profile === failing
                ? Stream.fail(
                  new AwsCredentialError({ profile: account.profile, region: account.region, cause: "expired" })
                )
                : Stream.empty
          }),
          Layer.mock(PullRequestRepo, {
            observe: () => Effect.succeed(1),
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
          identityGeneration: 1,
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
      const state = yield* SubscriptionRef.make<AppState>(seeded({ "test-profile": resolved }))
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          // Expired credentials fail the listing (the evaluation's typed cause is kept); a missing grant
          // only makes the approval unknown, and the pull request is listed.
          getPullRequests: () =>
            kind === "expired"
              ? Stream.fail(
                new AwsApiError({
                  operation: "getPullRequests",
                  profile: account.profile,
                  region: account.regions[0]!,
                  cause: new ApprovalEvaluationError({
                    pullRequestId: "36",
                    revisionId: "revision-36",
                    cause: new AwsErrors.ExpiredTokenException({
                      message: "The security token included in the request is expired"
                    })
                  })
                })
              )
              : Stream.make(
                Schema.decodeSync(PullRequest)({
                  ...Schema.encodeSync(PullRequest)(providerOpenPR),
                  id: "36",
                  approvalUnknown: { _tag: "NotPermitted" }
                })
              )
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void,
          upsert: () => Effect.succeed({ row: true, approval: true, replaced: Option.none() }),
          writeRead: () => Effect.succeed({ row: true, approval: true, versions: undefined })
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))
      expect((yield* SubscriptionRef.get(state)).callerIdentities?.["test-profile"])
        .toEqual(expected === "resolved" ? resolved : expected)
    }))

  it.effect.each([
    ["a credential failure", "credential"],
    ["an evaluation failure caused by expired credentials", "evaluation"]
  ])(
    "marks the identity RefreshAuthFailed when a stale-row re-read fails with %s",
    ([, kind]) =>
      Effect.gen(function*() {
        const resolved: CallerIdentityState = {
          _tag: "Resolved",
          accountId: "123456789012",
          arn: "arn:aws:sts::123456789012:assumed-role/R/alice",
          username: "alice"
        }
        const state = yield* SubscriptionRef.make<AppState>(seeded({ "test-profile": resolved }))
        const account = Schema.decodeSync(AccountConfig)({
          profile: "test-profile",
          regions: ["us-east-1"],
          enabled: true
        })
        const deleted = yield* Ref.make(0)
        const dependencies = Layer.mergeAll(
          Layer.mock(AwsClient, {
            // The listing succeeds; credentials then expire while a stale row is re-read.
            getPullRequests: () => Stream.empty,
            getPullRequest: () =>
              Effect.fail(
                kind === "credential"
                  ? new AwsCredentialError({ profile: account.profile, region: account.regions[0]!, cause: "expired" })
                  : new AwsApiError({
                    operation: "getPullRequest",
                    profile: account.profile,
                    region: account.regions[0]!,
                    cause: new ApprovalEvaluationError({
                      pullRequestId: staleOpenPR.id,
                      revisionId: "rev-1",
                      cause: new AwsErrors.ExpiredTokenException({ message: "expired" })
                    })
                  })
              )
          }),
          Layer.mock(PullRequestRepo, {
            observe: () => Effect.succeed(1),
            findStaleOpen: () => Effect.succeed([staleOpenPR]),
            deleteOne: () => Ref.update(deleted, (n) => n + 1),
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
          identityGeneration: 1,
          staleThreshold: "2026-08-03T00:00:00Z"
        }).pipe(Effect.provide(dependencies))
        const after = yield* SubscriptionRef.get(state)
        expect(after.callerIdentities?.["test-profile"]).toEqual({
          _tag: "Unresolved",
          reason: { _tag: "RefreshAuthFailed" }
        })
        expect(after.currentUser).toBeUndefined()
        // Expired credentials are no evidence the pull request is gone.
        expect(yield* Ref.get(deleted)).toBe(0)
      })
  )

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
      const state = yield* SubscriptionRef.make<AppState>(
        seeded({ "test-profile": resolved, "other-profile": resolved })
      )
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
        Layer.mock(AwsClient, { getPullRequests: () => Stream.fail(failure) }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
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

  it.effect("keeps a stale cached PR whose re-read finds it open with approval unknown, and records it", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const deleteCalls = yield* Ref.make(0)
      const marked = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          // No open pull requests, so the scope succeeds and stale reconciliation runs.
          getPullRequests: () => Stream.empty,
          getPullRequest: () =>
            Effect.succeed(new PullRequestDetail({ ...providerOpenDetail, approvalUnknown: { _tag: "NotPermitted" } }))
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          deleteOne: () => Ref.update(deleteCalls, (count) => count + 1),
          writeRead: (_, id, evaluation) =>
            Ref.update(
              marked,
              (all) => [...all, [id, evaluation.approvalUnknown?._tag ?? "Evaluated"]]
            ).pipe(Effect.as({ row: true, approval: true, versions: undefined })),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      // An unknown approval is not evidence the pull request is gone: it is still open, so its row stays,
      // marked unknown, listed as unevaluated, and its scope is partial.
      expect(yield* Ref.get(deleteCalls)).toBe(0)
      expect(yield* Ref.get(marked)).toEqual([[staleOpenPR.id, "NotPermitted"]])
      expect(successfulScopes).toEqual([])
      expect((yield* SubscriptionRef.get(state)).unevaluatedPullRequests?.map((u) => u.pullRequestId))
        .toEqual([staleOpenPR.id])
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
    approvalUnknownReason: null,
    observationSeq: 0,
    approvalVersion: "2026-08-02T00:00:00.000Z",
    approvalObservationSeq: 0,
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
    isMergeable: true,
    approvalRules: []
  })
  const providerClosedDetail = new PullRequestDetail({ ...providerOpenDetail, status: "CLOSED" })
  const openPR = (id: string) =>
    Schema.decodeSync(PullRequest)({ ...Schema.encodeSync(PullRequest)(providerOpenPR), id })
  const unknownPR = (id: string) =>
    Schema.decodeSync(PullRequest)({
      ...Schema.encodeSync(PullRequest)(providerOpenPR),
      id,
      approvalUnknown: { _tag: "NotPermitted" }
    })

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
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1)
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(SubscriptionRepo, {})
      )

      const exit = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        identityGeneration: 1,
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
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
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
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
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
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([])
    }))

  it.effect("withholds scope success when a stale row the provider says is gone cannot be removed", () =>
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
                cause: { _tag: "PullRequestDoesNotExistException", message: "pull request 7 does not exist" },
                operation: "getPullRequest",
                profile: account.profile,
                region: account.regions[0]!
              })
            )
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([])
    }))

  // A failed read is no evidence the pull request is gone: deleting it would leave a tombstone that
  // hides a live pull request from every later listing at its version.
  it.effect("keeps a stale row whose re-read fails for another reason, and withholds scope success", () =>
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
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(deleteCalls)).toBe(0)
      expect(successfulScopes).toEqual([])
    }))

  it.effect("deletes a stale row the provider says no longer exists, and withholds scope success", () =>
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
                cause: { _tag: "PullRequestDoesNotExistException", message: "pull request 7 does not exist" },
                operation: "getPullRequest",
                profile: account.profile,
                region: account.regions[0]!
              })
            )
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
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
          observe: () => Effect.succeed(1),
          writeRead: () => Effect.succeed({ row: true, approval: true, versions: undefined }),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(deleteCalls)).toBe(0)
      expect(successfulScopes).toEqual([
        { profile: "test-profile", region: "us-east-1", awsAccountId: "123456789012" }
      ])
    }))

  it.effect("keeps a stale row the provider confirmed when writing its evaluation to the cache fails", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const deletes = yield* Ref.make(0)
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
          observe: () => Effect.succeed(1),
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          writeRead: () =>
            Effect.fail(new CacheError({ operation: "recordApprovalEvaluation", cause: new Error("disk full") })),
          deleteOne: () => Ref.update(deletes, (n) => n + 1),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))
      // A failed cache write is no evidence the pull request is gone.
      expect(yield* Ref.get(deletes)).toBe(0)
      expect(successfulScopes).toEqual([])
    }))

  it.effect("writes a successful stale re-evaluation back, clearing an earlier unknown approval", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const recorded = yield* Ref.make<ReadonlyArray<unknown>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const unknownRow = Schema.decodeSync(CachedPullRequest)({
        ...Schema.encodeSync(CachedPullRequest)(staleOpenPR),
        approvalUnknownReason: "NotPermitted"
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.empty,
          getPullRequest: () => Effect.succeed(new PullRequestDetail({ ...providerOpenDetail, isApproved: true }))
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          findStaleOpen: () => Effect.succeed([unknownRow]),
          writeRead: (_, id, evaluation) =>
            Ref.update(recorded, (all) => [...all, [id, evaluation]]).pipe(
              Effect.as({ row: true, approval: true, versions: undefined })
            ),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))
      expect((yield* Ref.get(recorded)).map(([id, read]) => [id, read.approvalUnknown, read.isApproved])).toEqual([
        [staleOpenPR.id, undefined, true]
      ])
      // Evaluated, so nothing is unknown and the scope is not partial.
      expect(successfulScopes).toEqual([{ profile: "test-profile", region: "us-east-1", awsAccountId: "123456789012" }])
    }))

  it.effect("sends no pool notification while approval stays unknown across refreshes", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const notified = yield* Ref.make<ReadonlyArray<string>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const pool = (members: ReadonlyArray<string>) => [{
        ruleName: "reviewers",
        requiredApprovals: 1,
        poolMembers: members,
        poolMemberArns: [],
        satisfied: false
      }]
      // The cache keeps its last known rules (alice not in the pool); the fresh rules add alice.
      const cachedRow = Schema.decodeSync(CachedPullRequest)({
        ...Schema.encodeSync(CachedPullRequest)(staleOpenPR),
        id: "36",
        approvalRules: JSON.stringify(pool([]))
      })
      const fresh = Schema.decodeSync(PullRequest)({
        ...Schema.encodeSync(PullRequest)(unknownPR("36")),
        approvalRules: pool(["alice"])
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, { getPullRequests: () => Stream.make(fresh) }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          findByCoordinates: () => Effect.succeed(Option.some(cachedRow)),
          upsert: () => Effect.succeed({ row: true, approval: true, replaced: Option.some(cachedRow) }),
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {
          add: (n) => Ref.update(notified, (all) => [...all, n.type]),
          addSystem: () => Effect.void
        }),
        Layer.mock(SubscriptionRepo, { subscribe: () => Effect.void })
      )
      const refresh = Effect.gen(function*() {
        return yield* fetchAndUpsertPRs({
          state,
          enabledAccounts: [account],
          accountIdMap: new Map([["test-profile", "123456789012"]]),
          subscribedRef: yield* Ref.make(
            new Set([subscriptionKey("123456789012", "36", "example-repository", "us-east-1")])
          ),
          currentUser: "alice",
          identityGeneration: 1,
          staleThreshold: "2026-08-03T00:00:00Z"
        }).pipe(Effect.provide(dependencies))
      })
      yield* refresh
      yield* refresh
      expect((yield* Ref.get(notified)).filter((type) => type === "approval_requested")).toEqual([])
    }))

  it.effect("still reconciles an unrelated closed row when another pull request's approval is unknown", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const statusUpdates = yield* Ref.make(0)
      const detailReads = yield* Ref.make<ReadonlyArray<string>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.make(unknownPR("36")),
          getPullRequest: ({ pullRequestId }) =>
            Ref.update(detailReads, (ids) => [...ids, pullRequestId]).pipe(Effect.as(providerClosedDetail))
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          upsert: () => Effect.succeed({ row: true, approval: true, replaced: Option.none() }),
          // PR 35 closed at the provider; PR 36 was just listed, so it is not stale.
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          // A closed or merged re-read now arrives as a whole-row write.
          writeRead: (_, __, read) =>
            Ref.update(statusUpdates, (count) => read.status === "OPEN" ? count : count + 1).pipe(
              Effect.as({ row: true, approval: true, versions: undefined })
            ),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      // The listing completed, so the unrelated closed row reconciles.
      expect(yield* Ref.get(detailReads)).toEqual([staleOpenPR.id])
      expect(yield* Ref.get(statusUpdates)).toBe(1)
      // Still partial: one pull request's approval is unknown.
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
          getPullRequests: () => Stream.empty,
          getPullRequest: () => Effect.succeed(providerClosedDetail)
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          // A closed or merged re-read now arrives as a whole-row write.
          writeRead: (_, __, read) =>
            Ref.update(statusUpdates, (count) => read.status === "OPEN" ? count : count + 1).pipe(
              Effect.as({ row: true, approval: true, versions: undefined })
            ),
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
        identityGeneration: 1,
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
          observe: () => Effect.succeed(1),
          findStaleOpen: () => Effect.succeed([staleOpenPR]),
          // A closed or merged re-read now arrives as a whole-row write.
          writeRead: (_, __, read) =>
            Ref.update(statusUpdates, (count) => read.status === "OPEN" ? count : count + 1).pipe(
              Effect.as({ row: true, approval: true, versions: undefined })
            ),
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
        identityGeneration: 1,
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
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
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
          observe: () => Effect.succeed(1),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(successfulScopes).toEqual([])
    }))

  it.effect("lists a pull request whose approval is unknown, and reports the account as partial", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const upserted = yield* Ref.make<ReadonlyArray<readonly [string, string | null]>>([])
      const notifications = yield* Ref.make<ReadonlyArray<string>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.make(openPR("35"), unknownPR("36"), openPR("37"))
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          upsert: (input) =>
            Ref.update(upserted, (rows) => [...rows, [input.id, input.approvalUnknownReason]]).pipe(
              Effect.as({ row: true, approval: true })
            ),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      // All three are upserted; the unknown one carries its reason, so the cache keeps its last known approval.
      expect(yield* Ref.get(upserted)).toEqual([["35", null], ["36", "NotPermitted"], ["37", null]])
      // Partial, not successful.
      expect(successfulScopes).toEqual([])
      const { unevaluatedPullRequests } = yield* SubscriptionRef.get(state)
      expect(unevaluatedPullRequests).toEqual([{
        profile: "test-profile",
        region: "us-east-1",
        pullRequestId: "36",
        repositoryName: "example-repository",
        message: approvalUnknownReasonText({ _tag: "NotPermitted" })
      }])
      expect(yield* Ref.get(notifications)).toEqual([
        expect.stringMatching(/^1 pull request in us-east-1 couldn't be re-evaluated, so their approval is unknown/)
      ])
    }))

  // A rejected write is an older read than the cached row: nothing it saw is current, so it marks
  // nothing unevaluated, makes no scope partial, and subscribes no one.
  it.effect("ignores an unknown approval, and subscribes no one, from a listing the cache rejected as older", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribed = yield* Ref.make(0)
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: () => Stream.make(unknownPR("36"))
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          upsert: () => Effect.succeed({ row: false, approval: false, replaced: Option.none() }),
          findStaleOpen: () => Effect.succeed([]),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
        Layer.mock(SubscriptionRepo, { subscribe: () => Ref.update(subscribed, (n) => n + 1) })
      )

      const successfulScopes = yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef: yield* Ref.make(new Set<string>()),
        // The listed pull request's author, so an applied write would auto-subscribe.
        currentUser: unknownPR("36").author,
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect((yield* SubscriptionRef.get(state)).unevaluatedPullRequests).toEqual([])
      expect(successfulScopes).toHaveLength(1)
      expect(yield* Ref.get(subscribed)).toBe(0)
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
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getPullRequests: ({ region }) => Stream.make(unknownPR(region === "us-east-1" ? "40" : "41"))
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          upsert: () => Effect.succeed({ row: true, approval: true, replaced: Option.none() }),
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
        identityGeneration: 1,
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
          getPullRequests: () => Stream.make(providerOpenPR)
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          upsert: (input) =>
            Ref.set(upsertedRepoAccountId, input.repoAccountId).pipe(Effect.as({ row: true, approval: true })),
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
        identityGeneration: 1,
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
        Layer.mock(AwsClient, { getPullRequests: () => Stream.make(providerOpenPR) }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          findByAccountAndId: () => Effect.succeed(Option.some(staleOpenPR)),
          findByCoordinates: () => Effect.succeed(Option.some(staleOpenPR)),
          findStaleOpen: () => Effect.succeed([]),
          upsert: () => Effect.succeed({ row: true, approval: true, replaced: Option.some(staleOpenPR) }),
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
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect(yield* Ref.get(notificationCalls)).toBeGreaterThan(0)
    }))

  // A listing older than the cached row changes nothing in the cache, so it must announce nothing:
  const notificationCases: ReadonlyArray<readonly [string, boolean, number]> = [
    ["accepted", true, 1],
    ["rejected as older than the cached row", false, 0]
  ]
  // the diff against the cached row describes a change that didn't happen.
  it.effect.each(notificationCases)(
    "sends a subscribed pull request's notifications only when its upsert is %s",
    ([, applied, expected]) =>
      Effect.gen(function*() {
        const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
        const subscribedRef = yield* Ref.make(new Set([subscriptionKey("123456789012", "35")]))
        const added = yield* Ref.make<ReadonlyArray<string>>([])
        const account = Schema.decodeSync(AccountConfig)({
          profile: "test-profile",
          regions: ["us-east-1"],
          enabled: true
        })
        // The cached row is pending under a rule; the listing reads it approved.
        const cachedPending = Schema.decodeSync(CachedPullRequest)({
          ...Schema.encodeSync(CachedPullRequest)(staleOpenPR),
          isApproved: 0,
          approvalRules: JSON.stringify([{
            ruleName: "r",
            requiredApprovals: 1,
            poolMembers: [],
            poolMemberArns: [],
            satisfied: false
          }])
        })
        const listedApproved = Schema.decodeSync(PullRequest)({
          ...Schema.encodeSync(PullRequest)(providerOpenPR),
          isApproved: true,
          approvalRules: [{ ruleName: "r", requiredApprovals: 1, poolMembers: [], poolMemberArns: [], satisfied: true }]
        })
        const dependencies = Layer.mergeAll(
          Layer.mock(AwsClient, { getPullRequests: () => Stream.make(listedApproved) }),
          Layer.mock(PullRequestRepo, {
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.some(cachedPending)),
            findByCoordinates: () => Effect.succeed(Option.some(cachedPending)),
            findStaleOpen: () => Effect.succeed([]),
            upsert: () => Effect.succeed({ row: applied, approval: applied, replaced: Option.some(cachedPending) }),
            propagateRepoAccountId: () => Effect.void
          }),
          Layer.mock(NotificationRepo, {
            add: (n) => Ref.update(added, (all) => [...all, n.type])
          }),
          Layer.mock(SubscriptionRepo, {})
        )

        yield* fetchAndUpsertPRs({
          state,
          enabledAccounts: [account],
          accountIdMap: new Map([["test-profile", "123456789012"]]),
          subscribedRef,
          currentUser: undefined,
          identityGeneration: 1,
          staleThreshold: "2026-08-03T00:00:00Z"
        }).pipe(Effect.provide(dependencies))

        expect((yield* Ref.get(added)).filter((type) => type === "approval_changed")).toHaveLength(expected)
      })
  )

  // A write that landed between an earlier snapshot and this write changed the row: the transition
  // this read announces is from the value it actually replaced, not from the snapshot.
  it.effect("announces the transition from the row its write replaced, not from an earlier snapshot", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
      const subscribedRef = yield* Ref.make(new Set([subscriptionKey("123456789012", "35")]))
      const added = yield* Ref.make<ReadonlyArray<string>>([])
      const account = Schema.decodeSync(AccountConfig)({
        profile: "test-profile",
        regions: ["us-east-1"],
        enabled: true
      })
      const rules = (satisfied: boolean) => [
        { ruleName: "r", requiredApprovals: 1, poolMembers: [], poolMemberArns: [], satisfied }
      ]
      const cachedRow = (isApproved: 0 | 1) =>
        Schema.decodeSync(CachedPullRequest)({
          ...Schema.encodeSync(CachedPullRequest)(staleOpenPR),
          isApproved,
          approvalRules: JSON.stringify(rules(isApproved === 1))
        })
      const listedPending = Schema.decodeSync(PullRequest)({
        ...Schema.encodeSync(PullRequest)(providerOpenPR),
        isApproved: false,
        approvalRules: rules(false)
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, { getPullRequests: () => Stream.make(listedPending) }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          // The earlier snapshot: pending, as this read also sees it.
          findByAccountAndId: () => Effect.succeed(Option.some(cachedRow(0))),
          findByCoordinates: () => Effect.succeed(Option.some(cachedRow(0))),
          findStaleOpen: () => Effect.succeed([]),
          // Meanwhile another read stored it approved; this write replaced that.
          upsert: () =>
            Effect.succeed({ row: true, approval: true, versions: undefined, replaced: Option.some(cachedRow(1)) }),
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(NotificationRepo, { add: (n) => Ref.update(added, (all) => [...all, n.message]) }),
        Layer.mock(SubscriptionRepo, {})
      )

      yield* fetchAndUpsertPRs({
        state,
        enabledAccounts: [account],
        accountIdMap: new Map([["test-profile", "123456789012"]]),
        subscribedRef,
        currentUser: undefined,
        identityGeneration: 1,
        staleThreshold: "2026-08-03T00:00:00Z"
      }).pipe(Effect.provide(dependencies))

      expect((yield* Ref.get(added)).filter((message) => message.startsWith("Approval"))).toEqual([
        expect.stringMatching(/^Approval revoked on #35/)
      ])
    }))
})
