import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { PullRequestDetail } from "../src/AwsClient/internal.js"
import { CachedPullRequest, PullRequestRepo } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import type { AppState } from "../src/Domain.js"
import { syncWeek } from "../src/PRService/refreshHistory.js"

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

const detail = (approvalUnknown: { readonly _tag: "NotPermitted" } | undefined) =>
  new PullRequestDetail({
    revisionId: "revision-11",
    sourceCommit: "a".repeat(40),
    title: "PR from kept-profile",
    author: "author",
    status: "OPEN",
    repositoryName: "example-repository",
    sourceBranch: "feature",
    destinationBranch: "main",
    creationDate: new Date("2026-08-01T00:00:00.000Z"),
    lastActivityDate: new Date("2026-08-02T00:00:00.000Z"),
    approvedBy: [],
    approvedByArns: [],
    approvalRules: [],
    isApproved: true,
    approvalUnknown
  })

const historyCases: ReadonlyArray<readonly [string, { readonly _tag: "NotPermitted" } | undefined, string]> = [
  ["an unknown evaluation marks the row", { _tag: "NotPermitted" }, "NotPermitted"],
  ["a successful evaluation replaces the last known approval", undefined, "Evaluated"]
]

describe("history sync approval evaluation", () => {
  // The history sync re-reads every cached open PR; that read's evaluation must reach the cache like
  // the refresh's stale pass does, or a cached approval would be republished as known.
  it.effect.each(historyCases)("on a history re-read, %s", ([, approvalUnknown, expected]) =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const recorded = yield* Ref.make<ReadonlyArray<string>>([])
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: () => Effect.succeed({ username: "viewer", accountId: "123456789012", arn: "arn:x" }),
          getPullRequests: () => Stream.empty,
          getPullRequest: () => Effect.succeed(detail(approvalUnknown))
        }),
        Layer.mock(PullRequestRepo, {
          findAll: () => Effect.succeed([cachedRow("kept-profile", "11")]),
          findStaleOpen: () => Effect.succeed([cachedRow("kept-profile", "11")]),
          recordApprovalEvaluation: (_, __, evaluation) =>
            Ref.update(recorded, (all) => [...all, evaluation._tag === "Unknown" ? evaluation.reason : "Evaluated"]),
          refreshCommentedBy: () => Effect.void
        }),
        Layer.mock(ConfigService, {
          load: Effect.succeed(
            Schema.decodeSync(TuiConfig)({
              accounts: [{ profile: "kept-profile", regions: ["us-east-1"], enabled: true }]
            })
          )
        })
      )
      yield* syncWeek(state, "2026-W31").pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(dependencies)
      )
      expect(yield* Ref.get(recorded)).toEqual([expected])
    }))
})
