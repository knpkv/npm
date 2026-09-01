import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { EventsHub } from "../src/CacheService/EventsHub.js"
import { CommentRepo } from "../src/CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { Domain } from "../src/index.js"
import { makeRefreshSinglePR } from "../src/PRService/refreshSinglePR.js"

const pullRequest = Schema.decodeSync(Domain.PullRequest)({
  id: "42",
  title: "Coordinate refresh",
  author: "reviewer",
  repositoryName: "payments",
  creationDate: new Date(0),
  lastModifiedDate: new Date(1_000),
  link: "https://example.invalid/pr/42",
  account: {
    awsAccountId: "111122223333",
    profile: "production",
    region: "eu-west-1",
    repoAccountId: "111122223333"
  },
  status: "OPEN",
  sourceBranch: "feature",
  destinationBranch: "main",
  isMergeable: true,
  isApproved: false,
  approvedBy: [],
  commentedBy: [],
  approvalRules: []
})

const cachedPullRequest = Schema.decodeSync(CachedPullRequest)({
  id: "42",
  awsAccountId: "111122223333",
  repoAccountId: "111122223333",
  accountProfile: "production",
  accountRegion: "eu-west-1",
  title: "Coordinate refresh",
  description: null,
  author: "reviewer",
  repositoryName: "payments",
  creationDate: new Date(0).toISOString(),
  lastModifiedDate: new Date(1_000).toISOString(),
  status: "OPEN",
  sourceBranch: "feature",
  destinationBranch: "main",
  isMergeable: 1,
  isApproved: 0,
  commentCount: 0,
  healthScore: null,
  link: "https://example.invalid/pr/42",
  fetchedAt: new Date(1_000).toISOString(),
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  closedAt: null,
  mergedBy: null,
  approvedBy: null,
  approvedByArns: null,
  commentedBy: null,
  approvalRules: null
})

const secondPullRequest = Schema.decodeSync(Domain.PullRequest)({
  ...pullRequest,
  account: { ...pullRequest.account, region: "us-east-1" },
  repositoryName: "identity"
})
const secondCachedPullRequest = Schema.encodeSync(CachedPullRequest)({
  ...cachedPullRequest,
  accountRegion: "us-east-1",
  repositoryName: "identity"
})

const config = {
  accounts: [],
  autoDetect: false,
  autoRefresh: false,
  refreshIntervalSeconds: 300,
  review: ConfigService.defaultReviewConfig,
  sandbox: ConfigService.defaultSandboxConfig
}

const runWithLayer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  layer: Layer.Layer<R, never, never>
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.gen(function*() {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provideContext(context))
    })
  )

