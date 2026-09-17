import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import type { CacheError } from "../src/CacheService/CacheError.js"
import { EventsHub } from "../src/CacheService/EventsHub.js"
import { CommentRepo } from "../src/CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { SyncMetadataRepo } from "../src/CacheService/repos/SyncMetadataRepo.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import { type AppState, listedForEnabledAccounts } from "../src/Domain.js"
import { PRService } from "../src/PRService/index.js"
import { syncWeek } from "../src/PRService/refreshHistory.js"
import { staleListMessage } from "../src/PRService/visibility.js"

/** Stands in for a config read failing mid-write. */
class ConfigUnreadable extends Schema.TaggedError<ConfigUnreadable>()("ConfigUnreadable", {
  cause: Schema.String
}) {}

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

const config = Schema.decodeSync(TuiConfig)({
  accounts: [
    { profile: "kept-profile", regions: ["us-east-1"], enabled: true },
    { profile: "switched-off-profile", regions: ["us-east-1"], enabled: false }
  ]
})

const configOf = (keptEnabled: boolean, switchedOffEnabled: boolean) =>
  Schema.decodeSync(TuiConfig)({
    accounts: [
      { profile: "kept-profile", regions: ["us-east-1"], enabled: keptEnabled },
      { profile: "switched-off-profile", regions: ["us-east-1"], enabled: switchedOffEnabled }
    ]
  })

const layerWithConfig = (
  findAll: () => Effect.Effect<Array<typeof CachedPullRequest.Type>, CacheError>,
  load: ConfigService["Service"]["load"]
) =>
  PRService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AwsClient, {}),
        Layer.mock(EventsHub, {}),
        Layer.mock(CommentRepo, {}),
        Layer.mock(NotificationRepo, {}),
        Layer.mock(PullRequestRepo, { findAll }),
        Layer.mock(SubscriptionRepo, {}),
        Layer.mock(SyncMetadataRepo, {}),
        Layer.mock(ConfigService, { load })
      )
    )
  )

const layer = (findAll: () => Effect.Effect<Array<typeof CachedPullRequest.Type>, CacheError>) =>
  layerWithConfig(findAll, Effect.succeed(config))

const syncDependencies = (
  findAll: () => Effect.Effect<Array<typeof CachedPullRequest.Type>, CacheError>,
  load: ConfigService["Service"]["load"]
) =>
  Layer.mergeAll(
    Layer.mock(AwsClient, {
      getCallerIdentity: () => Effect.succeed({ username: "viewer", accountId: "123456789012" }),
      getPullRequests: () => Stream.empty
    }),
    Layer.mock(PullRequestRepo, {
      findAll,
      findStaleOpen: () => Effect.succeed([]),
      refreshCommentedBy: () => Effect.void
    }),
    Layer.mock(ConfigService, { load })
  )

describe("PRService account visibility", () => {
  const bothProfiles = () => [cachedRow("kept-profile", "11"), cachedRow("switched-off-profile", "22")]

  it.effect("seeds state with enabled accounts only, before the first refresh", () =>
    Effect.gen(function*() {
      const prService = yield* PRService
      const seeded = yield* SubscriptionRef.get(prService.state)

      expect(seeded.pullRequests.map((pr) => pr.id)).toEqual(["11"])
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(layer(() => Effect.succeed(bothProfiles())))
    ))

  it.effect("keeps disabled accounts hidden after a history sync republishes the cache", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "idle"
      })

      yield* syncWeek(state, "2026-W31").pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(syncDependencies(() => Effect.succeed(bothProfiles()), Effect.succeed(config)))
      )

      expect((yield* SubscriptionRef.get(state)).pullRequests.map((pr) => pr.id)).toEqual(["11"])
    }))

  it.effect("re-reads enablement at publication, not at the start of the sync", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "idle"
      })
      // syncWeek opens with both accounts on and runs minutes of provider work
      // outside the refresh semaphore. The toggle lands mid-flight; the final
      // publish must honour it, not the snapshot it opened with.
      const reads = yield* Ref.make(0)
      const load = Ref.updateAndGet(reads, (n) => n + 1).pipe(
        Effect.map((n) => (n === 1 ? configOf(true, true) : configOf(true, false)))
      )

      yield* syncWeek(state, "2026-W31").pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(syncDependencies(() => Effect.succeed(bothProfiles()), load))
      )

      expect((yield* SubscriptionRef.get(state)).pullRequests.map((pr) => pr.id)).toEqual(["11"])
    }))

  it.effect("reports a stale list when enablement cannot be read at publication", () =>
    Effect.gen(function*() {
      // The previous publish was filtered correctly; republishing with a snapshot
      // this sync can no longer vouch for would un-hide the disabled account.
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "idle"
      })
      const reads = yield* Ref.make(0)
      const load = Ref.updateAndGet(reads, (n) => n + 1).pipe(
        Effect.flatMap((
          n
        ) => (n === 1
          ? Effect.succeed(configOf(true, true))
          : Effect.fail(new ConfigUnreadable({ cause: "truncated" })))
        )
      )

      yield* syncWeek(state, "2026-W31").pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(syncDependencies(() => Effect.succeed(bothProfiles()), load))
      )

      const published = yield* SubscriptionRef.get(state)
      expect(published.pullRequests).toEqual([])
      expect(published.status).toBe("idle")
      // Finishing quietly would show a list the sync knows it could not vouch for.
      expect(published.error).toContain("could not be read")
      expect(published.lastUpdated).toBeUndefined()
    }))

  it.effect("clears the stale-list error once a later sync publishes again", () =>
    Effect.gen(function*() {
      // Nothing else clears it on this path: without it the banner outlives the
      // condition until some full refresh happens to run.
      const state = yield* SubscriptionRef.make<AppState>({
        pullRequests: [],
        accounts: [],
        status: "idle",
        error: staleListMessage
      })

      yield* syncWeek(state, "2026-W31").pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(syncDependencies(() => Effect.succeed(bothProfiles()), Effect.succeed(config)))
      )

      const synced = yield* SubscriptionRef.get(state)
      expect(synced.error).toBeUndefined()
      expect(synced.pullRequests.map((pr) => pr.id)).toEqual(["11"])
    }))
})

describe("listedForEnabledAccounts", () => {
  const pullRequestOf = (profile: string, id: string) => ({ account: { profile }, id })
  const pullRequests = [pullRequestOf("kept-profile", "11"), pullRequestOf("switched-off-profile", "22")]

  it("drops pull requests of accounts that are switched off", () => {
    const listed = listedForEnabledAccounts(pullRequests, new Set(["kept-profile"]))

    expect(listed.map((pr) => pr.id)).toEqual(["11"])
  })

  it("empties the list when no account is switched on", () => {
    expect(listedForEnabledAccounts(pullRequests, new Set())).toEqual([])
  })

  it("passes the list through when enablement is not known", () => {
    // `undefined` is the config-unreadable case, and it must stay distinct from
    // the empty set above — a profile-detection snapshot is empty far more often
    // than the user has switched every account off.
    expect(listedForEnabledAccounts(pullRequests, undefined).map((pr) => pr.id)).toEqual(["11", "22"])
  })
})
