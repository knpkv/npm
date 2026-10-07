/**
 * Every write to a pull-request row is a compare-and-set on the row's version (its provider last
 * activity): a write observed at an older version than the row's is a no-op. The table runs every
 * writer pair, newer first and older second, and expects the row exactly as the newer write left it.
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

const listed = (version: Date, tag: string) =>
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
    lastModifiedDate: version.toISOString(),
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: tag === "newer" ? 1 : 0,
    approvalUnknownReason: null,
    commentCount: tag === "newer" ? 2 : 1,
    link: "https://example.invalid/pr/60",
    approvedBy: [],
    approvedByArns: [],
    approvalRules: [rule(tag === "newer")]
  })

type Writer = (repo: PullRequestRepoContract, version: Date, tag: "older" | "newer" | "newest") => Effect.Effect<
  void,
  unknown
>

/** Each writer, writing values that differ by `tag`, observed at `version`. */
const writers: ReadonlyArray<readonly [string, Writer]> = [
  ["upsert", (repo, version, tag) => repo.upsert(listed(version, tag))],
  ["evaluated", (repo, version, tag) =>
    repo.recordApprovalEvaluation(account, "60", {
      isApproved: tag !== "older",
      approvalRules: [rule(tag !== "older")],
      lastActivityDate: version
    }, coordinates)],
  ["unknown", (repo, version, tag) =>
    repo.recordApprovalEvaluation(account, "60", {
      isApproved: false,
      approvalRules: [],
      approvalUnknown: { _tag: tag === "older" ? "Throttled" : "NotPermitted" },
      lastActivityDate: version
    }, coordinates)],
  [
    "closed",
    (repo, version, tag) =>
      repo.updateStatusAndClosedAt(
        account,
        "60",
        tag === "older" ? "CLOSED" : "MERGED",
        version.toISOString(),
        undefined,
        [
          tag
        ],
        coordinates
      )
  ],
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

const pairs: ReadonlyArray<readonly [string, Writer, Writer]> = writers.flatMap(([newerName, newerWrite]) =>
  writers.map(([olderName, olderWrite]): readonly [string, Writer, Writer] => [
    `${newerName} then an older ${olderName}`,
    newerWrite,
    olderWrite
  ])
)

describe("pull-request row writes", () => {
  it.effect.each(pairs)(
    "%s: the older write is a no-op",
    ([, newerWrite, olderWrite]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* repo.upsert(listed(t0, "seed"))
        yield* newerWrite(repo, newer, "newer")
        const afterNewer = yield* snapshot
        yield* olderWrite(repo, older, "older")
        expect(yield* snapshot).toEqual(afterNewer)
      }))
  )

  it.effect.each(writers)("%s still applies at a newer version", ([, write]) =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(listed(t0, "seed"))
      const before = yield* snapshot
      yield* write(repo, newest, "newest")
      expect(yield* snapshot).not.toEqual(before)
    })))

  // The tombstone holds a deletion's version: a listing newer than it still brings the row back.
  it.effect("re-inserts a deleted pull request from a listing newer than the deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(listed(t0, "seed"))
      yield* repo.deleteOne(account, "60", newer, coordinates)
      yield* repo.upsert(listed(older, "older"))
      expect(Option.isNone(yield* snapshot)).toBe(true)
      yield* repo.upsert(listed(newest, "newest"))
      expect(Option.map(yield* snapshot, (row) => row.title)).toEqual(Option.some("PR newest"))
    })))

  // Tombstones expire by when the deletion happened (the cache clock), not by the pull request's
  // provider activity, which can be years old.
  it.effect("keeps a tombstone of an old pull request through an expiry cutoff that precedes its deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(listed(t0, "seed"))
      yield* repo.deleteOne(account, "60", newer, coordinates)
      // Before the deletion, after its provider version.
      yield* repo.deleteStale("2026-10-05T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"))
      expect(Option.isNone(yield* snapshot)).toBe(true)
      // After the deletion: the tombstone expires with the rest of the stale cache.
      yield* repo.deleteStale("2999-01-01T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"))
      expect(Option.isSome(yield* snapshot)).toBe(true)
    })))
})
