import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Predicate, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { EventsHub } from "../src/CacheService/EventsHub.js"
import { CommentRepo } from "../src/CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../src/CacheService/repos/SyncMetadataRepo.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import { type AppState, PullRequest } from "../src/Domain.js"
import { makeRefresh } from "../src/PRService/refresh.js"

/** Stands in for a config read failing mid-write. */
class ConfigUnreadable extends Schema.TaggedError<ConfigUnreadable>()("ConfigUnreadable", {
  cause: Schema.String
}) {}

const dependencies = (load: ConfigService["Service"]["load"]) =>
  Layer.mergeAll(
    Layer.mock(AwsClient, {}),
    Layer.mock(EventsHub, {}),
    Layer.mock(CommentRepo, {}),
    Layer.mock(NotificationRepo, {}),
    Layer.mock(PullRequestRepo, {
      findAll: () => Effect.succeed([])
    }),
    Layer.mock(SubscriptionRepo, {}),
    Layer.mock(SyncMetadataRepo, {}),
    Layer.mock(ConfigService, { load })
  )

const priorPullRequest = Schema.decodeSync(PullRequest)({
  id: "77",
  title: "Published before the interrupted refresh",
  author: "author",
  repositoryName: "example-repository",
  creationDate: new Date("2026-07-01T00:00:00.000Z"),
  lastModifiedDate: new Date("2026-07-02T00:00:00.000Z"),
  link: "https://example.invalid/pr/77",
  account: { profile: "test-profile", region: "us-east-1" },
  status: "OPEN",
  sourceBranch: "feature",
  destinationBranch: "main",
  isMergeable: true,
  isApproved: false,
  approvedBy: [],
  commentedBy: [],
  approvalRules: []
})

const makeState = SubscriptionRef.make<AppState>({
  pullRequests: [],
  accounts: [],
  status: "idle"
})

