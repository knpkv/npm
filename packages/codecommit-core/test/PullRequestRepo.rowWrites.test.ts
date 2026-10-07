/**
 * Every write to a pull-request row is a compare-and-set per column group: the row, and the approval
 * (approval, unknown reason, rules), each with its own version (provider last activity, observation
 * number), compared in that order. A write observed at an older version than a group's leaves that
 * group alone. The table runs every writer pair, newer first and older second, and expects every group
 * the newer write touched exactly as it left it; a group only the older write touches may still move.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { DatabaseLive } from "../src/CacheService/Database.js"
import {
  CachedPullRequest,
  PullRequestRepo,
  type PullRequestRepoContract,
  type RowVersion,
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
type Group = "row" | "approval"

/** Each writer, the column groups it touches, and what it writes (differing by `tag`) at `version`. */
const writers: ReadonlyArray<readonly [string, ReadonlyArray<Group>, Writer]> = [
  [
    "upsert",
    ["row", "approval"],
    (repo, version, tag) => repo.upsert(listed(version.lastActivity, tag), version.observation)
  ],
  ["evaluated", ["approval"], (repo, version, tag) =>
    repo.recordApprovalEvaluation(
      account,
      "60",
      { isApproved: tag !== "older", approvalRules: [rule(tag !== "older")] },
      version,
      coordinates
    )],
  ["unknown", ["approval"], (repo, version, tag) =>
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
  ["closed", ["row"], (repo, version, tag) =>
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
    ["row"],
    (repo, version, tag) => repo.updateDiffStats(account, "60", tag === "older" ? 1 : 5, 2, 3, version, coordinates)
  ],
  [
    "commentCount",
    ["row"],
    (repo, version, tag) => repo.updateCommentCount(account, "60", tag === "older" ? 1 : 9, version, coordinates)
  ],
  [
    "healthScore",
    ["row"],
    (repo, version, tag) => repo.updateHealthScore(account, "60", tag === "older" ? 1 : 7, version, coordinates)
  ],
  ["delete", ["row", "approval"], (repo, version) => repo.deleteOne(account, "60", version.observation, coordinates)]
]

/**
 * The older write's version: an older revision read earlier, the same revision read earlier, or an
 * older revision read later (a lagging provider replica). A not-found read has no revision, so its
 * observation alone orders it: the third family leaves deletion out on both sides (a later not-found
 * read deletes whatever the row holds, and a later read that still sees the pull request brings it
 * back; both are tested on their own).
 */
const families: ReadonlyArray<readonly [string, RowVersion, RowVersion, boolean]> = [
  [
    "an older revision read earlier",
    { lastActivity: newer, observation: 3 },
    { lastActivity: older, observation: 2 },
    true
  ],
  [
    "the same revision read earlier",
    { lastActivity: newer, observation: 3 },
    { lastActivity: newer, observation: 2 },
    true
  ],
  [
    "an older revision read later",
    { lastActivity: newer, observation: 3 },
    { lastActivity: older, observation: 4 },
    false
  ]
]

type Pair = readonly [string, Writer, RowVersion, Writer, RowVersion, ReadonlyArray<Group>]

const pairs: ReadonlyArray<Pair> = families.flatMap(([family, newerVersion, olderVersion, includeDelete]) => {
  const eligible = writers.filter(([name]) => includeDelete || name !== "delete")
  return eligible.flatMap(([newerName, touched, newerWrite]) =>
    eligible.map(([olderName, , olderWrite]): Pair => [
      `${newerName}, then ${olderName} from ${family}`,
      newerWrite,
      newerVersion,
      olderWrite,
      olderVersion,
      touched
    ])
  )
})

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

const approvalColumns: ReadonlySet<string> = new Set(["isApproved", "approvalUnknownReason", "approvalRules"])

/** The stored row's columns in `group`, or nothing when the row is gone. */
const groupOf = <Row extends object>(row: Option.Option<Row>, group: Group) =>
  Option.map(row, (columns) =>
    Object.fromEntries(
      Object.entries(columns).filter(([column]) => approvalColumns.has(column) === (group === "approval"))
    ))

const seed = (repo: PullRequestRepoContract) => repo.upsert(listed(t0, "seed"), 1)

/** A full read of the `older` revision that saw conflicts and no approval. */
const fullRead = Schema.decodeSync(UpsertInput)({
  ...Schema.encodeSync(UpsertInput)(listed(older, "older")),
  title: "Conflicting change",
  isMergeable: 0
})

describe("pull-request row writes", () => {
  it.effect.each(pairs)(
    "%s: the older write leaves the newer write's groups alone",
    ([, newerWrite, newerVersion, olderWrite, olderVersion, touched]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        yield* newerWrite(repo, newerVersion, "newer")
        const afterNewer = yield* snapshot
        yield* olderWrite(repo, olderVersion, "older")
        const afterOlder = yield* snapshot
        // A deleted row stays deleted; otherwise each group the newer write touched is as it left it.
        expect(Option.isSome(afterOlder)).toBe(Option.isSome(afterNewer))
        for (const group of touched) expect(groupOf(afterOlder, group)).toEqual(groupOf(afterNewer, group))
      }))
  )

  it.effect.each(writers)("%s still applies at a newer version", ([, , write]) =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const before = yield* snapshot
      // The "older" values differ from the seed for every writer; the version is the newest.
      yield* write(repo, { lastActivity: newest, observation: 5 }, "older")
      expect(yield* snapshot).not.toEqual(before)
    })))

  // Cross-group: an approval re-read never makes the rest of the row look newer than it is. The
  // reviewer's case: a full read and a later approval read of the same new revision, in either order.
  it.effect.each([["the approval read lands first", true], ["the full read lands first", false]])(
    "keeps a full read's row and a later approval read's approval of the same revision (%s)",
    ([, approvalFirst]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        const full = yield* repo.observe()
        const approvalRead = yield* repo.observe()
        const writeFull = repo.upsert(fullRead, full)
        const writeApproval = repo.recordApprovalEvaluation(
          account,
          "60",
          { isApproved: true, approvalRules: [rule(true)] },
          { lastActivity: older, observation: approvalRead },
          coordinates
        )
        yield* approvalFirst
          ? writeApproval.pipe(Effect.andThen(writeFull))
          : writeFull.pipe(Effect.andThen(writeApproval))
        const row = Option.getOrThrow(yield* snapshot)
        expect([row.title, row.isMergeable, row.isApproved]).toEqual(["Conflicting change", 0, 1])
      }))
  )

  it.effect("reports which groups an upsert wrote", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const full = yield* repo.observe()
      yield* repo.recordApprovalEvaluation(
        account,
        "60",
        { isApproved: true, approvalRules: [rule(true)] },
        { lastActivity: older, observation: yield* repo.observe() },
        coordinates
      )
      expect(yield* repo.upsert(fullRead, full)).toEqual({ row: true, approval: false })
      expect(yield* repo.upsert(listed(t0, "older"), 0)).toEqual({ row: false, approval: false })
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
      expect((yield* repo.upsert(listed(t0, "older"), slow)).approval).toBe(false)
      expect(Option.map(yield* snapshot, (row) => row.approvalUnknownReason)).toEqual(Option.some("NotPermitted"))
      // A read that began after both still recovers it.
      expect((yield* repo.upsert(listed(t0, "newest"), yield* repo.observe())).approval).toBe(true)
      expect(Option.map(yield* snapshot, (row) => row.approvalUnknownReason)).toEqual(Option.some(null))
    })))

  it.effect("hands out strictly increasing observation numbers", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const numbers = yield* Effect.all([repo.observe(), repo.observe(), repo.observe()], { concurrency: 3 })
      expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3])
    })))

  // The tombstone holds a deletion: only a read begun after it, of a revision no older, brings it back.
  it.effect("re-inserts a deleted pull request only from a read begun after the deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const before = yield* repo.observe()
      yield* repo.deleteOne(account, "60", yield* repo.observe(), coordinates)
      yield* repo.upsert(listed(older, "older"), before)
      expect(Option.isNone(yield* snapshot)).toBe(true)
      yield* repo.upsert(listed(newest, "newest"), yield* repo.observe())
      expect(Option.map(yield* snapshot, (row) => row.title)).toEqual(Option.some("PR newest"))
    })))

  // Tombstones expire by when the deletion happened (the cache clock), not by the pull request's
  // provider activity, which can be years old.
  it.effect("keeps a tombstone of an old pull request through an expiry cutoff that precedes its deletion", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      const before = yield* repo.observe()
      yield* repo.deleteOne(account, "60", yield* repo.observe(), coordinates)
      yield* repo.deleteStale("2026-10-05T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"), before)
      expect(Option.isNone(yield* snapshot)).toBe(true)
      yield* repo.deleteStale("2999-01-01T00:00:00.000Z")
      yield* repo.upsert(listed(older, "older"), before)
      expect(Option.isSome(yield* snapshot)).toBe(true)
    })))

  // A not-found read carries no revision: its order is its observation. A listing that began before it
  // but read a newer revision must not bring the row back, in either completion order.
  it.effect.each([["the listing lands first", true], ["the deletion lands first", false]])(
    "keeps a pull request deleted by a later not-found read when an earlier listing saw a newer revision (%s)",
    ([, listingFirst]) =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* seed(repo)
        const listing = yield* repo.observe()
        const notFound = yield* repo.observe()
        const land = repo.upsert(listed(older, "older"), listing)
        const remove = repo.deleteOne(account, "60", notFound, coordinates)
        yield* listingFirst ? land.pipe(Effect.andThen(remove)) : remove.pipe(Effect.andThen(land))
        expect(Option.isNone(yield* snapshot)).toBe(true)
        yield* repo.upsert(listed(newest, "newest"), yield* repo.observe())
        expect(Option.isSome(yield* snapshot)).toBe(true)
      }))
  )

  it.effect("deletes a row from a not-found read that began after its last write, whatever revision it held", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* seed(repo)
      yield* repo.upsert(listed(newest, "newest"), yield* repo.observe())
      expect(yield* repo.deleteOne(account, "60", yield* repo.observe(), coordinates)).toBe(true)
      expect(Option.isNone(yield* snapshot)).toBe(true)
    })))
})
