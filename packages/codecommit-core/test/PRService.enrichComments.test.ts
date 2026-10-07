import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Schema, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { CommentRepo } from "../src/CacheService/repos/CommentRepo.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { type AppState, AwsProfileName, AwsRegion, type PRCommentLocation } from "../src/Domain.js"
import { AwsApiError } from "../src/Errors.js"
import { enrichComments } from "../src/PRService/refreshEnrich.js"

// A cached row whose comment count has never loaded.
const row = Schema.decodeSync(CachedPullRequest)({
  id: "7",
  awsAccountId: "123456789012",
  repoAccountId: null,
  accountProfile: "dev",
  accountRegion: "us-east-1",
  title: "Change",
  description: null,
  author: "author",
  repositoryName: "repository",
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
  link: "https://example.invalid/pr/7",
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

describe("enrichComments", () => {
  // A failed fetch is not "no comments": nothing is written, so the count stays not loaded (or as it
  // was) and the comment cache keeps its last known set.
  const cases: ReadonlyArray<readonly [string, Option.Option<ReadonlyArray<PRCommentLocation>>]> = [
    ["no cached comments", Option.none()],
    ["cached comments", Option.some([])]
  ]
  it.effect.each(cases)("writes nothing when the comment fetch fails, with %s", ([, cached]) =>
    Effect.gen(function*() {
      const writes = yield* Ref.make<ReadonlyArray<string>>([])
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const context = yield* Layer.build(Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCommentsForPullRequest: () =>
            Effect.fail(
              new AwsApiError({
                operation: "getCommentsForPullRequest",
                profile: AwsProfileName.make("dev"),
                region: AwsRegion.make("us-east-1"),
                cause: "throttled"
              })
            )
        }),
        Layer.mock(PullRequestRepo, {
          findAll: () => Effect.succeed([row]),
          findSubscribedByCoordinates: () => Effect.succeed(false),
          writeDerived: (_, __, ___, columns) =>
            Ref.update(writes, (all) => [...all, `count ${String(columns.commentCount)}`]).pipe(Effect.as(true)),
          refreshCommentedBy: () => Effect.void
        }),
        Layer.mock(CommentRepo, {
          find: () => Effect.succeed(cached),
          upsert: () => Ref.update(writes, (all) => [...all, "comment cache"])
        }),
        Layer.mock(NotificationRepo, {})
      ))
      yield* enrichComments({ state, subscribedRef: yield* Ref.make(new Set<string>()) }).pipe(
        Effect.provideContext(context)
      )
      expect(yield* Ref.get(writes)).toEqual([])
    }))
})
