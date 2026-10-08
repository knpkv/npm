import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, SubscriptionRef } from "effect"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import type { AppState } from "../src/Domain.js"
import { calculateHealthScores } from "../src/PRService/refreshScore.js"

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
    approvalUnknownReason: null,
    approvalBaselineKnown: 1,
    approversUnknown: 0,
    observationSeq: 0,
    approvalVersion: "2026-08-02T00:00:00.000Z",
    approvalObservationSeq: 0,
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

describe("calculateHealthScores", () => {
  // A pull request CodeCommit gave no dates for can't be scored; storing 0 would claim a red score.
  it.effect("stores no score, rather than 0, for a pull request that can't be scored", () =>
    Effect.gen(function*() {
      const stored = yield* Ref.make<ReadonlyArray<readonly [string, number | null | undefined]>>([])
      const undated = Schema.decodeSync(CachedPullRequest)({
        ...Schema.encodeSync(CachedPullRequest)(cachedRow("dev", "12")),
        lastModifiedDate: new Date(0).toISOString()
      })
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const context = yield* Layer.build(Layer.mock(PullRequestRepo, {
        findAll: () => Effect.succeed([cachedRow("dev", "11"), undated]),
        writeDerived: (_, id, __, columns) =>
          Ref.update(stored, (all) => [...all, [id, columns.healthScore] satisfies (typeof all)[number]]).pipe(
            Effect.as(true)
          )
      }))
      yield* calculateHealthScores(state).pipe(Effect.provideContext(context))
      const scores = new Map(yield* Ref.get(stored))
      expect(scores.get("12")).toBeNull()
      expect(scores.get("11")).toEqual(expect.any(Number))
    }))
})
