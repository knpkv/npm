/**
 * Every write to a pull-request row is a compare-and-set on the row's version: (provider last
 * activity, observation number), compared in that order. A write observed at an older version than
 * the row's is a no-op. The table runs every writer pair, newer first and older second, and expects
 * the row exactly as the newer write left it, both when the older write saw an older provider
 * revision and when it saw the same revision but began earlier.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { DatabaseLive } from "../src/CacheService/Database.js"
import {
  CachedPullRequest,
  PullRequestRepo,
  type PullRequestRepoContract,
  UpsertInput
} from "../src/CacheService/repos/PullRequestRepo/index.js"
import type { RowVersion } from "../src/CacheService/repos/PullRequestRepo/rowWrites.js"

const account = "123456789012"
const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
const t0 = new Date("2026-10-01T00:00:00.000Z")
const older = new Date("2026-10-02T00:00:00.000Z")
const newer = new Date("2026-10-03T00:00:00.000Z")
const newest = new Date("2026-10-04T00:00:00.000Z")

const rule = (satisfied: boolean) => ({
  ruleName: "two-reviewers",
  requiredApprovals: 2,
  poolMembers: ["alice"],
  poolMemberArns: [],
  satisfied
})

type Tag = "seed" | "older" | "newer" | "newest"

const listed = (lastActivity: Date, tag: Tag) =>
  Schema.decodeSync(UpsertInput)({
    id: "60",
    awsAccountId: account,
    repoAccountId: null,
    accountProfile: "production",
    accountRegion: coordinates.accountRegion,
    title: `PR ${tag}`,
    description: null,
    author: "author",
    repositoryName: coordinates.repositoryName,
    creationDate: t0.toISOString(),
    lastModifiedDate: lastActivity.toISOString(),
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: tag === "older" ? 0 : 1,
    approvalUnknownReason: null,
    commentCount: tag === "older" ? 1 : 2,
    link: "https://example.invalid/pr/60",
    approvedBy: [],
    approvedByArns: [],
    approvalRules: [rule(tag !== "older")]
  })

type Writer = (repo: PullRequestRepoContract, version: RowVersion, tag: Tag) => Effect.Effect<unknown, unknown>

/** Each writer, writing values that differ by `tag`, observed at `version`. */
const writers: ReadonlyArray<readonly [string, Writer]> = [
  ["upsert", (repo, version, tag) => repo.upsert(listed(version.lastActivity, tag), version.observation)],
  ["evaluated", (repo, version, tag) =>
    repo.recordApprovalEvaluation(
      account,
      "60",
      { isApproved: tag !== "older", approvalRules: [rule(tag !== "older")] },
      version,
      coordinates
    )],
  ["unknown", (repo, version, tag) =>
    repo.recordApprovalEvaluation(
      account,
      "60",
      {
        isApproved: false,
        approvalRules: [],
        approvalUnknown: { _tag: tag === "older" ? "Throttled" : "NotPermitted" }
      },
      version,
      coordinates
    )],
  ["closed", (repo, version, tag) =>
    repo.updateStatusAndClosedAt(
      account,
      "60",
      tag === "older" ? "CLOSED" : "MERGED",
      version.lastActivity.toISOString(),
      version.observation,
      undefined,
      [tag],
      coordinates
    )],
  [
    "diffStats",
    (repo, version, tag) => repo.updateDiffStats(account, "60", tag === "older" ? 1 : 5, 2, 3, version, coordinates)
  ],
  [
    "commentCount",
    (repo, version, tag) => repo.updateCommentCount(account, "60", tag === "older" ? 1 : 9, version, coordinates)
  ],
  [
    "healthScore",
    (repo, version, tag) => repo.updateHealthScore(account, "60", tag === "older" ? 1 : 7, version, coordinates)
  ],
  ["delete", (repo, version) => repo.deleteOne(account, "60", version, coordinates)]
]

/** The older write's version: an older provider revision, or the same revision read earlier. */
const families: ReadonlyArray<readonly [string, RowVersion, RowVersion]> = [
  ["an older revision", { lastActivity: newer, observation: 2 }, { lastActivity: older, observation: 3 }],
  ["the same revision read earlier", { lastActivity: newer, observation: 3 }, { lastActivity: newer, observation: 2 }]
]