describe("PRService.refreshSinglePR coordinates", () => {
  it.effect("uses the selected repository and region for the provider refresh", () =>
    Effect.gen(function*() {
      const initialState: Domain.AppState = { pullRequests: [pullRequest], accounts: [], status: "idle" }
      const state = yield* SubscriptionRef.make(initialState)
      const providerCalls = yield* Ref.make<
        ReadonlyArray<{ readonly repositoryName: string; readonly region: string }>
      >([])
      const service = makeRefreshSinglePR(state)
      const result = yield* runWithLayer(
        service("111122223333", pullRequest.id, {
          region: "eu-west-1",
          repositoryName: "payments"
        }),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: ({ account }) =>
              Ref.update(providerCalls, (calls) => [...calls, { region: account.region, repositoryName: "payments" }])
                .pipe(
                  Effect.andThen(Effect.succeed({
                    revisionId: "revision-2",
                    sourceCommit: "b".repeat(40),
                    title: "Coordinate refresh",
                    author: "reviewer",
                    status: "OPEN",
                    repositoryName: "payments",
                    sourceBranch: "feature",
                    destinationBranch: "main",
                    creationDate: new Date(0),
                    lastActivityDate: new Date(2_000),
                    approvedBy: [],
                    approvedByArns: [],
                    approvalRules: []
                  }))
                ),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(PullRequestRepo, {
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest]),
            upsert: () => Effect.void
          }),
          Layer.mock(CommentRepo, { upsert: () => Effect.void }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(result).toEqual({ revisionId: "revision-2", sourceCommit: "b".repeat(40) })
      expect(yield* Ref.get(providerCalls)).toEqual([{ region: "eu-west-1", repositoryName: "payments" }])
    }))

  it.effect("rejects a same-id refresh with a different provider region", () =>
    Effect.gen(function*() {
      const initialState: Domain.AppState = { pullRequests: [pullRequest], accounts: [], status: "idle" }
      const state = yield* SubscriptionRef.make(initialState)
      const providerCalls = yield* Ref.make(0)
      const service = makeRefreshSinglePR(state)
      const failure = yield* runWithLayer(
        service("111122223333", pullRequest.id, {
          region: "us-east-1",
          repositoryName: "payments"
        }).pipe(Effect.flip),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: () =>
              Ref.update(providerCalls, (calls) => calls + 1).pipe(
                Effect.andThen(Effect.die("unexpected provider call"))
              ),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(PullRequestRepo, {
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest])
          }),
          Layer.mock(CommentRepo, {}),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, {}),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(failure._tag).toBe("RefreshError")
      expect(failure.failedAccounts).toEqual(["111122223333"])
      expect(yield* Ref.get(providerCalls)).toBe(0)
    }))

  it.effect("rejects a same-id refresh with a different repository", () =>
    Effect.gen(function*() {
      const initialState: Domain.AppState = { pullRequests: [pullRequest], accounts: [], status: "idle" }
      const state = yield* SubscriptionRef.make(initialState)
      const providerCalls = yield* Ref.make(0)
      const service = makeRefreshSinglePR(state)
      const failure = yield* runWithLayer(
        service("111122223333", pullRequest.id, {
          region: "eu-west-1",
          repositoryName: "other-repository"
        }).pipe(Effect.flip),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: () =>
              Ref.update(providerCalls, (calls) => calls + 1).pipe(
                Effect.andThen(Effect.die("unexpected provider call"))
              ),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(PullRequestRepo, {
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest])
          }),
          Layer.mock(CommentRepo, {}),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, {}),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(failure._tag).toBe("RefreshError")
      expect(yield* Ref.get(providerCalls)).toBe(0)
    }))

  it.effect("keeps a unique legacy route refresh working without coordinates", () =>
    Effect.gen(function*() {
      const initialState: Domain.AppState = { pullRequests: [pullRequest], accounts: [], status: "idle" }
      const state = yield* SubscriptionRef.make(initialState)
      const providerRegions = yield* Ref.make<ReadonlyArray<string>>([])
      const service = makeRefreshSinglePR(state)
      yield* runWithLayer(
        service("111122223333", pullRequest.id),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: ({ account }) =>
              Ref.update(providerRegions, (regions) => [...regions, account.region]).pipe(
                Effect.andThen(Effect.succeed({
                  revisionId: "revision-legacy",
                  sourceCommit: "c".repeat(40),
                  title: "Coordinate refresh",
                  author: "reviewer",
                  status: "OPEN",
                  repositoryName: "payments",
                  sourceBranch: "feature",
                  destinationBranch: "main",
                  creationDate: new Date(0),
                  lastActivityDate: new Date(2_000),
                  approvedBy: [],
                  approvedByArns: [],
                  approvalRules: []
                }))
              ),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(PullRequestRepo, {
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest]),
            upsert: () => Effect.void
          }),
          Layer.mock(CommentRepo, { upsert: () => Effect.void }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(yield* Ref.get(providerRegions)).toEqual(["eu-west-1"])
    }))

  it.effect("rejects an ambiguous legacy route instead of choosing a configured region", () =>
    Effect.gen(function*() {
      const initialState: Domain.AppState = {
        pullRequests: [pullRequest, secondPullRequest],
        accounts: [],
        status: "idle"
      }
      const state = yield* SubscriptionRef.make(initialState)
      const providerCalls = yield* Ref.make(0)
      const service = makeRefreshSinglePR(state)
      const failure = yield* runWithLayer(
        service("production", pullRequest.id).pipe(Effect.flip),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: () =>
              Ref.update(providerCalls, (calls) => calls + 1).pipe(
                Effect.andThen(Effect.die("unexpected provider call"))
              ),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(PullRequestRepo, {
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest, secondCachedPullRequest])
          }),
          Layer.mock(CommentRepo, {}),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, {}),
          Layer.mock(ConfigService, {
            load: Effect.succeed({
              ...config,
              accounts: [{ profile: "production", regions: ["eu-west-1"], enabled: true }]
            })
          }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(failure._tag).toBe("RefreshError")
      expect(yield* Ref.get(providerCalls)).toBe(0)
    }))
})
