import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
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
          batch: (effect) => effect
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

      yield* makeRefresh(state).pipe(Effect.provide(liveDependencies))

      const finalState = yield* SubscriptionRef.get(state)
      expect(finalState.status).toBe("idle")
      expect(finalState.refreshGeneration).toBe(1)
      expect(finalState.pullRequests).toHaveLength(1)
      expect(finalState.pullRequests[0]?.id).toBe("35")
      expect(finalState.pullRequests[0]?.title).toBe("Visible after one refresh")
      expect(finalState.successfulRefreshScopes).toEqual([
        { profile: "test-profile", region: "us-east-1" }
      ])
    }))

  it.effect("records an unexpected defect while preserving its original Cause", () =>
    Effect.gen(function*() {
      const defect = new Error("config defect")
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toHaveLength(1)
        const [reason] = exit.cause.reasons
        expect(reason && Cause.isDieReason(reason)).toBe(true)
        if (reason && Cause.isDieReason(reason)) {
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
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const [reason] = exit.cause.reasons
        expect(reason && Cause.isDieReason(reason)).toBe(true)
        if (reason && Cause.isDieReason(reason)) {
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
        Effect.provide(dependencies(Effect.die(defect))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const [reason] = exit.cause.reasons
        expect(reason && Cause.isDieReason(reason)).toBe(true)
        if (reason && Cause.isDieReason(reason)) {
          expect(reason.defect).toBe(defect)
        }
      }
      const finalState = yield* SubscriptionRef.get(state)
      expect(finalState).toMatchObject({
        status: "error",
        error: "Symbol(hostile message)"
      })
      expect(typeof finalState.error).toBe("string")
    }))

  it.effect("preserves interruption without recording it as a refresh error", () =>
    Effect.gen(function*() {
      const interruption = Cause.interrupt(841)
      const state = yield* makeState

      const exit = yield* makeRefresh(state).pipe(
        Effect.provide(dependencies(Effect.failCause(interruption))),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect([...Cause.interruptors(exit.cause)]).toEqual([841])
      }
      expect(yield* SubscriptionRef.get(state)).toMatchObject({
        status: "loading"
      })
      expect((yield* SubscriptionRef.get(state)).error).toBeUndefined()
    }))
})
