import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { PullRequestDetail } from "../src/AwsClient/internal.js"
import { CacheError } from "../src/CacheService/CacheError.js"
import {
  CachedPullRequest,
  PullRequestRepo,
  type PullRequestRepoContract
} from "../src/CacheService/repos/PullRequestRepo/index.js"
import { ConfigService } from "../src/ConfigService/index.js"
import { TuiConfig } from "../src/ConfigService/internal.js"
import { type AppState, AwsProfileName, AwsRegion } from "../src/Domain.js"
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

/** Run `effect` with `layer`'s services, built in the effect's own scope. */
const runWithLayer = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R>): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.gen(function*() {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provideContext(context))
    })
  )

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
    isMergeable: true,
    approvalRules: [],
    isApproved: true,
    approvalUnknown
  })

const historyCases: ReadonlyArray<readonly [string, { readonly _tag: "NotPermitted" } | undefined, string]> = [
  ["an unknown evaluation marks the row", { _tag: "NotPermitted" }, "NotPermitted"],
  ["a successful evaluation replaces the last known approval", undefined, "Evaluated"]
]

// The stale-open read of a cached row: its coordinates and versions.
const staleOpen = (row: CachedPullRequest): StaleOpen => ({
  id: row.id,
  awsAccountId: row.awsAccountId,
  repositoryName: row.repositoryName,
  accountProfile: AwsProfileName.make(row.accountProfile),
  accountRegion: AwsRegion.make(row.accountRegion),
  lastModifiedDate: row.lastModifiedDate,
  observationSeq: row.observationSeq,
  approvalVersion: row.approvalVersion,
  approvalObservationSeq: row.approvalObservationSeq
})
type StaleOpen = Effect.Success<ReturnType<PullRequestRepoContract["findStaleOpen"]>>[number]

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
          observe: () => Effect.succeed(1),
          findAll: () => Effect.succeed([cachedRow("kept-profile", "11")]),
          findStaleOpen: () => Effect.succeed([staleOpen(cachedRow("kept-profile", "11"))]),
          findClosedWithUnknownApprovers: () => Effect.succeed([]),
          writeRead: (_, __, evaluation) =>
            Ref.update(recorded, (all) => [...all, evaluation.approvalUnknown?._tag ?? "Evaluated"]).pipe(
              Effect.as({ row: true, approval: true, versions: undefined })
            ),
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
      yield* runWithLayer(syncWeek(state, "2026-W31"), dependencies)
      expect(yield* Ref.get(recorded)).toEqual([expected])
    }))

  // The sync moves on past one pull request's failure, but says so: a lost approval write would
  // otherwise leave the cached approval republished as known, with nothing in the log.
  it.effect("logs a pull request whose approval evaluation could not be recorded, and continues", () =>
    Effect.gen(function*() {
      const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "idle" })
      const warnings: Array<string> = []
      const logger = Logger.make<unknown, void>((entry) => {
        if (entry.logLevel === "Warn") warnings.push(String(entry.message))
      })
      const dependencies = Layer.mergeAll(
        Layer.mock(AwsClient, {
          getCallerIdentity: () => Effect.succeed({ username: "viewer", accountId: "123456789012", arn: "arn:x" }),
          getPullRequests: () => Stream.empty,
          getPullRequest: () => Effect.succeed(detail({ _tag: "NotPermitted" }))
        }),
        Layer.mock(PullRequestRepo, {
          observe: () => Effect.succeed(1),
          findAll: () => Effect.succeed([cachedRow("kept-profile", "11")]),
          findStaleOpen: () => Effect.succeed([staleOpen(cachedRow("kept-profile", "11"))]),
          findClosedWithUnknownApprovers: () => Effect.succeed([]),
          writeRead: () => Effect.fail(new CacheError({ operation: "recordApprovalEvaluation", cause: "disk full" })),
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
      yield* runWithLayer(syncWeek(state, "2026-W31"), dependencies).pipe(Effect.withLogger(logger))
      expect(warnings.some((message) => message.includes("#11"))).toBe(true)
    }))
})