const pairs: ReadonlyArray<readonly [string, Writer, RowVersion, Writer, RowVersion]> = families.flatMap((
  [family, newerVersion, olderVersion]
) =>
  writers.flatMap(([newerName, newerWrite]) =>
    writers.map(([olderName, olderWrite]): readonly [string, Writer, RowVersion, Writer, RowVersion] => [
      `${newerName}, then ${olderName} from ${family}`,
      newerWrite,
      newerVersion,
      olderWrite,
      olderVersion
    ])
  )
)

const withCache = <A, E>(body: Effect.Effect<A, E, PullRequestRepo>) =>
  Effect.gen(function*() {
    const node = yield* Layer.build(NodeServices.layer)
    return yield* Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-row-writes-" })
      const services = Layer.mergeAll(PullRequestRepo.Default, DatabaseLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
      )
      const context = yield* Layer.build(services)
      return yield* body.pipe(Effect.provideContext(context))
    }).pipe(Effect.provideContext(node))
  }).pipe(Effect.scoped)

/** The row as stored, minus `fetched_at`, the time of the write itself. */
const snapshot = Effect.flatMap(
  PullRequestRepo,
  (repo) => repo.findByCoordinates(account, "60", coordinates.repositoryName, coordinates.accountRegion)
).pipe(Effect.map(Option.map((row) => {
  const { fetchedAt: _, ...rest } = Schema.encodeSync(CachedPullRequest)(row)
  return rest
})))

const seed = (repo: PullRequestRepoContract) => repo.upsert(listed(t0, "seed"), 1)

describe("pull-request row writes", () => {
  it.effect.each(pairs)(
    "%s: the older write is a no-op",
    ([, newerWrite, newerVersion, olderWrite, olderVersion]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        yield* newerWrite(repo, newerVersion, "newer")
        const afterNewer = yield* snapshot
        yield* olderWrite(repo, olderVersion, "older")
        expect(yield* snapshot).toEqual(afterNewer)
      }))
  )

  it.effect.each(writers)("%s still applies at a newer version", ([, write]) =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const before = yield* snapshot
      yield* write(repo, { lastActivity: newest, observation: 5 }, "newest")
      expect(yield* snapshot).not.toEqual(before)
    })))

  // The case the provider date alone missed: approval turned unknown without the revision moving.
  it.effect("keeps a newer unknown approval when an earlier read of the same revision evaluates later", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const slow = yield* repo.observe()
      const fast = yield* repo.observe()
      yield* repo.recordApprovalEvaluation(
        account,
        "60",
        {
          isApproved: false,
          approvalRules: [],
          approvalUnknown: { _tag: "NotPermitted" }
        },
        { lastActivity: t0, observation: fast },
        coordinates
      )
      const late = yield* repo.upsert(listed(t0, "older"), slow)
      expect(late).toBe(false)
      expect(Option.map(yield* snapshot, (row) => row.approvalUnknownReason)).toEqual(Option.some("NotPermitted"))
      // A read that began after both still recovers it.
      expect(yield* repo.upsert(listed(t0, "newest"), yield* repo.observe())).toBe(true)
      expect(Option.map(yield* snapshot, (row) => row.approvalUnknownReason)).toEqual(Option.some(null))
    })))

  it.effect("hands out strictly increasing observation numbers", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const numbers = yield* Effect.all([repo.observe(), repo.observe(), repo.observe()], { concurrency: 3 })
      expect(new Set(numbers).size).toBe(3)
      expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3])
    })))

  // The tombstone holds a deletion's version: a listing newer than it still brings the row back.
  it.effect("re-inserts a deleted pull request from a listing newer than the deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      yield* repo.deleteOne(account, "60", { lastActivity: newer, observation: 2 }, coordinates)
      yield* repo.upsert(listed(older, "older"), 3)
      expect(Option.isNone(yield* snapshot)).toBe(true)
      yield* repo.upsert(listed(newest, "newest"), 4)
      expect(Option.map(yield* snapshot, (row) => row.title)).toEqual(Option.some("PR newest"))
    })))

  // Tombstones expire by when the deletion happened (the cache clock), not by the pull request's
  // provider activity, which can be years old.
  it.effect("keeps a tombstone of an old pull request through an expiry cutoff that precedes its deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      yield* repo.deleteOne(account, "60", { lastActivity: newer, observation: 2 }, coordinates)
      // Before the deletion, after its provider version.
      yield* repo.deleteStale("2026-10-05T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"), 3)
      expect(Option.isNone(yield* snapshot)).toBe(true)
      // After the deletion: the tombstone expires with the rest of the stale cache.
      yield* repo.deleteStale("2999-01-01T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"), 4)
      expect(Option.isSome(yield* snapshot)).toBe(true)
    })))
})