describe("PRService.refresh", () => {
  it.effect("publishes a newly fetched PR during the same refresh", () =>
    Effect.gen(function*() {
      const state = yield* makeState
      const rows = yield* Ref.make<Array<typeof CachedPullRequest.Type>>([])
      const fetchedPR = Schema.decodeSync(PullRequest)({
        id: "35",
        title: "Visible after one refresh",
        author: "author",
        repositoryName: "example-repository",
        creationDate: new Date("2026-08-01T00:00:00.000Z"),
        lastModifiedDate: new Date("2026-08-02T00:00:00.000Z"),
        link: "https://example.invalid/pr/35",
        account: { profile: "test-profile", region: "us-east-1" },
        status: "OPEN",
        sourceBranch: "feature",
        destinationBranch: "main",
        isMergeable: true,
        isApproved: false,
        approvedBy: [],
        commentedBy: [],
        approvalRules: []
      })
      const cachedPR = Schema.decodeSync(CachedPullRequest)({
        id: "35",
        awsAccountId: "123456789012",
        repoAccountId: null,
        accountProfile: "test-profile",
        accountRegion: "us-east-1",
        title: "Visible after one refresh",
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
        commentCount: 0,
        healthScore: null,
        link: "https://example.invalid/pr/35",
        fetchedAt: "2026-08-02T00:00:00.000Z",
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        closedAt: null,
        mergedBy: null,
        approvedBy: null,
        approvedByArns: null,
        commentedBy: null,
        approvalRules: null
      })
      const config = Schema.decodeSync(TuiConfig)({
        accounts: [{ profile: "test-profile", regions: ["us-east-1"], enabled: true }]
      })
      const liveDependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: () => Effect.succeed({ username: "viewer", accountId: "123456789012" }),
          getPullRequests: () => Stream.make(fetchedPR),
          getCommentsForPullRequest: () => Effect.succeed([])
        }),
        Layer.mock(EventsHub, {
          batch: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
        }),
        Layer.mock(CommentRepo, {
          upsert: () => Effect.void
        }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(PullRequestRepo, {
          findAll: () => Ref.get(rows),
          findStaleOpen: () => Effect.succeed([]),
          findMissingDiffStats: () => Effect.succeed([]),
          upsert: () => Ref.set(rows, [cachedPR]),
          updateCommentCount: () => Effect.void,
          refreshCommentedBy: () => Effect.void,
          updateHealthScore: () => Effect.void,
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(SubscriptionRepo, {
          findAll: () => Effect.succeed([])
        }),
        Layer.mock(SyncMetadataRepo, {
          update: () => Effect.void
        }),
        Layer.mock(ConfigService, {
          load: Effect.succeed(config),
          detectProfiles: Effect.succeed([])
        })
      )

      // Test entry point: the layer is composed here and provided once.
      // @effect-diagnostics-next-line strictEffectProvide:off
      yield* makeRefresh(state).pipe(Effect.provide(liveDependencies))

      const finalState = yield* SubscriptionRef.get(state)
      expect(finalState.status).toBe("idle")
      expect(finalState.refreshGeneration).toBe(1)
      expect(finalState.pullRequests).toHaveLength(1)
      expect(finalState.pullRequests[0]?.id).toBe("35")
      expect(finalState.pullRequests[0]?.title).toBe("Visible after one refresh")
      expect(finalState.successfulRefreshScopes).toEqual([
        { profile: "test-profile", region: "us-east-1", awsAccountId: "123456789012" }
      ])
    }))

  it.effect("records an unexpected defect while preserving its original Cause", () =>
    Effect.gen(function*() {
      const defect = new Error("config defect")
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        // Test entry point: the layer is composed here and provided once.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toHaveLength(1)
        const [reason] = exit.cause.reasons
        expect(reason !== undefined && Cause.isDieReason(reason)).toBe(true)
        if (reason !== undefined && Cause.isDieReason(reason)) {
          expect(reason.defect).toBe(defect)
        }
      }
      expect(yield* SubscriptionRef.get(state)).toMatchObject({
        status: "error",
        error: "config defect"
      })
    }))

  it.effect("preserves an unprintable defect and records a safe fallback error", () =>
    Effect.gen(function*() {
      const defect = {
        toString(): string {
          throw new Error("formatter defect")
        }
      }
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        // Test entry point: the layer is composed here and provided once.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const [reason] = exit.cause.reasons
        expect(reason !== undefined && Cause.isDieReason(reason)).toBe(true)
        if (reason !== undefined && Cause.isDieReason(reason)) {
          expect(reason.defect).toBe(defect)
        }
      }
      expect(yield* SubscriptionRef.get(state)).toMatchObject({
        status: "error",
        error: "Unknown error"
      })
    }))

  it.effect("preserves a defect with a Symbol message and records its string representation", () =>
    Effect.gen(function*() {
      const defect = new Error("original message")
      Object.defineProperty(defect, "message", { value: Symbol("hostile message") })
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        // Test entry point: the layer is composed here and provided once.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const [reason] = exit.cause.reasons
        expect(reason !== undefined && Cause.isDieReason(reason)).toBe(true)
        if (reason !== undefined && Cause.isDieReason(reason)) {
          expect(reason.defect).toBe(defect)
        }
      }
      const finalState = yield* SubscriptionRef.get(state)
      expect(finalState).toMatchObject({
        status: "error",
        error: "Symbol(hostile message)"
      })
      expect(Predicate.isString(finalState.error)).toBe(true)
    }))

  it.effect("preserves interruption without recording it as a refresh error", () =>
    Effect.gen(function*() {
      const interruption = Cause.interrupt(841)
      // A distinctive prior snapshot: the assertions below have to prove the
      // interrupted refresh left it alone, not merely that it matches a default.
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [priorPullRequest],
        accounts: [],
        status: "idle",
        refreshGeneration: 7
      })

      const exit = yield* makeRefresh(state).pipe(
        // Test entry point: the layer is composed here and provided once.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(dependencies(Effect.failCause(interruption))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect([...Cause.interruptors(exit.cause)]).toEqual([841])
      }
      // Config is read before the cache snapshot is published, so an interrupt
      // this early leaves the previous state untouched rather than stranding it
      // in "loading" with a bumped generation. Either way it must never be
      // recorded as a refresh error.
      const interrupted = yield* SubscriptionRef.get(state)
      expect(interrupted.status).toBe("idle")
      expect(interrupted.refreshGeneration).toBe(7)
      expect(interrupted.pullRequests.map((pr) => pr.id)).toEqual(["77"])
      expect(interrupted.error).toBeUndefined()
    }))

  it.effect("hides cached PRs of a disabled account and restores them from cache when re-enabled", () =>
    Effect.gen(function*() {
      const state = yield* makeState
      const cachedRow = (profile: string, id: string) =>
        Schema.decodeSync(CachedPullRequest)({
          id,
          awsAccountId: "123456789012",
          repoAccountId: null,
          accountProfile: profile,
          accountRegion: "us-east-1",
          title: `PR from ${profile}`,
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
          commentCount: 0,
          healthScore: null,
          link: `https://example.invalid/pr/${id}`,
          fetchedAt: "2026-08-02T00:00:00.000Z",
          filesAdded: 0,
          filesModified: 1,
          filesDeleted: 0,
          closedAt: null,
          mergedBy: null,
          approvedBy: null,
          approvedByArns: null,
          commentedBy: null,
          approvalRules: null
        })
      // Both rows stay in the cache throughout: disabling an account hides its
      // pull requests, it does not evict them.
      const rows = [cachedRow("kept-profile", "11"), cachedRow("switched-off-profile", "22")]
      const queriedProfiles = yield* Ref.make<Array<string>>([])
      const configOf = (switchedOffEnabled: boolean) =>
        Schema.decodeSync(TuiConfig)({
          accounts: [
            { profile: "kept-profile", regions: ["us-east-1"], enabled: true },
            { profile: "switched-off-profile", regions: ["us-east-1"], enabled: switchedOffEnabled }
          ]
        })
      const liveDependencies = (switchedOffEnabled: boolean) =>
        Layer.mergeAll(
          Layer.mock(AwsClient, {
            getCallerIdentity: () => Effect.succeed({ username: "viewer", accountId: "123456789012" }),
            // Empty provider results: anything in the published state came from cache.
            getPullRequests: (options: { readonly profile: string }) =>
              Stream.fromEffect(Ref.update(queriedProfiles, (seen) => [...seen, options.profile])).pipe(
                Stream.flatMap(() => Stream.empty)
              ),
            getCommentsForPullRequest: () => Effect.succeed([])
          }),
          Layer.mock(EventsHub, { batch: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect }),
          Layer.mock(CommentRepo, { upsert: () => Effect.void }),
          Layer.mock(NotificationRepo, {}),
          Layer.mock(PullRequestRepo, {
            findAll: () => Effect.succeed(rows),
            findStaleOpen: () => Effect.succeed([]),
            findMissingDiffStats: () => Effect.succeed([]),
            updateCommentCount: () => Effect.void,
            refreshCommentedBy: () => Effect.void,
            updateHealthScore: () => Effect.void,
            propagateRepoAccountId: () => Effect.void
          }),
          Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
          Layer.mock(SyncMetadataRepo, { update: () => Effect.void }),
          Layer.mock(ConfigService, {
            load: Effect.succeed(configOf(switchedOffEnabled)),
            detectProfiles: Effect.succeed([])
          })
        )

      // Test entry point: the layer is composed here and provided once.
      // @effect-diagnostics-next-line strictEffectProvide:off
      yield* makeRefresh(state).pipe(Effect.provide(liveDependencies(false)))

      const hidden = yield* SubscriptionRef.get(state)
      expect(hidden.pullRequests.map((pr) => pr.id)).toEqual(["11"])
      expect(yield* Ref.get(queriedProfiles)).toEqual(["kept-profile"])

      // Test entry point: the layer is composed here and provided once.
      // @effect-diagnostics-next-line strictEffectProvide:off
      yield* makeRefresh(state).pipe(Effect.provide(liveDependencies(true)))

      const restored = yield* SubscriptionRef.get(state)
      expect(restored.pullRequests.map((pr) => pr.id).sort()).toEqual(["11", "22"])
    }))

  it.effect("does not report a fresh sync when the final publish was skipped", () =>
    Effect.gen(function*() {
      const state = yield* makeState
      const rows = [
        Schema.decodeSync(CachedPullRequest)({
          id: "11",
          awsAccountId: "123456789012",
          repoAccountId: null,
          accountProfile: "test-profile",
          accountRegion: "us-east-1",
          title: "Cached before the refresh",
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
          commentCount: 0,
          healthScore: null,
          link: "https://example.invalid/pr/11",
          fetchedAt: "2026-08-02T00:00:00.000Z",
          filesAdded: 0,
          filesModified: 1,
          filesDeleted: 0,
          closedAt: null,
          mergedBy: null,
          approvedBy: null,
          approvedByArns: null,
          commentedBy: null,
          approvalRules: null
        })
      ]
      const config = Schema.decodeSync(TuiConfig)({
        accounts: [{ profile: "test-profile", regions: ["us-east-1"], enabled: true }]
      })
      // The refresh opens fine and only the publication-time read fails, which is
      // what a concurrent `configService.save` rewriting the file looks like.
      const reads = yield* Ref.make(0)
      const load = Ref.updateAndGet(reads, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n === 1
            ? Effect.succeed(config)
            : Effect.fail(new ConfigUnreadable({ cause: "truncated" }))
        )
      )

      // @effect-diagnostics-next-line strictEffectProvide:off
      yield* makeRefresh(state).pipe(Effect.provide(Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: () => Effect.succeed({ username: "viewer", accountId: "123456789012" }),
          getPullRequests: () => Stream.empty,
          getCommentsForPullRequest: () => Effect.succeed([])
        }),
        Layer.mock(EventsHub, { batch: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect }),
        Layer.mock(CommentRepo, { upsert: () => Effect.void }),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(PullRequestRepo, {
          findAll: () => Effect.succeed(rows),
          findStaleOpen: () => Effect.succeed([]),
          findMissingDiffStats: () => Effect.succeed([]),
          updateCommentCount: () => Effect.void,
          refreshCommentedBy: () => Effect.void,
          updateHealthScore: () => Effect.void,
          propagateRepoAccountId: () => Effect.void
        }),
        Layer.mock(SubscriptionRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(SyncMetadataRepo, { update: () => Effect.void }),
        Layer.mock(ConfigService, { load, detectProfiles: Effect.succeed([]) })
      )))

      const finished = yield* SubscriptionRef.get(state)
      expect(finished.status).toBe("idle")
      expect(finished.lastUpdated).toBeUndefined()
      expect(finished.successfulRefreshScopes).toEqual([])
      expect(finished.error).toContain("could not be read")
    }))
})
