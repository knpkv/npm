import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { PullRequestDetail } from "../src/AwsClient/internal.js"
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
  approvalUnknownReason: null,
  observationSeq: 0,
  approvalVersion: "2026-08-02T00:00:00.000Z",
  approvalObservationSeq: 0,
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

const foreignPullRequest = Schema.decodeSync(Domain.PullRequest)({
  ...pullRequest,
  account: {
    ...pullRequest.account,
    awsAccountId: "999988887777",
    profile: "foreign",
    repoAccountId: "111122223333"
  }
})
const foreignCachedPullRequest = Schema.encodeSync(CachedPullRequest)({
  ...cachedPullRequest,
  awsAccountId: "999988887777",
  accountProfile: "foreign",
  repoAccountId: "111122223333"
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

const singleRefreshApprovalCases: ReadonlyArray<
  readonly [string, Domain.ApprovalUnknownReason | undefined, readonly [number, Domain.ApprovalUnknownTag | null]]
> = [
  ["an evaluated approval replaces the cached one and clears the reason", undefined, [0, null]],
  // While unknown the input's approval is a placeholder: the upsert keeps the cached value
  // (PullRequestRepo.approvalUnknown.test.ts proves that against the database).
  ["an unknown approval stores the reason, with a placeholder approval", { _tag: "NotPermitted" }, [0, "NotPermitted"]]
]

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
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest]),
            upsertRead: () => Effect.succeed({ row: true, approval: true })
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void
          }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(result).toEqual({ revisionId: "revision-2", sourceCommit: "b".repeat(40) })
      expect(yield* Ref.get(providerCalls)).toEqual([{ region: "eu-west-1", repositoryName: "payments" }])
    }))

  // The read is newer or older than the cached row (1 s). Either way the upsert carries the read's own
  // version, so the cache's compare-and-set rejects the older one instead of storing it as current.
  it.effect.each(
    singleRefreshApprovalCases.flatMap(([name, unknown, expected]) =>
      [2_000, 500].map((readAt): readonly [string, typeof unknown, typeof expected, number] => [
        `${name} (read at ${readAt} ms)`,
        unknown,
        expected,
        readAt
      ])
    )
  )(
    "on a single refresh, %s",
    ([, approvalUnknown, expected, readAt]) =>
      Effect.gen(function*() {
        const initialState: Domain.AppState = { pullRequests: [pullRequest], accounts: [], status: "idle" }
        const state = yield* SubscriptionRef.make(initialState)
        const upserted = yield* Ref.make<ReadonlyArray<readonly [number, string | null]>>([])
        const stored = yield* Ref.make<ReadonlyArray<string>>([])
        const approvedCache = Schema.decodeSync(CachedPullRequest)({
          ...Schema.encodeSync(CachedPullRequest)(cachedPullRequest),
          isApproved: 1
        })
        yield* runWithLayer(
          makeRefreshSinglePR(state)("111122223333", pullRequest.id, {
            region: "eu-west-1",
            repositoryName: "payments"
          }),
          Layer.mergeAll(
            Layer.mock(AwsClient, {
              getPullRequest: () =>
                Effect.succeed(
                  new PullRequestDetail({
                    revisionId: "revision-2",
                    sourceCommit: "b".repeat(40),
                    title: "Coordinate refresh",
                    author: "reviewer",
                    status: "OPEN",
                    repositoryName: "payments",
                    sourceBranch: "feature",
                    destinationBranch: "main",
                    creationDate: new Date(0),
                    lastActivityDate: new Date(readAt),
                    approvedBy: [],
                    approvedByArns: [],
                    isMergeable: true,
                    approvalRules: [],
                    isApproved: false,
                    approvalUnknown
                  })
                ),
              getCommentsForPullRequest: () => Effect.succeed([])
            }),
            Layer.mock(PullRequestRepo, {
              observe: () => Effect.succeed(1),
              findByAccountAndId: () => Effect.succeed(Option.none()),
              findByCoordinates: () => Effect.succeed(Option.some(approvedCache)),
              findAll: () => Effect.succeed([approvedCache]),
              upsertRead: (input) =>
                Ref.update(upserted, (all) => [...all, [input.isApproved, input.approvalUnknownReason]]).pipe(
                  Effect.andThen(Ref.update(stored, (all) => [...all, input.lastModifiedDate])),
                  Effect.as({ row: true, approval: true, versions: undefined })
                )
            }),
            Layer.mock(CommentRepo, {
              find: () => Effect.succeed(Option.none()),
              upsert: () => Effect.void
            }),
            Layer.mock(NotificationRepo, {}),
            Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
            Layer.mock(ConfigService, { load: Effect.succeed(config) }),
            Layer.mock(EventsHub, {})
          )
        )
        expect(yield* Ref.get(upserted)).toEqual([expected])
        expect(yield* Ref.get(stored)).toEqual([new Date(readAt).toISOString()])
      })
  )

  // A read older than the cached row changes nothing in the cache, so it announces nothing.
  // The last case: an earlier snapshot saw it pending, but the write replaced an approval stored
  // meanwhile, so the revocation is announced from the replaced row.
  const singleRefreshWriteCases: ReadonlyArray<readonly [string, boolean, number, boolean]> = [
    ["accepted", true, 1, true],
    ["rejected as older than the cached row", false, 0, true],
    ["accepted over an approval its snapshot didn't see", true, 1, false]
  ]
  it.effect.each(singleRefreshWriteCases)(
    "sends a subscribed single refresh's notifications only when its upsert is %s",
    ([, applied, expected, snapshotApproved]) =>
      Effect.gen(function*() {
        const initialState: Domain.AppState = { pullRequests: [pullRequest], accounts: [], status: "idle" }
        const state = yield* SubscriptionRef.make(initialState)
        const added = yield* Ref.make<ReadonlyArray<string>>([])
        const commentWrites = yield* Ref.make(0)
        const approvedCache = Schema.decodeSync(CachedPullRequest)({
          ...Schema.encodeSync(CachedPullRequest)(cachedPullRequest),
          isApproved: 1
        })
        yield* runWithLayer(
          makeRefreshSinglePR(state)("111122223333", pullRequest.id, {
            region: "eu-west-1",
            repositoryName: "payments"
          }),
          Layer.mergeAll(
            Layer.mock(AwsClient, {
              getPullRequest: () =>
                Effect.succeed(
                  new PullRequestDetail({
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
                    isMergeable: true,
                    approvalRules: [],
                    isApproved: false
                  })
                ),
              getCommentsForPullRequest: () => Effect.succeed([])
            }),
            Layer.mock(PullRequestRepo, {
              observe: () => Effect.succeed(1),
              findByAccountAndId: () => Effect.succeed(Option.none()),
              findByCoordinates: () =>
                Effect.succeed(Option.some(snapshotApproved ? approvedCache : { ...approvedCache, isApproved: false })),
              findAll: () => Effect.succeed([approvedCache]),
              upsertRead: () =>
                Effect.succeed({
                  row: applied,
                  approval: applied,
                  versions: applied
                    ? {
                      row: { lastActivity: new Date(2_000), observation: 1 },
                      approval: { lastActivity: new Date(2_000), observation: 1 }
                    }
                    : undefined,
                  replaced: Option.some(approvedCache)
                }),
              writeDerived: () => Effect.succeed(true)
            }),
            Layer.mock(CommentRepo, {
              find: () => Effect.succeed(Option.none()),
              upsert: () =>
                Ref.update(commentWrites, (n) => n + 1).pipe(
                  Effect.as({ row: true, approval: true, versions: undefined })
                )
            }),
            Layer.mock(NotificationRepo, { add: (n) => Ref.update(added, (all) => [...all, n.type]) }),
            Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(true) }),
            Layer.mock(ConfigService, { load: Effect.succeed(config) }),
            Layer.mock(EventsHub, {})
          )
        )
        expect((yield* Ref.get(added)).filter((type) => type === "approval_changed")).toHaveLength(expected)
        // The comment cache moves with the pull request's row: a rejected read leaves it alone.
        expect(yield* Ref.get(commentWrites)).toBe(expected)
      })
  )

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
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest])
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none())
          }),
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

  it.effect("binds exact refreshes to the requested credential account", () =>
    Effect.gen(function*() {
      const initialState: Domain.AppState = {
        pullRequests: [foreignPullRequest, pullRequest],
        accounts: [],
        status: "idle"
      }
      const state = yield* SubscriptionRef.make(initialState)
      const providerProfiles = yield* Ref.make<ReadonlyArray<string>>([])
      const service = makeRefreshSinglePR(state)
      yield* runWithLayer(
        service("111122223333", pullRequest.id, {
          region: "eu-west-1",
          repositoryName: "payments"
        }),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: ({ account }) =>
              Ref.update(providerProfiles, (profiles) => [...profiles, account.profile]).pipe(
                Effect.andThen(Effect.succeed({
                  revisionId: "revision-exact",
                  sourceCommit: "d".repeat(40),
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
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([foreignCachedPullRequest, cachedPullRequest]),
            upsertRead: () => Effect.succeed({ row: true, approval: true })
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void
          }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(yield* Ref.get(providerProfiles)).toEqual(["production"])
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
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest])
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none())
          }),
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
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest]),
            upsertRead: () => Effect.succeed({ row: true, approval: true })
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void
          }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(yield* Ref.get(providerRegions)).toEqual(["eu-west-1"])
    }))

  it.effect("does not use a repository-owner collision for a legacy refresh", () =>
    Effect.gen(function*() {
      const initialState: Domain.AppState = {
        pullRequests: [foreignPullRequest, pullRequest],
        accounts: [],
        status: "idle"
      }
      const state = yield* SubscriptionRef.make(initialState)
      const providerProfiles = yield* Ref.make<ReadonlyArray<string>>([])
      const service = makeRefreshSinglePR(state)
      yield* runWithLayer(
        service("111122223333", pullRequest.id),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: ({ account }) =>
              Ref.update(providerProfiles, (profiles) => [...profiles, account.profile]).pipe(
                Effect.andThen(Effect.succeed({
                  revisionId: "revision-legacy-collision",
                  sourceCommit: "g".repeat(40),
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
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([]),
            upsertRead: () => Effect.succeed({ row: true, approval: true })
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void
          }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(yield* Ref.get(providerProfiles)).toEqual(["production"])
    }))

  it.effect("keeps token refreshes bound to durable accounts", () =>
    Effect.gen(function*() {
      const tokenCollision = { ...foreignCachedPullRequest, accountProfile: "111122223333" }
      const state = yield* SubscriptionRef.make<Domain.AppState>({
        pullRequests: [],
        accounts: [],
        status: "idle"
      })
      const providerCalls = yield* Ref.make(0)
      const service = makeRefreshSinglePR(state)
      const failure = yield* runWithLayer(
        service("111122223333", pullRequest.id, {
          repositoryName: "payments",
          region: "eu-west-1",
          accountIdSource: "coordinate-token"
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
            observe: () => Effect.succeed(1),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([tokenCollision])
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none())
          }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, {}),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )

      expect(failure._tag).toBe("RefreshError")
      expect(yield* Ref.get(providerCalls)).toBe(0)
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
            observe: () => Effect.succeed(1),
            findByAccountAndId: () => Effect.succeed(Option.none()),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest, secondCachedPullRequest])
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none())
          }),
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

  it.effect("accepts an exact profile alias without replacing its durable account", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<Domain.AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const upserted = yield* Ref.make<string | undefined>(undefined)
      const service = makeRefreshSinglePR(state)
      yield* runWithLayer(
        service("production", pullRequest.id, { repositoryName: "payments", region: "eu-west-1" }),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getPullRequest: () =>
              Effect.succeed({
                revisionId: "revision-profile",
                sourceCommit: "e".repeat(40),
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
              }),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(PullRequestRepo, {
            observe: () => Effect.succeed(1),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([cachedPullRequest]),
            upsertRead: (input) => Ref.set(upserted, input.awsAccountId).pipe(Effect.as({ row: true, approval: true }))
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void
          }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, { load: Effect.succeed(config) }),
          Layer.mock(EventsHub, {})
        )
      )
      expect(yield* Ref.get(upserted)).toBe("111122223333")
    }))

  it.effect("resolves a profile identity before persisting an uncached exact refresh", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<Domain.AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const upserted = yield* Ref.make<string | undefined>(undefined)
      const service = makeRefreshSinglePR(state)
      yield* runWithLayer(
        service("production", pullRequest.id, { repositoryName: "payments", region: "eu-west-1" }),
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getCallerIdentity: () =>
              Effect.succeed({
                username: "viewer",
                accountId: "111122223333",
                arn: "arn:aws:sts::111122223333:assumed-role/Viewer/viewer"
              }),
            getPullRequest: () =>
              Effect.succeed({
                revisionId: "revision-uncached-profile",
                sourceCommit: "f".repeat(40),
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
              }),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(PullRequestRepo, {
            observe: () => Effect.succeed(1),
            findByCoordinates: () => Effect.succeed(Option.none()),
            findAll: () => Effect.succeed([]),
            upsertRead: (input) => Ref.set(upserted, input.awsAccountId).pipe(Effect.as({ row: true, approval: true }))
          }),
          Layer.mock(CommentRepo, {
            find: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void
          }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(SubscriptionRepo, { isSubscribed: () => Effect.succeed(false) }),
          Layer.mock(ConfigService, {
            load: Effect.succeed({
              ...config,
              accounts: [{ profile: "production", regions: ["eu-west-1"], enabled: true }]
            })
          }),
          Layer.mock(EventsHub, {})
        )
      )
      expect(yield* Ref.get(upserted)).toBe("111122223333")
    }))
})
